/** Local archive: meta at submit, download on completion, offline playback. */
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localNameOf, parseRange, seedsOf, type RunMeta } from '../src/archive.js'
import { startFakeComfy, type FakeComfy } from './fake-comfy.js'
import { bootPlugin, type FakeHost } from './fake-host.js'
import { delay } from './helpers.js'

describe('archive helpers', () => {
  it('names local files <node>-<index>-<sanitized original>', () => {
    expect(localNameOf({ node: '14', index: 0, filename: 'dsh-h3_00001_.mp4' })).toBe('14-0-dsh-h3_00001_.mp4')
    expect(localNameOf({ node: '14', index: 1, filename: '../../etc/passwd' })).toBe('14-1-passwd')
    expect(localNameOf({ node: '9', index: 0, filename: '..\\\\evil 名字.mp4' })).toBe('9-0-evil___.mp4')
  })

  it('parses single byte ranges like a static server', () => {
    expect(parseRange(undefined, 100)).toBeUndefined()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=9-3', 100)).toBe('unsatisfiable')
    expect(parseRange('items=0-1', 100)).toBeUndefined()
  })

  it('finds every seed-like input', () => {
    expect(seedsOf({ '6': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } }, '3': { class_type: 'KSampler', inputs: { seed: 7, steps: 20 } } }))
      .toEqual(expect.arrayContaining([{ nodeId: '6', classType: 'RandomNoise', inputKey: 'noise_seed', value: 42 }, { nodeId: '3', classType: 'KSampler', inputKey: 'seed', value: 7 }]))
  })
})

