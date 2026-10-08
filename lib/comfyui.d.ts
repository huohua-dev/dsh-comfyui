/** One media file produced by a workflow output node. */
export interface ComfyUIMediaRef {
    filename: string;
    subfolder: string;
    type: string;
}
/** A media item with its locating information and proxy URL. */
export interface ComfyUIMediaItem extends ComfyUIMediaRef {
    /** Output node id that produced the item. */
    node: string;
    /** Index within the node's media collection. */
    index: number;
    kind: 'image' | 'video' | 'audio' | 'other';
    /** Same-origin proxy URL (web profile) or a descriptive placeholder. */
    url: string;
}
/** One entry of the ComfyUI /history map. */
export interface ComfyUIHistoryEntry {
    prompt?: unknown;
    outputs?: Record<string, {
        images?: ComfyUIMediaRef[];
        videos?: ComfyUIMediaRef[];
        gifs?: ComfyUIMediaRef[];
        audio?: ComfyUIMediaRef[];
    }>;
    status?: {
        status_str?: string;
        completed?: boolean;
        messages?: unknown[];
    };
}
/** One entry of ComfyUI's /queue: server-side generation tasks. */
export interface ComfyUIQueueItem {
    number: number;
    prompt_id: string;
}
/** ComfyUI /queue response: the server-side generation queue. */
export interface ComfyUIQueueView {
    queue_running: ComfyUIQueueItem[];
    queue_pending: ComfyUIQueueItem[];
}
/** A unified job from ComfyUI /api/jobs (running + pending + history). */
export interface ComfyUIJob {
    id: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
    priority: number;
    create_time: number | null;
    execution_start_time?: number | null;
    execution_end_time?: number | null;
    execution_error?: {
        message?: string;
        exception_message?: string;
        node_type?: string;
    } | null;
    outputs_count: number;
    previewable_outputs_count: number;
    preview_output?: {
        filename?: string;
        subfolder?: string;
        type?: string;
        mediaType?: string;
    } | null;
    workflow_id?: string | null;
    outputs?: Record<string, unknown>;
    workflow?: {
        prompt: unknown;
        extra_data?: Record<string, unknown>;
    };
}
/** /api/jobs list response. */
export interface ComfyUIJobsResponse {
    jobs: ComfyUIJob[];
    pagination: {
        offset: number;
        limit: number | null;
        total: number;
        has_more: boolean;
    };
}
/** One entry of a user-data directory listing (/v2/userdata). */
export interface ComfyUIUserDataEntry {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
}
/**
 * The raw response of a streamed /view download, ready for a proxy to
 * re-emit status/headers and pipe the body through unchanged.
 */
