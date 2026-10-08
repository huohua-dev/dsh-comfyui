/**
 * Queue tracking: remembers every prompt this plugin queued (from tools or
 * the panel) so the panel can show "ours" in the ComfyUI queue and move
 * completed runs into the asset index. Sweeps run on read (queue/assets
 * routes), so no background timers leak into the fiber lifecycle.
 */
import { ComfyUIClient, type ComfyUIHistoryEntry, type ComfyUIMediaItem } from './comfyui.js';
import type { AssetRecord, ComfyUIStore, TrackedState } from './store.js';
/** A prompt this plugin queued. Kept after completion so the task center
 * can still show its workflow name and "ours" marker. */
export interface QueuedRun {
    promptId: string;
    ts: string;
    workflowName: string | null;
    source: string;
}
/** Tracks queued prompts until they complete or vanish. */
export declare class QueueTracker {
    private readonly persisted?;
    private readonly runs;
    /** Prompt ids already swept into the asset index, so sweep is idempotent. */
    private readonly archived;
    /**
     * Optional durable backing: the tracked memory is persisted so completed
     * runs still land in the asset index after a web-server restart.
     */
    constructor(persisted?: {
        load(): Promise<TrackedState>;
        save(state: TrackedState): Promise<void>;
    } | undefined);
    /** Restore persisted runs/archived state; call once before tracking. */
    init(): Promise<void>;
    /** Fire-and-forget persistence; failures must not break queueing. */
    private persistNow;
    track(run: QueuedRun): void;
    untrack(promptId: string): void;
    get(promptId: string): QueuedRun | undefined;
    list(): QueuedRun[];
    /**
     * Move completed tracked runs into the asset store. Runs already archived
     * are skipped; failed runs stay tracked so their task rows keep a name.
     * @returns the records newly appended.
     */
    sweep(opts: {
        client: ComfyUIClient;
        store: ComfyUIStore;
        /** The runtime's completion path: collects the media and archives it locally. */
        complete(promptId: string, entry: ComfyUIHistoryEntry): Promise<ComfyUIMediaItem[]>;
    }): Promise<AssetRecord[]>;
}
