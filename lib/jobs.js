/**
 * Background generation jobs on the DSH 0.2 jobs registry (`ctx.jobs`,
 * @deepseek-ai/dsh-jobs-local).
 *
 * The 0.2 producer contract differs from the 0.1 one this plugin was written
 * against in three ways that each broke `mode: "async"`:
 *
 * - `owner` is the owning session id (`exec.agent.id`), resolved by the
 *   registry through the agent registry. Passing the Agent object itself
 *   throws `session "[object Object]" has no live agent`.
 * - The model-visible result rides `outcome.result` (delivered once by
 *   `job_output` after settlement); an `output` field is silently dropped.
 * - `job_kill` calls `cancel()` and then waits for `done` to settle. A cancel
 *   that only fires a server interrupt but leaves the history poll running
 *   keeps the job "stopping" until the generation timeout.
 *
 * Progress goes through `handle.updateProgress(line)`: the jobs panel shows
 * the latest line next to the job status. Lines are only pushed when they
 * change, because every update is an event to every subscriber.
 */
/** Owner session id of a tool execution (0.2: `exec.agent.id`), if any. */
export function ownerSessionOf(agent) {
    if (typeof agent !== 'object' || agent === null)
        return undefined;
    const id = agent.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
}
/** Thrown into the work function's signal when the job is killed. */
export class JobCancelledError extends Error {
    constructor(reason) {
        super(reason !== undefined && reason !== '' ? `cancelled: ${reason}` : 'cancelled');
        this.name = 'JobCancelledError';
    }
}
/**
 * Start one background generation job.
 *
 * `work` does the waiting (and archiving) and returns the model-facing result
 * text; it must honor `signal`. `cancelRemote` stops *this* prompt on the
 * server (never a global interrupt) and runs once, on the first cancel. A
 * cancelled job always settles `killed`, whatever `work` does afterwards.
 */
export function startGenerationJob(jobs, opts) {
    return jobs.start({
        kind: opts.kind ?? 'comfyui',
        label: opts.label !== '' ? opts.label : 'comfyui',
        ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
        run: (handle) => {
            const controller = new AbortController();
            let lastLine;
            let cancelled = false;
            let markKilled = () => { };
            // Settles the job the moment it is killed, even if `work` is still
            // inside a slow request: job_kill must not hang on the network.
            const killed = new Promise((resolve) => { markKilled = resolve; });
            const progress = (line) => {
                if (cancelled || line === lastLine)
                    return;
                lastLine = line;
                try {
                    handle.updateProgress?.(line);
                }
                catch {
                    // A progress update racing settlement is dropped by the registry; never fail the job for it.
                }
            };
            const finished = (async () => {
                try {
                    const result = await opts.work(controller.signal, progress);
                    if (cancelled)
                        return { status: 'killed' };
                    return { status: 'completed', result };
                }
                catch (error) {
                    if (cancelled)
                        return { status: 'killed' };
                    opts.onFailure?.(error);
                    const message = error instanceof Error ? error.message : String(error);
                    return { status: 'failed', detail: message.slice(0, 300), result: message };
                }
            })();
            const done = Promise.race([finished, killed]);
            return {
                cancel: (reason) => {
                    if (cancelled)
                        return;
                    cancelled = true;
                    controller.abort(new JobCancelledError(reason));
                    void opts.cancelRemote().catch(() => undefined).finally(() => markKilled({ status: 'killed' }));
                },
                done,
            };
        },
    });
}
