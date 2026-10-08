/**
 * Library edits the agent performs from chat (`comfyui_workflow` save /
 * update / delete), so a user never has to open the panel or ComfyUI to keep
 * a workflow: "把这个存成模板" saves the run just made, "以后默认 5 秒" updates
 * a default, "删掉那个" removes it.
 *
 * Saving from a finished run (`prompt_id`) reuses the run's own record: the
 * exact API prompt that was submitted plus the parameter definitions it ran
 * with (so H3's seconds→frames parameter survives instead of degrading to a
 * raw frame count), with the values actually used as the new defaults. A
 * randomized seed stays random unless the caller pins one.
 */
import { type Workflow, type WorkflowParameter } from './params.js';
/** What a finished (or submitted) run left behind that a save can reuse. */
export interface RunRecord {
    workflow: Workflow;
    parameters?: WorkflowParameter[];
    values?: Record<string, unknown>;
    workflowName?: string | null;
}
/** A workflow + parameter set ready for `store.saveWorkflow`. */
export interface LibraryDraft {
    workflow: Workflow;
    parameters: WorkflowParameter[];
}
/**
 * Apply `{ name: value }` as new defaults. Unknown names are an error (a typo
 * must not silently save the old value). Giving a random seed a default pins
 * it: the caller asked for that seed.
 */
export declare function applyDefaults(parameters: WorkflowParameter[], defaults: Record<string, unknown>): WorkflowParameter[];
/**
 * Build the workflow + parameters to save from exactly one source:
 * `workflow` (raw API JSON, parameters auto-detected), `template` (built-in
 * id), or `run` (a finished prompt's record). `defaults` then overrides
 * parameter defaults by name.
 */
export declare function draftForSave(source: {
    workflow?: unknown;
    template?: unknown;
    run?: RunRecord;
    defaults?: unknown;
    objectInfo?: Record<string, unknown>;
}): LibraryDraft;
/**
 * Replace a saved workflow's JSON while keeping its parameter set where it
 * still applies: a parameter survives when its node still exists with a
 * literal (non-linked) value under that input; inputs the new graph exposes
 * that no surviving parameter covers are added from auto-detection.
 */
export declare function draftForUpdate(current: LibraryDraft, change: {
    workflow?: unknown;
    defaults?: unknown;
    objectInfo?: Record<string, unknown>;
}): LibraryDraft;
/** One-line parameter summary for tool output: `seconds=3, width=864, seed=随机`. */
export declare function describeParameters(parameters: WorkflowParameter[]): string;
