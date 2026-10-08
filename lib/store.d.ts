import type { WorkflowParameter } from './params.js';
/** One saved workflow in the library. */
export interface StoredWorkflow {
    id: string;
    name: string;
    /** What the workflow does — the overview the agent reads to pick one. */
    description: string;
    /** ComfyUI API-format workflow: node id → { class_type, inputs }. */
    workflow: Record<string, {
        class_type: string;
        inputs: Record<string, unknown>;
    }>;
    /** Exposed adjustable parameters (auto-detected + user advanced). */
    parameters?: WorkflowParameter[];
    /** Classification tags (preset kinds like 图生图 plus user-defined). */
    tags?: string[];
    /** Skill-pack directory name under `<dataDir>/skills/`; absent = no pack. */
    skillDir?: string;
    /** Refuse `action: run` until the agent has read this workflow's skill pack. */
    requireSkill?: boolean;
    /** Where the workflow came from: 'user' (panel/tool) or 'comfyui' (imported). */
    source?: 'user' | 'comfyui';
    /** Original ComfyUI-side user-data file name when imported from the server. */
    comfyuiFile?: string;
    updatedAt: string;
}
/** One media file reference inside an asset record. */
export interface AssetMediaRef {
    filename: string;
    subfolder: string;
    type: string;
    node: string;
    index: number;
    kind: 'image' | 'video' | 'audio' | 'other';
    url: string;
}
/** One completed generation in the asset index. */
export interface AssetRecord {
    promptId: string;
    ts: string;
    workflowName: string | null;
    source: string;
    media: AssetMediaRef[];
}
/** One load-area slot: a picked file, or `null` for an empty slot. */
export type LoadSlot = CurrentImage | null;
/** The load-area selection: the image the user picked for image-to-image.
 * `name` is always a file name ComfyUI can load (generated outputs are copied
 * into the input dir on selection). */
export interface CurrentImage {
    name: string;
    kind: 'image' | 'video' | 'audio';
    source: 'imported' | 'generated';
}
/** Validate a workflow-shaped value; returns an error message or undefined. */
export declare function validateWorkflow(value: unknown): string | undefined;
/** Persistent queue-tracker memory (survives web-server restarts). */
export interface TrackedState {
    runs: Array<{
        promptId: string;
        ts: string;
        workflowName: string | null;
        source: string;
    }>;
    archived: string[];
}
/** JSON-file-backed store for workflows and assets. */
export declare class ComfyUIStore {
    private readonly maxAssets;
    private readonly workflowsPath;
    private readonly assetsPath;
    private readonly trackedPath;
    private readonly mediaSizesPath;
    private readonly mediaHashesPath;
    private readonly currentImagePath;
    /** Root of the per-workflow skill packs (one directory per pack). */
    readonly skillsRoot: string;
    constructor(dir: string, maxAssets: number);
    /** Ensure the data directory exists. */
    init(): Promise<void>;
    /** Pixel sizes of files uploaded through the panel, keyed by file name —
     * used to default the workflow output size to the source image. */
    loadMediaSizes(): Promise<Record<string, {
        width: number;
        height: number;
    }>>;
    saveMediaSize(name: string, size: {
        width: number;
        height: number;
    }): Promise<void>;
    /** Content-hash → file name index: re-uploading identical bytes reuses the
     * existing file instead of creating a duplicate. */
    loadMediaHashes(): Promise<Record<string, string>>;
    lookupMediaHash(hash: string): Promise<string | undefined>;
    saveMediaHash(hash: string, name: string): Promise<void>;
    /** The load-area slots: an ordered list where each entry is either a picked
     * file or `null` for an empty slot the user added but has not filled yet.
     * Slot 0 is the primary source (the big preview, and the default source
     * image for image-to-image).
     *
     * The file held a single `{name,kind,source}` object before the load area
     * had more than one slot; that shape is still read and lifted into a
     * one-slot list, so an existing selection survives the upgrade. */
    loadSlots(): Promise<LoadSlot[]>;
    saveSlots(slots: LoadSlot[]): Promise<void>;
    listWorkflows(): Promise<StoredWorkflow[]>;
    getWorkflow(id: string): Promise<StoredWorkflow | undefined>;
    private writeWorkflows;
    /** Create or update a workflow (update when `input.id` matches an existing one). */
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
    /** Patch the skill-pack fields of one workflow without touching its JSON or
     * parameters. `skillDir: null` detaches the pack (the directory stays on
     * disk until an explicit destroy). */
    updateWorkflowSkill(id: string, patch: {
        skillDir?: string | null;
        requireSkill?: boolean;
    }): Promise<StoredWorkflow | undefined>;
    /** Delete a workflow by id; false when it did not exist. */
    deleteWorkflow(id: string): Promise<boolean>;
    listAssets(): Promise<AssetRecord[]>;
    /** Prepend an asset record (deduplicated by promptId, capped at maxAssets). */
    /** Drop one asset record from the index; returns the record that was
     * removed so the caller can delete the files it referenced. */
    deleteAsset(promptId: string): Promise<AssetRecord | undefined>;
    appendAsset(record: AssetRecord): Promise<void>;
    /** Load the persisted queue-tracker state (empty when absent/corrupt). */
    loadTracked(): Promise<TrackedState>;
    /** Persist the queue-tracker state so completed runs survive restarts. */
    saveTracked(state: TrackedState): Promise<void>;
}
