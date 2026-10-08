/**
 * Live generation progress, fed by ComfyUI's WebSocket. The server broadcasts
 * `progress` events ({value, max, node, prompt_id}) to every connected client,
 * so one shared socket tracks progress for all queue tasks — including ones
 * the plugin did not submit. Progress is best-effort: a remote server behind
 * an authenticating proxy (or one that never connects) simply shows queue
 * tasks without a progress bar. Reconnects on drop until dispose.
 */
export interface RunProgress {
    value: number;
    max: number;
    /** Node id the event came from (ComfyUI sends it as a string). */
    node: string | null;
}
export declare class ProgressTracker {
    private readonly progress;
    private socket;
    private retryTimer;
    private stopped;
    /** Current progress for one prompt, if the server reported any. */
    get(promptId: string): RunProgress | undefined;
    /** Start listening on the server's /ws endpoint. Idempotent per url. */
    attach(wsUrl: string): void;
    private connect;
    private onMessage;
    private scheduleRetry;
    dispose(): void;
}
