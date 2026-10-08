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
/** The slice of the 0.2 job handle a producer receives in `run(handle)`. */
export interface JobHandle {
    readonly id?: string;
    append?(text: string): void;
    updateProgress?(line: string): void;
}
/** What a producer reports when it settles. */
export interface JobOutcome {
    status: 'completed' | 'killed' | 'failed';
    detail?: string;
    result?: string;
}
/** The slice of the 0.2 jobs registry this plugin uses. */
export interface JobsService {
    start(spec: {
        kind: string;
        label: string;
        owner?: string;
        run(handle: JobHandle): {
            cancel(reason?: string): void;
            done: Promise<JobOutcome>;
        };
    }): string;
}
/** Owner session id of a tool execution (0.2: `exec.agent.id`), if any. */
export declare function ownerSessionOf(agent: unknown): string | undefined;
/** Thrown into the work function's signal when the job is killed. */
export declare class JobCancelledError extends Error {
    constructor(reason?: string);
}
/**
 * Start one background generation job.
 *
 * `work` does the waiting (and archiving) and returns the model-facing result
 * text; it must honor `signal`. `cancelRemote` stops *this* prompt on the
 * server (never a global interrupt) and runs once, on the first cancel. A
 * cancelled job always settles `killed`, whatever `work` does afterwards.
 */
export declare function startGenerationJob(jobs: JobsService, opts: {
    kind?: string;
    label: string;
    owner?: string;
    work(signal: AbortSignal, progress: (line: string) => void): Promise<string>;
    cancelRemote(): Promise<void>;
    onFailure?(error: unknown): void;
}): string;
