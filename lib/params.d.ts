/** One exposed, adjustable parameter of a saved workflow. */
export interface WorkflowParameter {
    id: string;
    /** English identifier the caller passes values by, e.g. "prompt". */
    name: string;
    /** Short display label (localized by the UI). */
    label: string;
    type: 'string' | 'number' | 'boolean';
    /** Node id in the API workflow the value is written back to. */
    nodeId: string;
    /** Input key on that node. */
    inputKey: string;
    /** Value used when the caller omits it; also the "as authored" value. */
    default: string | number | boolean;
    /** Note shown to the agent alongside the parameter. */
    description?: string;
    /** Number parameters (seeds): randomize on every run when true. */
    random?: boolean;
    /** Number parameters: the numeric type object_info declares for the input.
     * 'int' is rounded on apply; 'float' takes decimals. Absent means the
     * declaration was unavailable (no object_info, unregistered node, ambiguous
     * union type) — decimals are then accepted as-is, since a float value is
     * the safe superset. */
    numberKind?: 'int' | 'float';
    /** Declared numeric bounds and step from object_info (editor hints only —
     * values are not clamped, ComfyUI validates them at queue time). */
    min?: number;
    max?: number;
    step?: number;
    /** Allowed values when the node input is a dropdown (object_info combo). */
    options?: Array<string | number>;
    /** Loader-node inputs (LoadImage/LoadVideo/LoadAudio): the value is a
     * server-side filename; the panel offers upload via drag & drop.
     * 'media' is a multi-slot media list (e.g. MiniMaxH3 media_state): one
     * parameter per reference slot, merged back into the JSON array on apply. */
    upload?: 'image' | 'video' | 'audio' | 'media';
    /** Upload subdirectory (e.g. 'minimax_h3'); media files land there. */
    subfolder?: string;
    /** Value conversion before it is written to the node: the caller speaks in
     * the parameter's unit, the node in its own. 'h3_seconds_to_frames' maps a
     * duration onto MiniMax H3's frame grid (see templates.ts h3Frames). */
    transform?: 'h3_seconds_to_frames';
    /** Hard constraint checked before submit (e.g. 32 for H3 width/height),
     * unlike `step`, which is an editor hint only. */
    multipleOf?: number;
    /** The run is refused when no value is given and the default is empty. */
    required?: boolean;
}
type Workflow = Record<string, {
    class_type: string;
    inputs: Record<string, unknown>;
}>;
export type { Workflow };
/**
 * Whether a node input is a loader file picker (LoadImage/LoadVideo/LoadAudio
 * and friends), recognized generically from object_info: an explicit
 * image/video/audio upload flag, or a classic COMBO whose options are a file
 * list and whose key name is loader-shaped. Returns the upload kind.
 */
export declare function uploadKindOf(objectInfo: Record<string, unknown> | undefined, classType: string, inputKey: string): 'image' | 'video' | 'audio' | undefined;
/** The numeric type and bounds object_info declares for an input, if any.
 *
 * ComfyUI writes `["INT", {default,min,max,...}]` / `["FLOAT", {..., step,
 * round}]`, and a few nodes use decorated or union type names (`"INT:seed"`,
 * `"INT,FLOAT"`). A union that admits FLOAT is reported as float, because a
 * float value is accepted wherever an int one is but not the reverse.
 * Everything else returns undefined: the caller then treats the parameter as
 * an unconstrained number (decimals allowed, no rounding). */
export declare function numberSpecOf(objectInfo: Record<string, unknown> | undefined, classType: string, inputKey: string): {
    kind: 'int' | 'float';
    min?: number;
    max?: number;
    step?: number;
} | undefined;
/** The object_info input spec for one input name of a node class, if declared. */
export declare function inputOptions(objectInfo: Record<string, unknown> | undefined, classType: string, inputKey: string): Array<string | number> | undefined;
/** Full child info (key, options, default) for one selected DynamicCombo parent value. */
export declare function comboChildInfo(objectInfo: Record<string, unknown> | undefined, classType: string, inputKey: string, parentValue: string): {
    childInputKey: string;
    options: Array<string | number>;
    default: string;
} | undefined;
/**
 * Detect the conservative parameter set of a workflow: prompt text inputs,
 * EmptyLatentImage width/height, and KSampler steps/seed. Returns them in a
 * stable order (text, size, steps, seed) with defaults from current values.
 */
export declare function analyzeWorkflowParameters(workflow: Workflow, objectInfo?: Record<string, unknown>): WorkflowParameter[];
/**
 * Recompute the object_info-derived fields (options, numberKind, min/max/step)
 * of existing parameters against a fresh object_info snapshot, keeping the
 * parameter set itself untouched.
 *
 * Why this exists: a saved workflow's parameter list is written once at
 * save/analyze time (workflows.json) and never sees object_info again, so a
 * voice library or loader attachment that grew since then would reject the
 * fresh value at run time (the options check in applyWorkflowParameters). The
 * panel dropdown has no such problem — it re-reads object_info on every open —
 * which is why refreshing is an explicit step (TTS voice-library rescan +
 * object_info) rather than a silent auto-update.
 *
 * Only fields derived from object_info change. id/name/label/type/default/
 * random/upload/subfolder and the parameter *set* stay exactly as saved, so
 * user-added advanced parameters and their authored defaults survive. A
 * parameter whose node/input is unknown to the fresh object_info (unregistered
 * node, DynamicCombo child keys nested under a parent) keeps its stored
 * values. Returns the copy and the names whose derived fields changed.
 */
export declare function refreshParameterMetadata(parameters: WorkflowParameter[], objectInfo: Record<string, unknown> | undefined, workflow: Workflow): {
    parameters: WorkflowParameter[];
    changed: string[];
};
/**
 * Apply caller-provided values (and randomized seeds) onto a copy of the
 * workflow. Unknown parameters are ignored; omitted ones fall back to the
 * parameter default. The input workflow is not mutated.
 */
export declare function applyWorkflowParameters(workflow: Workflow, parameters: WorkflowParameter[], values: Record<string, unknown>, objectInfo?: Record<string, unknown>, imageSizes?: Record<string, {
    width: number;
    height: number;
}>, loadArea?: Array<{
    name: string;
    kind: 'image' | 'video' | 'audio';
}>, 
/** Filled with the value each parameter actually took (explicit, default,
 * load-area or randomized) — the record a run's metadata keeps. */
effective?: Record<string, unknown>): Workflow;
