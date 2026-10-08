/**
 * Cancelling touches only our own prompt: pending → dequeued, running →
 * interrupted by id, never an id-less /interrupt.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ComfyUIClient } from '../src/comfyui.js'
import type { RunMeta } from '../src/archive.js'
import { startFakeComfy, type FakeComfy } from './fake-comfy.js'
import { bootPlugin, type FakeHost } from './fake-host.js'
import { delay } from './helpers.js'

let comfy: FakeComfy
let host: FakeHost

beforeEach(async () => {
  comfy = await startFakeComfy()
  host = await bootPlugin({ baseUrl: comfy.url, pollIntervalMs: 50 })
})
afterEach(async () => {
  await host.dispose()
  await comfy.close()
})

async function queueTwo(): Promise<Array<{ jobId: string; promptId: string }>> {
  const first = await host.call('comfyui_run', { template: 'h3_t2v', parameters: { prompt: 'first' }, mode: 'async' }) as { jobId: string; promptId: string }
  const second = await host.call('comfyui_run', { template: 'h3_t2v', parameters: { prompt: 'second' }, mode: 'async' }) as { jobId: string; promptId: string }
  comfy.startNext() // first is running, second waits
  await delay(30)
  return [first, second]
}

/** Control calls only: ignore polling. */
function controlCalls(): Array<{ path: string; body?: unknown }> {
  return comfy.log.filter((entry) => entry.method === 'POST' && entry.path !== '/prompt').map(({ path, body }) => ({ path, ...(body !== undefined ? { body } : {}) }))
}

function noGlobalInterrupt(): void {
  for (const call of controlCalls()) {
    if (call.path === '/interrupt') expect((call.body as { prompt_id?: string } | undefined)?.prompt_id).toBeTruthy()
  }
}

describe('job_kill on a queued job (v0.39 /api/jobs cancel)', () => {
  it('dequeues the second job and leaves the running first job alone', async () => {
    const [first, second] = await queueTwo()
    comfy.log.length = 0
    const outcome = await host.jobs.kill(second!.jobId)
    expect(outcome.status).toBe('killed')
    expect(controlCalls()).toEqual([{ path: `/api/jobs/${second!.promptId}/cancel`, body: {} }])
    expect(comfy.pending.map((p) => p.id)).toEqual([])
    expect(comfy.running.map((p) => p.id)).toEqual([first!.promptId])
    expect(comfy.interrupted).toEqual([])

    comfy.finishRunning()
    const firstOutcome = await host.jobs.jobs.get(first!.jobId)!.settled
    expect(firstOutcome.status).toBe('completed')
    const meta = JSON.parse(await readFile(join(host.dataDir, 'archive', second!.promptId, 'meta.json'), 'utf8')) as RunMeta
    expect(meta.status).toBe('cancelled')
  })

  it('interrupts the running job by id only', async () => {
    const [first, second] = await queueTwo()
    comfy.log.length = 0
    await host.jobs.kill(first!.jobId)
    expect(comfy.interrupted).toEqual([first!.promptId])
    expect(comfy.pending.map((p) => p.id)).toEqual([second!.promptId])
    noGlobalInterrupt()
    await host.jobs.kill(second!.jobId)
  })
})

describe('older servers without /api/jobs/{id}/cancel', () => {
  it('falls back to /queue delete for pending and /interrupt {prompt_id} for running', async () => {
    comfy.jobsCancelRoute = false
    const [first, second] = await queueTwo()
    comfy.log.length = 0
    await host.jobs.kill(second!.jobId)
    expect(controlCalls()).toEqual([
      { path: `/api/jobs/${second!.promptId}/cancel`, body: {} },
      { path: '/queue', body: { delete: [second!.promptId] } },
    ])
    expect(comfy.running.map((p) => p.id)).toEqual([first!.promptId])

    comfy.log.length = 0
    await host.jobs.kill(first!.jobId)
    expect(controlCalls()).toContainEqual({ path: '/interrupt', body: { prompt_id: first!.promptId } })
    expect(comfy.interrupted).toEqual([first!.promptId])
    noGlobalInterrupt()
  })

  it('is a no-op for a prompt that already finished', async () => {
    comfy.jobsCancelRoute = false
    const client = new ComfyUIClient(comfy.url, undefined, 5_000, 1_000_000)
    expect(await client.cancelOwn('00000000-0000-4000-8000-000000000000')).toEqual({ cancelled: false, via: 'none' })
    expect(controlCalls().some((call) => call.path === '/interrupt')).toBe(false)
  })
})

describe('other cancel paths', () => {
  it('a sync run aborted by the agent cancels only its own prompt', async () => {
    const other = await host.call('comfyui_run', { template: 'h3_t2v', parameters: { prompt: 'someone else' }, mode: 'async' }) as { jobId: string; promptId: string }
    comfy.startNext()
    const controller = new AbortController()
    const run = host.call('comfyui_run', { template: 'h3_t2v', parameters: { prompt: 'mine' } }, controller.signal) as Promise<{ status: string; promptId: string }>
    await delay(80)
    controller.abort()
    const result = await run
    expect(result.status).toBe('interrupted')
    expect(comfy.running.map((p) => p.id)).toEqual([other.promptId])
    expect(comfy.interrupted).toEqual([])
    noGlobalInterrupt()
    await host.jobs.kill(other.jobId)
  })

  it('the panel interrupt action requires a prompt id', async () => {
    const res = await host.fetch('/comfyui/jobs/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'interrupt' }) })
    expect(res.status).toBe(400)
    noGlobalInterrupt()
  })
})