describe('archive through the plugin', () => {
  let comfy: FakeComfy
  let host: FakeHost
  let archiveDir: string
  const VIDEO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))

  beforeEach(async () => {
    comfy = await startFakeComfy()
    archiveDir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-archive-'))
    host = await bootPlugin({ baseUrl: comfy.url, pollIntervalMs: 50, archiveDir })
  })
  afterEach(async () => {
    await host.dispose()
    await comfy.close().catch(() => undefined)
  })

  async function runH3(): Promise<{ promptId: string; result: string }> {
    const value = await host.call('comfyui_run', { template: 'h3_t2v', parameters: { prompt: '雨中的灯塔', seconds: 3 }, mode: 'async' }) as { jobId: string; promptId: string }
    await delay(30)
    const meta = JSON.parse(await readFile(join(archiveDir, value.promptId, 'meta.json'), 'utf8')) as RunMeta
    // Recorded at submit time, before ComfyUI finished anything.
    expect(meta.status).toBe('submitted')
    comfy.startNext()
    comfy.finishRunning(VIDEO)
    const outcome = await host.jobs.jobs.get(value.jobId)!.settled
    expect(outcome.status).toBe('completed')
    return { promptId: value.promptId, result: outcome.result ?? '' }
  }

  it('downloads the video next to a complete meta.json', async () => {
    const { promptId, result } = await runH3()
    const dir = join(archiveDir, promptId)
    expect((await readdir(dir)).sort()).toEqual(['14-0-dsh_00001_.mp4', 'meta.json'])
    expect(await readFile(join(dir, '14-0-dsh_00001_.mp4'))).toEqual(VIDEO)
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as RunMeta
    expect(meta).toMatchObject({ promptId, status: 'completed', baseUrl: comfy.url })
    expect(meta.workflow['5']!.inputs).toMatchObject({ prompt: '雨中的灯塔', length: 73 })
    expect(meta.values).toMatchObject({ prompt: '雨中的灯塔', seconds: 3, width: 864, height: 480, steps: 8 })
    expect(meta.seeds).toEqual([{ nodeId: '6', classType: 'RandomNoise', inputKey: 'noise_seed', value: meta.values.seed }])
    expect(meta.parameters?.map((param) => param.name)).toContain('seconds')
    expect(meta.files[0]).toMatchObject({ name: '14-0-dsh_00001_.mp4', bytes: VIDEO.length, kind: 'video' })
    expect(meta.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result).toContain(`/comfyui/archive/${promptId}/14-0-dsh_00001_.mp4`)
    expect(result).toContain(join(dir, '14-0-dsh_00001_.mp4'))
  })

  it('keeps playing from the archive after ComfyUI goes away (jobs/media, archive route with Range, old proxy URLs)', async () => {
    const { promptId } = await runH3()
    await comfy.close()

    const jobs = await (await host.fetch(`/comfyui/jobs/media?promptId=${promptId}`)).json() as { status: string; source: string; media: Array<{ url: string; proxyUrl: string; kind: string }> }
    expect(jobs).toMatchObject({ status: 'completed', source: 'archive' })
    const item = jobs.media[0]!
    expect(item.url).toBe(`/comfyui/archive/${promptId}/14-0-dsh_00001_.mp4`)

    const whole = await host.fetch(item.url)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/mp4')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(VIDEO)

    const part = await host.fetch(item.url, { headers: { range: 'bytes=100-199' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 100-199/${VIDEO.length}`)
    expect(Buffer.from(await part.arrayBuffer())).toEqual(VIDEO.subarray(100, 200))

    const tail = await host.fetch(item.url, { headers: { range: 'bytes=999999-' } })
    expect(tail.status).toBe(416)

    // A pre-archive style /comfyui/media URL resolves to the local copy too.
    const proxied = await host.fetch(item.proxyUrl, { headers: { range: 'bytes=0-9' } })
    expect(proxied.status).toBe(206)
    expect(Buffer.from(await proxied.arrayBuffer())).toEqual(VIDEO.subarray(0, 10))
    const legacy = await host.fetch(`/comfyui/media?prompt=${promptId}&node=14&index=0`, { method: 'HEAD' })
    expect(legacy.status).toBe(200)
    expect(legacy.headers.get('content-length')).toBe(String(VIDEO.length))
  })

  it('downloads once even when the job and a card poll complete concurrently', async () => {
    const value = await host.call('comfyui_run', { template: 'h3_t2v', parameters: { prompt: 'x' }, mode: 'async' }) as { jobId: string; promptId: string }
    await delay(20)
    comfy.startNext()
    comfy.finishRunning(VIDEO)
    const [poll] = await Promise.all([
      host.fetch(`/comfyui/jobs/media?promptId=${value.promptId}`).then((response) => response.json() as Promise<{ status: string }>),
      host.jobs.jobs.get(value.jobId)!.settled,
    ])
    expect(poll.status).toBe('completed')
    expect(comfy.log.filter((entry) => entry.path.startsWith('/view')).length).toBe(1)
    expect((await stat(join(archiveDir, value.promptId, '14-0-dsh_00001_.mp4'))).size).toBe(VIDEO.length)
  })

  it('saves a run as a library workflow from its archived record (exact parameters, seconds=3)', async () => {
    const { promptId } = await runH3()
    await comfy.close()
    const saved = await host.call('comfyui_workflow', { action: 'save', prompt_id: promptId, name: '灯塔' }) as { parameterSummary: string }
    expect(saved.parameterSummary).toContain('seconds=3')
    expect(saved.parameterSummary).toContain('seed=随机')
  })

  it('records a failed run in meta.json', async () => {
    const value = await host.call('comfyui_run', { template: 'h3_t2v', parameters: { prompt: 'x' }, mode: 'async', timeout_ms: 5_000 }) as { jobId: string; promptId: string }
    comfy.history.set(value.promptId, { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] }, outputs: {} })
    comfy.pending.length = 0
    const outcome = await host.jobs.jobs.get(value.jobId)!.settled
    expect(outcome.status).toBe('failed')
    const meta = JSON.parse(await readFile(join(archiveDir, value.promptId, 'meta.json'), 'utf8')) as RunMeta
    expect(meta.status).toBe('failed')
    expect(meta.error).toContain('CUDA out of memory')
  })
})
