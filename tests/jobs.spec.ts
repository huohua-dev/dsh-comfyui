import { describe, expect, it } from 'vitest'
import { ownerSessionOf, startGenerationJob } from '../src/jobs.js'
import { delay, fakeJobs } from './helpers.js'

describe('startGenerationJob (0.2 jobs contract)', () => {
  it('passes the session id as owner and settles the model text in `result`', async () => {
    const jobs = fakeJobs(['s-1'])
    const id = startGenerationJob(jobs, {
      label: 'H3',
      owner: 's-1',
      work: async (_signal, progress) => {
        progress('排队中')
        progress('排队中')
        progress('采样 3/8')
        return 'ComfyUI completed — 1 video(s)'
      },
      cancelRemote: async () => undefined,
    })
    const job = jobs.jobs.get(id)!
    expect(job.owner).toBe('s-1')
    const outcome = await job.settled
    expect(outcome).toEqual({ status: 'completed', result: 'ComfyUI completed — 1 video(s)' })
    // Unchanged lines are not re-sent.
    expect(job.progress).toEqual(['排队中', '采样 3/8'])
  })

  it('reads the owner from exec.agent.id, never the agent object', () => {
    expect(ownerSessionOf({ id: 'abc', session: {} })).toBe('abc')
    expect(ownerSessionOf(undefined)).toBeUndefined()
    expect(ownerSessionOf({})).toBeUndefined()
    // The 0.1-era call shape (owner: exec.agent) is what the registry rejects.
    const jobs = fakeJobs(['abc'])
    expect(() => jobs.start({ kind: 'comfyui', label: 'x', owner: { id: 'abc' } as unknown as string, run: () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' as const }) }) })).toThrow(/no live agent/)
  })

  it('kill aborts the wait, cancels only through cancelRemote once, and settles killed promptly', async () => {
    const jobs = fakeJobs()
    let remoteCancels = 0
    let sawAbort = false
    const id = startGenerationJob(jobs, {
      label: 'long video',
      work: (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true
          reject(new Error('aborted'))
        })
      }),
      cancelRemote: async () => { remoteCancels += 1 },
    })
    const started = Date.now()
    const outcome = await jobs.kill(id, 'user asked')
    jobs.jobs.get(id)!.cancel('again')
    expect(outcome.status).toBe('killed')
    expect(Date.now() - started).toBeLessThan(500)
    expect(sawAbort).toBe(true)
    expect(remoteCancels).toBe(1)
  })

  it('reports a failure with its message as detail and result', async () => {
    const jobs = fakeJobs()
    let failed: unknown
    const id = startGenerationJob(jobs, {
      label: 'x',
      work: async () => { await delay(1); throw new Error('ComfyUI execution failed: OOM') },
      cancelRemote: async () => undefined,
      onFailure: (error) => { failed = error },
    })
    const outcome = await jobs.jobs.get(id)!.settled
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('OOM')
    expect(outcome.result).toContain('OOM')
    expect(failed).toBeInstanceOf(Error)
  })
})
