/** Test doubles for the DSH 0.2 host services the plugin talks to. */
import type { JobHandle, JobOutcome, JobsService } from '../src/jobs.js'

interface FakeJob {
  id: string
  owner?: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  progress: string[]
  outcome?: JobOutcome
  cancel(reason?: string): void
  settled: Promise<JobOutcome>
}

/**
 * A jobs registry with the 0.2 dsh-jobs-local producer contract: `owner` is a
 * live session id string (an object throws like `agents.get()` would), the
 * result is read from `outcome.result`, and `kill` calls `cancel` then waits
 * for `done`.
 */
export function fakeJobs(liveSessions: string[] = ['session-1']): JobsService & {
  jobs: Map<string, FakeJob>
  kill(id: string, reason?: string): Promise<JobOutcome>
} {
  const jobs = new Map<string, FakeJob>()
  let counter = 0
  return {
    jobs,
    start(spec) {
      if (spec.owner !== undefined) {
        if (typeof spec.owner !== 'string' || !liveSessions.includes(spec.owner)) {
          throw new Error(`session "${String(spec.owner)}" has no live agent (background job owner must be live)`)
        }
      }
      if (spec.label.length === 0) throw new Error('invalid job label: expected a non-empty string')
      counter += 1
      const id = `${spec.kind}-${counter}`
      const progress: string[] = []
      const handle: JobHandle = { id, updateProgress: (line) => { progress.push(line) } }
      const hooks = spec.run(handle)
      const job: FakeJob = {
        id,
        label: spec.label,
        status: 'running',
        progress,
        cancel: hooks.cancel.bind(hooks),
        settled: hooks.done.then((outcome) => {
          job.status = outcome.status
          job.outcome = outcome
          return outcome
        }),
      }
      if (spec.owner !== undefined) job.owner = spec.owner
      jobs.set(id, job)
      return id
    },
    async kill(id, reason) {
      const job = jobs.get(id)
      if (job === undefined) throw new Error(`unknown job ${id}`)
      job.cancel(reason)
      job.status = 'stopping'
      return job.settled
    },
  }
}

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
