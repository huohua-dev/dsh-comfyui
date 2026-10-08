/**
 * comfyui_run / comfyui_workflow in `mode: "async"` against the 0.2 jobs
 * contract, end to end through the real plugin apply() and a fake ComfyUI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeComfy, type FakeComfy } from './fake-comfy.js'
import { bootPlugin, type FakeHost } from './fake-host.js'
import { delay } from './helpers.js'

const WORKFLOW = {
  '1': { class_type: 'EmptyImage', inputs: { width: 64, height: 64 } },
  '14': { class_type: 'SaveVideo', inputs: { video: ['1', 0], filename_prefix: 'video/dsh' } },
}

let comfy: FakeComfy
let host: FakeHost

beforeEach(async () => {
  comfy = await startFakeComfy()
  host = await bootPlugin({ baseUrl: comfy.url, pollIntervalMs: 200 })
})

afterEach(async () => {
  await host.dispose()
  await comfy.close()
})

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await delay(20)
  }
}

describe('async generation job', () => {
  it('registers the four tools', () => {
    expect([...host.tools.keys()].sort()).toEqual(['comfyui_object_info', 'comfyui_run', 'comfyui_skill', 'comfyui_workflow'])
  })

  it('starts an owned job, reports progress, and settles with the media in result', async () => {
    const value = await host.call('comfyui_run', { workflow: WORKFLOW, mode: 'async' }) as { kind: string; jobId: string; promptId: string }
    expect(value.kind).toBe('background')
    const job = host.jobs.jobs.get(value.jobId)!
    expect(job.owner).toBe('session-1')
    await until(() => job.progress.some((line) => line.startsWith('排队中')))
    comfy.startNext()
    await until(() => job.progress.some((line) => line.startsWith('运行中')))
    comfy.finishRunning()
    const outcome = await job.settled
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toContain(`prompt ${value.promptId}`)
    expect(outcome.result).toContain('1 video(s)')
    const text = host.tools.get('comfyui_run')!.output.render({}, value)[0]!.text
    expect(text).toContain('job_kill')
  })

  it('job_kill settles killed without waiting for the generation timeout', async () => {
    const value = await host.call('comfyui_run', { workflow: WORKFLOW, mode: 'async' }) as { jobId: string }
    comfy.startNext()
    const started = Date.now()
    const outcome = await host.jobs.kill(value.jobId, 'stop')
    expect(outcome.status).toBe('killed')
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