export interface ComfyViewStream {
    status: number;
    headers: globalThis.Headers;
    body: globalThis.ReadableStream<Uint8Array> | null;
}
/** Failure talking to the ComfyUI server. */
export declare class ComfyUIError extends Error {
    readonly status?: number | undefined;
    readonly code?: "unreachable" | undefined;
    constructor(message: string, status?: number | undefined, code?: "unreachable" | undefined);
}
export declare function guessContentType(filename: string): string;
/** The per-process client id ComfyUI uses to correlate queued prompts. */
export declare const CLIENT_ID: `${string}-${string}-${string}-${string}-${string}`;
/** HTTP client over the ComfyUI REST API. */
export declare class ComfyUIClient {
    private readonly baseUrl;
    private readonly apiKey;
    private readonly connectTimeoutMs;
    private readonly maxMediaBytes;
    /** Appended to "cannot reach ComfyUI" errors (configurable, e.g. how to bring the server up). */
    private readonly unreachableHint;
    constructor(baseUrl: string, apiKey: string | undefined, connectTimeoutMs: number, maxMediaBytes: number, 
    /** Appended to "cannot reach ComfyUI" errors (configurable, e.g. how to bring the server up). */
    unreachableHint?: string);
    /**
     * fetch() that turns network-level failures (refused, unreachable, our own
     * timeout) into one actionable error naming the server and the configured
     * hint. HTTP error statuses pass through untouched — the server answered.
     */
    private reach;
    private unreachable;
    private base;
    private endpoint;
    /** fetch() one route, retrying a 404 under /api until the prefix is known. */
    private fetchRoute;
    private request;
    /** Best-effort GET of an arbitrary JSON endpoint on the ComfyUI server.
     *
     * Used to force TTS-Audio-Suite's voice-library rescan, a custom-node API
     * route that is not part of the core API. Resolves true when the request
     * succeeds, false on any failure (404 on servers without the route, auth,
     * network). The response body is discarded. */
    getOk(path: string, timeoutMs?: number): Promise<boolean>;
    /** Upload a file (multipart body forwarded verbatim) into ComfyUI's input directory. */
    /** Forward a multipart/form-data upload body verbatim (the browser's own
     * form, field "image", as ComfyUI's /upload/image expects it). */
    uploadFile(body: Uint8Array, contentType: string): Promise<{
        name?: string;
        subfolder?: string;
        type?: string;
    }>;
    /**
     * Put one file into ComfyUI's input directory (images, video, audio alike).
     *
     * /upload/image only accepts multipart/form-data: posting the bytes as a
     * raw body with their own content-type answers HTTP 400, which is why
     * picking a generated file into the load area used to fail instead of
     * copying it. The form is built here so callers can pass plain bytes.
     * `overwrite` keeps a repeated pick from piling up "name (1).png" copies.
     */
    uploadMedia(bytes: Uint8Array, filename: string, contentType: string, opts?: {
        overwrite?: boolean;
        subfolder?: string;
        timeoutMs?: number;
    }): Promise<{
        name?: string;
        subfolder?: string;
        type?: string;
    }>;
    /** Queue one API-format workflow and return its prompt id. */
    queuePrompt(workflow: unknown, options?: {
        promptId?: string;
        front?: boolean;
        extraData?: Record<string, unknown>;
    }): Promise<string>;
    /** Read one prompt's history entry; undefined while the prompt is unknown or evicted. */
    getHistory(promptId: string): Promise<ComfyUIHistoryEntry | undefined>;
    /** The server-side queue: running + pending prompts. */
    getQueue(): Promise<ComfyUIQueueView>;
    /** Unified job list with status filters, sorting, and pagination. */
    getJobs(options?: {
        status?: Array<ComfyUIJob['status']>;
        limit?: number;
        offset?: number;
        sortBy?: 'created_at' | 'execution_duration';
        sortOrder?: 'asc' | 'desc';
    }): Promise<ComfyUIJobsResponse>;
    /** One job by id, including its workflow prompt and outputs. */
    getJob(jobId: string): Promise<ComfyUIJob | undefined>;
    /** Remove specific prompts from the pending queue. */
    deleteQueueItems(promptIds: string[]): Promise<void>;
    /** Clear the entire pending queue (running job is unaffected). */
    clearQueue(): Promise<void>;
    /**
     * Interrupt one prompt if it is the one running. Never called without an id:
     * an id-less /interrupt stops whatever is running, i.e. someone else's job.
     * v0.39 checks the id against the running prompt first, but the check and
     * the interrupt are not atomic — prefer cancelOwn(), which uses the atomic
     * /api/jobs/{id}/cancel when the server has it.
     */
    interruptPrompt(promptId: string): Promise<void>;
    /**
     * Cancel exactly one prompt and nothing else.
     *
     * ComfyUI ≥ 0.39 has POST /api/jobs/{id}/cancel: a running job is stopped
     * through `interrupt_if_running(id)` (atomic — it cannot hit a prompt that
     * started in between) and a pending one is dequeued. Older servers (404 /
     * 405) get the classic pair: dequeue when still pending (`/queue
     * {delete:[id]}`), targeted `/interrupt {prompt_id}` when running. Finished
     * or unknown ids are a no-op either way.
     */
    cancelOwn(promptId: string): Promise<{
        cancelled: boolean;
        via: 'jobs-api' | 'dequeue' | 'interrupt' | 'none';
    }>;
    /** Cancel one job regardless of state (running → interrupt, pending → dequeue). */
    cancelJob(jobId: string): Promise<{
        cancelled: boolean;
    }>;
    /** Best-effort batch cancel; finished or unknown ids are no-ops. */
    cancelJobs(jobIds: string[]): Promise<{
        cancelled: boolean;
    }>;
    /** Clear or selectively delete history entries. */
    clearHistory(): Promise<void>;
    /** Delete specific history entries. */
    deleteHistory(promptIds: string[]): Promise<void>;
    /** Ask ComfyUI to unload models / free memory (per /free flags). */
    freeMemory(options?: {
        unloadModels?: boolean;
        freeMemory?: boolean;
    }): Promise<void>;
    /** List one user-data subdirectory (e.g. 'workflows') on the ComfyUI server. */
    listUserData(subdir: string): Promise<ComfyUIUserDataEntry[]>;
    /** Read one user-data file (path relative to the user root, e.g. 'workflows/x.json'). */
    getUserDataFile(relPath: string): Promise<unknown>;
    /** Node definitions for workflow construction (comfyui_object_info). */
    objectInfo(): Promise<Record<string, unknown>>;
    /** Server health/version probe. */
    systemStats(): Promise<{
        system?: {
            comfyui_version?: string;
        };
    }>;
    /** Download one generated media file through GET /view. */
    fetchView(ref: ComfyUIMediaRef): Promise<{
        bytes: Uint8Array;
        contentType: string;
    }>;
    /**
     * Stream one generated media file through GET /view without buffering it,
     * honoring an optional Range header so the browser can seek in audio/video
     * (the media proxy re-emits the status/headers and pipes the body). ComfyUI
     * answers valid ranges with 206 + Content-Range and out-of-range starts with
     * 416 — both pass through untouched. HEAD forwards as HEAD so no body is
     * downloaded. The maxMediaBytes guard applies to the full 200 response only
     * (a partial segment is bounded by definition).
     */
    fetchViewStreamed(ref: ComfyUIMediaRef, rangeHeader?: string, method?: 'GET' | 'HEAD'): Promise<ComfyViewStream>;
    /**
     * Poll history until the prompt completes, fails, or the budget/signal ends.
     * When the signal aborts, cancels this prompt (never a global interrupt)
     * before throwing.
     */
    waitForCompletion(opts: {
        promptId: string;
        timeoutMs: number;
        pollIntervalMs: number;
        signal: AbortSignal;
        /** Called once per poll round while the prompt is not finished (progress reporting). */
        onPoll?: () => Promise<void> | void;
        /** Cancel this prompt on the server when the signal aborts (default true);
         * background jobs cancel through their own hook and pass false. */
        cancelOnAbort?: boolean;
    }): Promise<ComfyUIHistoryEntry>;
}
export declare function hasMedia(entry: ComfyUIHistoryEntry): boolean;
/** Compose a readable failure message from history status messages. */
export declare function historyErrorMessage(promptId: string, entry: ComfyUIHistoryEntry): string;
/**
 * Build the same-origin proxy URL for one media file.
 *
 * The file is addressed by its own name/subfolder/type rather than by
 * prompt+node+index: the latter has to be resolved through ComfyUI's
 * /history, which lives in memory and is dropped on server restart or a
 * "clear history" click — after which every stored asset URL 404s even though
 * the file is still sitting in the output directory. Addressing the file
 * directly keeps old assets viewable for as long as the file exists.
 */
export declare function mediaProxyUrl(ref: ComfyUIMediaRef, proxyBase?: string): string;
/**
 * Collect media items from a completed history entry, in node/output order,
 * capped by maxItems. The URL is the same-origin proxy route when a web
 * server is present, otherwise the bare filename (for headless hosts).
 */
export declare function collectMedia(opts: {
    /** The run these outputs belong to; kept for call-site clarity and logging. */
    promptId: string;
    entry: ComfyUIHistoryEntry;
    maxItems: number;
    proxyBase: string | undefined;
}): ComfyUIMediaItem[];
