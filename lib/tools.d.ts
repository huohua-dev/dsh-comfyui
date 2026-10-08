/**
 * Model-facing tools for dsh-comfyui, registered into the host `tools`
 * registry. `comfyui_run` submits a workflow and returns media results
 * (synchronously or as a background job); `comfyui_object_info` exposes the
 * server's node definitions; `comfyui_workflow` lists and runs saved
 * workflows from the panel-managed workflow library.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import type { ComfyUIClient, ComfyUIHistoryEntry } from './comfyui.js';
import type { AssetRecord, LoadSlot, StoredWorkflow } from './store.js';
import type { GraphAnalysis } from './analyze.js';
import type { RunProgress } from './progress.js';
import type { QueuedRun } from './queue.js';
import { type WorkflowParameter } from './params.js';
import type { HostHint } from './host-hint.js';
import { type WorkflowSkillPacks } from './skillpack.js';
import { type RunRecord } from './library.js';
import type { RunArchive } from './archive.js';
/** A workflow saved on the ComfyUI server (userdata/workflows), with extract status. */
export interface ComfyUIComfyWorkflow {
    name: string;
    size?: number;
    modified?: number;
    /** Whether at least one runnable API workflow was extracted from this graph. */
    extracted: boolean;
    /** Runnable API workflows extracted from this graph (运行主题). */
    derived: Array<{
        libraryId: string;
        name: string;
    }>;
}
/** Live runtime the tools, routes, and proxy share. */
export interface ComfyUIRuntime {
    getConfig(): Config;
    /** Resolve the API key per request (credentials store, then environment). */
    getApiKey(): Promise<string | undefined>;
    createClient(apiKey: string | undefined): ComfyUIClient;
    /** Absolute media proxy URL base: explicit config > detected request host > loopback. */
    proxyBase(): string | undefined;
    /** Remembers the origin browsers use to reach this server (Host header). */
    hostHint: HostHint;
    /** Whether the settings service can persist config writes. */
    settingsWritable(): boolean;
    updateConfig(patch: Record<string, unknown>): Promise<{
        ok: true;
    } | {
        ok: false;
        error: string;
    }>;
    /** Queue a workflow and track it in the queue tracker. `meta.parameters`
     * applies adjustable parameters (values/random seeds) before submitting.
     * Returns the prompt id and the exact API prompt that was submitted. */
    queue(workflow: unknown, meta: {
        workflowName: string | null;
        workflowId?: string | null;
        source: string;
        parameters?: WorkflowParameter[];
        values?: Record<string, unknown>;
    }): Promise<QueuedPrompt>;
    /** Collect a finished prompt's media and download it into the local
     * archive — the one completion path every run goes through. Archive
     * failures do not fail the run: the items then keep their proxy URLs and
     * `archiveError` says why. */
    complete(promptId: string, entry: ComfyUIHistoryEntry): Promise<{
        media: RunMediaItem[];
        archiveError?: string;
    }>;
    /** Record a run that ended without output (failed / cancelled) in its meta.json. */
    markRun(promptId: string, status: 'failed' | 'cancelled', error?: string): Promise<void>;
    /** Local archive of finished runs (meta.json + media per prompt). */
    archive: RunArchive;
    /** Stop tracking a prompt (used when a tool call fails before completion). */
    untrack(promptId: string): void;
    /** Every prompt this plugin queued and is still waiting on. */
    trackedRuns(): QueuedRun[];
    /** Live generation progress for one prompt (from the ComfyUI WebSocket). */
    queueProgress(promptId: string): RunProgress | undefined;
    /** Saved workflows from the library. */
    listWorkflows(): Promise<StoredWorkflow[]>;
    getWorkflow(id: string): Promise<StoredWorkflow | undefined>;
    /** Create or update a workflow in the library. */
    saveWorkflow(input: {
        id?: string;
        name: string;
        description: string;
        workflow: unknown;
        parameters?: WorkflowParameter[];
        tags?: string[];
        source?: 'user' | 'comfyui';
        comfyuiFile?: string;
    }): Promise<{
        ok: true;
        workflow: StoredWorkflow;
    } | {
        ok: false;
        error: string;
    }>;
    /** Delete a workflow from the library; false when it did not exist. */
    deleteWorkflow(id: string): Promise<boolean>;
    /** What a submitted run left behind (local archive record first, then
     * ComfyUI's history): the exact prompt, its parameter definitions and the
     * values used. Undefined when neither knows the prompt. */
    runRecord(promptId: string): Promise<RunRecord | undefined>;
    /** Node definitions, cached briefly; undefined when the server is unreachable. */
    objectInfo(): Promise<Record<string, unknown> | undefined>;
    /** Per-workflow skill packs (SKILL.md bundles under `<dataDir>/skills/`). */
    skillPacks: WorkflowSkillPacks;
    /** Force TTS-Audio-Suite to rescan its voice library (best-effort; false
     * when the server has no such endpoint). Call before re-deriving parameter
     * snapshots so object_info reports newly added voices. */
    refreshVoiceLibrary(): Promise<boolean>;
    /** Pixel sizes of panel-uploaded files, keyed by file name. */
    listMediaSizes(): Promise<Record<string, {
        width: number;
        height: number;
    }>>;
    /** Record the pixel size of one uploaded file. */
    saveMediaSize(name: string, size: {
        width: number;
        height: number;
    }): Promise<void>;
    /** File name recorded for a content hash (dedup index), if any. */
    lookupMediaHash(hash: string): Promise<string | undefined>;
    /** Record a content hash → file name pair for dedup. */
    saveMediaHash(hash: string, name: string): Promise<void>;
    /** The load-area slots, in order; `null` is an empty slot the user added.
     * Filled slots are the default source media for loader parameters. */
    loadSlots(): Promise<Array<LoadSlot>>;
    /** Persist the load-area slots. */
    saveSlots(slots: Array<LoadSlot>): Promise<void>;
    /** The asset index (newest first). */
    listAssets(): Promise<AssetRecord[]>;
    /** Remove one asset record from the index, returning what was removed. */
    deleteAsset(promptId: string): Promise<AssetRecord | undefined>;
    /** Move completed tracked runs into the asset index. */
    sweep(): Promise<AssetRecord[]>;
    /** Workflows the user saved on the ComfyUI server, with extract status. */
    listComfyWorkflows(): Promise<ComfyUIComfyWorkflow[]>;
    /** Read one ComfyUI-side saved workflow graph (UI format, not runnable as-is). */
    getComfyWorkflow(file: string): Promise<unknown>;
    /** Analyze one ComfyUI-side graph: connected components, groups, dangling nodes. */
    analyzeComfyWorkflow(file: string): Promise<GraphAnalysis | {
        ok: false;
        error: string;
    }>;
    /** Extract runnable API workflows from a ComfyUI-side graph (整体/按分量/主流程). */
    extractComfyWorkflow(input: {
        file: string;
        mode: 'all' | 'split' | 'main';
    }): Promise<{
        ok: true;
        saved: StoredWorkflow[];
        analysis: GraphAnalysis;
        warnings: string[];
    } | {
        ok: false;
        error: string;
    }>;
}
/** A submitted prompt: its id and the final API prompt ComfyUI received. */
export interface QueuedPrompt {
    promptId: string;
    prompt: Record<string, {
        class_type: string;
        inputs: Record<string, unknown>;
    }>;
    /** Effective parameter values (explicit, defaulted and randomized). */
    values: Record<string, unknown>;
}
/** One media item returned by comfyui_run (JSON-safe). */
export interface RunMediaItem {
    filename: string;
    subfolder: string;
    type: string;
    node: string;
    index: number;
    kind: 'image' | 'video' | 'audio' | 'other';
    /** Preferred same-origin URL: the local archive copy when there is one. */
    url: string;
    /** The ComfyUI /view proxy URL, the fallback when the local copy is gone. */
    proxyUrl?: string;
    /** Absolute path of the local archive copy on the DSH machine. */
    localPath?: string;
}
/** Synchronous completion result. */
export interface RunResult {
    kind: 'sync';
    promptId: string;
    status: 'completed' | 'interrupted';
    elapsedMs: number;
    media: RunMediaItem[];
    summary: string;
    /** Why the local archive copy is missing (the run itself succeeded). */
    archiveError?: string;
}
/** Background mode result: collect later with job_output. */
export interface BackgroundResult {
    kind: 'background';
    jobId: string;
    promptId: string;
    label: string;
}
type ApiWorkflow = Record<string, {
    class_type: string;
    inputs: Record<string, unknown>;
}>;
/**
 * Resolve comfyui_run's `workflow` / `template` into the prompt to submit.
 * Templates with named parameters (h3_t2v) are driven by `parameters`; a raw
 * `inputs` override on a parameterized input wins, and that parameter is then
 * dropped for this run so its default cannot overwrite the explicit value.
 */
export declare function buildWorkflow(args: Record<string, unknown>): {
    workflow: ApiWorkflow;
    label: string;
    template?: string;
    parameters?: WorkflowParameter[];
    values?: Record<string, unknown>;
};
/** Model-facing text of a finished run (tool result and job result alike). */
export declare function renderRunResultText(result: RunResult): string;
/**
 * One human-readable progress line for a queued prompt: the WebSocket
 * progress when the server reported any, else its queue position.
 */
export declare function progressLine(runtime: Pick<ComfyUIRuntime, 'queueProgress'>, client: Pick<ComfyUIClient, 'getQueue'>, promptId: string, workflow?: Record<string, {
    class_type: string;
}>): Promise<string | undefined>;
/** Register the plugin tools; returns disposers. */
export declare function registerComfyUITools(ctx: Context, runtime: ComfyUIRuntime): Array<() => void>;
export {};
