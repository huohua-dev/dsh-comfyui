/**
 * Real-machine end-to-end run against a live ComfyUI with the H3 models.
 * Skipped unless REAL_COMFY is set, e.g.
 *   REAL_COMFY=http://<comfyui-host>:8188 REAL_DATA=/tmp/dsh-comfyui-e2e npx vitest run tests/real.e2e.spec.ts
 * It submits real GPU work (≈ 3–4 minutes in total).
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RunMeta } from '../src/archive.js'
import { bootPlugin, type FakeHost } from './fake-host.js'
import { delay } from './helpers.js'

const BASE = process.env.REAL_COMFY
const DATA = process.env.REAL_DATA ?? '/tmp/dsh-comfyui-e2e'

async function comfyQueue(): Promise<{ running: string[]; pending: string[] }> {
  const raw = await (await fetch(`${BASE}/queue`)).json() as { queue_running: unknown[][]; queue_pending: unknown[][] }
  return { running: raw.queue_running.map((row) => String(row[1])), pending: raw.queue_pending.map((row) => String(row[1])) }
}

describe.skipIf(BASE === undefined)('live ComfyUI (H3)', () => {
  let host: FakeHost
  const report: Record<string, unknown> = {}

  beforeAll(async () => {
    host = await bootPlugin({ baseUrl: BASE, dataDir: DATA, pollIntervalMs: 1_000 })
    const idle = await comfyQueue()
    expect(idle.running.length + idle.pending.length).toBe(0)
  })
  afterAll(async () => {
    await host?.dispose()
    console.log(JSON.stringify(report, null, 2))
  })

  let firstPrompt = ''

  it('generates a 480p 3 s H3 video in the background and archives it locally', async () => {
    const started = Date.now()
    const value = await host.call('comfyui_run', {
      template: 'h3_t2v',
      parameters: { prompt: '黄昏的海边，一只橘猫坐在礁石上看浪花，海浪声和海鸥叫声', width: 864, height: 480, seconds: 3 },
      mode: 'async',
    }) as { jobId: string; promptId: string }
    const job = host.jobs.jobs.get(value.jobId)!
    const outcome = await job.settled
    report.run1 = { promptId: value.promptId, seconds: (Date.now() - started) / 1000, status: outcome.status, progress: job.progress }
    expect(outcome.status).toBe('completed')
    expect(job.progress.some((line) => /采样 \d+\/8/.test(line))).toBe(true)
    const meta = JSON.parse(await readFile(join(DATA, 'archive', value.promptId, 'meta.json'), 'utf8')) as RunMeta
    expect(meta.status).toBe('completed')
    expect(meta.workflow['5']!.inputs.length).toBe(73)
    const file = meta.files.find((entry) => entry.kind === 'video')!
    const local = join(DATA, 'archive', value.promptId, file.name)
    const head = (await readFile(local)).subarray(4, 8).toString('latin1')
    expect(head).toBe('ftyp')
    expect((await stat(local)).size).toBe(file.bytes)
    report.run1File = { path: local, bytes: file.bytes, seed: meta.values.seed }
    firstPrompt = value.promptId

    const part = await host.fetch(`/comfyui/archive/${value.promptId}/${file.name}`, { headers: { range: 'bytes=0-1023' } })
    expect(part.status).toBe(206)
  }, 600_000)

  it('saves that run as a template and reruns it with one parameter changed', async () => {
    const saved = await host.call('comfyui_workflow', { action: 'save', prompt_id: firstPrompt, name: 'e2e 海边橘猫', description: 'H3 海边橘猫 e2e' }) as { id: string; parameterSummary: string }
    expect(saved.parameterSummary).toContain('seconds=3')
    const started = Date.now()
    const run = await host.call('comfyui_workflow', { action: 'run', id: saved.id, parameters: { seconds: 2 }, mode: 'async' }) as { background: { jobId: string; promptId: string } }
    const outcome = await host.jobs.jobs.get(run.background.jobId)!.settled
    expect(outcome.status).toBe('completed')
    const meta = JSON.parse(await readFile(join(DATA, 'archive', run.background.promptId, 'meta.json'), 'utf8')) as RunMeta
    expect(meta.workflow['5']!.inputs.length).toBe(56)
    expect(meta.workflow['5']!.inputs.prompt).toContain('橘猫')
    report.run2 = { workflowId: saved.id, promptId: run.background.promptId, seconds: (Date.now() - started) / 1000, frames: 56, file: meta.files[0]?.name, seed: meta.values.seed }
  }, 600_000)

  it('cancels only the second of two queued jobs; the first still completes', async () => {
    const small = { prompt: '雨中的霓虹街道，脚步声', width: 512, height: 288, seconds: 1 }
    const first = await host.call('comfyui_run', { template: 'h3_t2v', parameters: small, mode: 'async' }) as { jobId: string; promptId: string }
    const second = await host.call('comfyui_run', { template: 'h3_t2v', parameters: { ...small, prompt: '第二个任务' }, mode: 'async' }) as { jobId: string; promptId: string }
    // Wait until the first is running and the second is pending.
    for (let i = 0; i < 60; i += 1) {
      const queue = await comfyQueue()
      if (queue.running.includes(first.promptId) && queue.pending.includes(second.promptId)) break
      await delay(500)
    }
    const before = await comfyQueue()
    expect(before.running).toEqual([first.promptId])
    expect(before.pending).toContain(second.promptId)

    const killed = await host.jobs.kill(second.jobId, 'e2e cancel second')
    expect(killed.status).toBe('killed')
    const after = await comfyQueue()
    expect(after.pending).not.toContain(second.promptId)
    expect(after.running).toEqual([first.promptId])

    const firstOutcome = await host.jobs.jobs.get(first.jobId)!.settled
    expect(firstOutcome.status).toBe('completed')
    const job2 = await (await fetch(`${BASE}/api/jobs/${second.promptId}`)).json().catch(() => ({})) as { status?: string }
    const job1 = await (await fetch(`${BASE}/api/jobs/${first.promptId}`)).json() as { status?: string }
    report.cancel = { first: first.promptId, firstStatus: job1.status, second: second.promptId, secondServerStatus: job2.status ?? 'absent' }
    expect(job1.status).toBe('completed')
  }, 600_000)
})
