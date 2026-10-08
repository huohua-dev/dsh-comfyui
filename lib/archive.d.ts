import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ComfyUIMediaItem, type ComfyUIMediaRef, type ComfyViewStream } from './comfyui.js';
import type { Workflow, WorkflowParameter } from './params.js';
export declare function isPromptId(value: string): boolean;
/** One downloaded file of a run. */
export interface ArchivedFile {
    /** Local file name inside the run directory. */
    name: string;
    /** The ComfyUI reference it was downloaded from. */
    filename: string;
    subfolder: string;
    type: string;
    node: string;
    index: number;
    kind: ComfyUIMediaItem['kind'];
    bytes: number;
    sha256: string;
}
/** meta.json: everything needed to understand and reproduce a run. */
export interface RunMeta {
    version: 1;
    promptId: string;
    status: 'submitted' | 'completed' | 'failed' | 'cancelled';
    submittedAt: string;
    completedAt?: string;
    workflowName: string | null;
    workflowId?: string | null;
    source: string;
    /** ComfyUI server the run was queued on. */
    baseUrl: string;
    /** Named parameter definitions the run used (absent for raw workflows). */
    parameters?: WorkflowParameter[];
    /** Effective values per parameter name (explicit, default, randomized). */
    values: Record<string, unknown>;
    /** Every seed-like numeric input in the submitted prompt. */
    seeds: Array<{
        nodeId: string;
        classType: string;
        inputKey: string;
        value: number;
    }>;
    /** The exact API prompt ComfyUI received. */
    workflow: Workflow;
    files: ArchivedFile[];
    error?: string;
}
/** Seed-like numeric inputs of a prompt (seed, noise_seed, …). */
export declare function seedsOf(workflow: Workflow): RunMeta['seeds'];
/** Local file name for one output: `<node>-<index>-<sanitized original>`. */
export declare function localNameOf(item: Pick<ComfyUIMediaItem, 'node' | 'index' | 'filename'>): string;
/** Same-origin URL of an archived file. */
export declare function archiveUrl(promptId: string, name: string): string;
/** A media item rewritten to prefer the local copy. */
export type ArchivedMediaItem = ComfyUIMediaItem & {
    proxyUrl: string;
    localPath?: string;
};
export declare class RunArchive {
    private readonly root;
    private readonly inflight;
    private index;
    private indexing;
    constructor(root: () => string);
    /** The archive root currently in force (absolute). */
    get rootDir(): string;
    /** The run directory, or undefined when the id is not a UUID. */
    dirOf(promptId: string): string | undefined;
    readMeta(promptId: string): Promise<RunMeta | undefined>;
    private writeMeta;
    /** Record a run at submit time (status `submitted`, no files yet). */
    recordSubmission(input: Omit<RunMeta, 'version' | 'status' | 'files' | 'seeds' | 'submittedAt'> & {
        submittedAt?: string;
    }): Promise<void>;
    /** Mark a run failed / cancelled (keeps whatever was recorded). */
    markStatus(promptId: string, status: 'failed' | 'cancelled', error?: string): Promise<void>;
    /**
     * Download a finished run's media into its directory (once; concurrent
     * callers share the same work) and mark it completed. Files already on
     * disk with the recorded size are not fetched again.
     */
    archive(opts: {
        promptId: string;
        items: ComfyUIMediaItem[];
        download(ref: ComfyUIMediaRef): Promise<ComfyViewStream>;
        maxBytes: number;
        /** Used when the run was never recorded at submit (queued outside the plugin, or a pre-archive version). */
        fallback?: Omit<RunMeta, 'version' | 'status' | 'files' | 'seeds' | 'submittedAt' | 'promptId'>;
    }): Promise<RunMeta>;
    private archiveOnce;
    private download;
    /** Media items rewritten to the local copies (url → archive, proxy kept as fallback). */
    localize(promptId: string, items: ComfyUIMediaItem[], meta: RunMeta | undefined): ArchivedMediaItem[];
    /** Media items straight from meta.json (no ComfyUI involved). */
    itemsOf(meta: RunMeta, proxyUrl: (ref: ComfyUIMediaRef) => string): ArchivedMediaItem[];
    /**
     * Resolve one archived file for serving. Undefined unless the id is a UUID,
     * the name is one this run's meta.json lists, and the path is a regular
     * file (not a symlink) strictly inside the run directory.
     */
    resolveFile(promptId: string, name: string): Promise<{
        path: string;
        size: number;
        file: ArchivedFile;
    } | undefined>;
    /** The archived copy of a ComfyUI file reference, if any run downloaded it. */
    findByRef(ref: ComfyUIMediaRef): Promise<{
        promptId: string;
        name: string;
    } | undefined>;
    private ensureIndex;
}
/**
 * Serve one local file with single-range support (206 / 416 / HEAD), so the
 * <video> element can seek: without Range the seekable range stays empty and
 * the progress bar snaps back.
 */
export declare function serveLocalFile(request: IncomingMessage, response: ServerResponse, file: {
    path: string;
    size: number;
    contentType?: string;
}): Promise<void>;
/** Parse a single `bytes=` range; undefined = whole file. Multi-range requests get the whole file. */
export declare function parseRange(header: string | undefined, size: number): {
    start: number;
    end: number;
} | 'unsatisfiable' | undefined;
