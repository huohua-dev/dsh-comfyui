/**
 * Built-in ComfyUI workflow templates in API format (node id → class_type +
 * inputs). `txt2img` and `img2img` use only core ComfyUI nodes; `video` is a
 * Wan 2.1 text-to-video skeleton that requires the ComfyUI-WanVideoWrapper
 * custom nodes and matching model files; `h3_t2v` is MiniMax H3 text-to-video
 * on core ComfyUI (≥ 0.39) nodes with the 10Eros TURBO checkpoint. The `guide`
 * field is shown to the model so it can override the right node inputs;
 * templates that declare `parameters` are driven by name instead (prompt,
 * width, seconds…), exactly like a saved library workflow.
 */
import type { WorkflowParameter } from './params.js';
export interface WorkflowTemplate {
    id: string;
    name: string;
    description: string;
    guide: string;
    workflow: Record<string, {
        class_type: string;
        inputs: Record<string, unknown>;
    }>;
    /** Named run parameters; when present, callers pass `parameters` by name. */
    parameters?: WorkflowParameter[];
}
/**
 * MiniMax H3 frame count for a duration — the template's ComfyMathExpression
 * (and h3_t2v.py): `x = max(5, round(sec × 24))`, then up to the next value
 * ≡ 5 (mod 17). Python's `%` is non-negative for a positive modulus; JS's is
 * not, so `(5 − x % 17) % 17` is normalized explicitly (1 s → 39, not 22).
 * 3 s → 73, 5 s → 124.
 */
export declare function h3Frames(seconds: number): number;
/** Seconds that map back onto an H3 frame count (two decimals, round-trips through h3Frames). */
export declare function h3SecondsOf(frames: number): number;
/** H3 model files on the reference server (see the reference h3_t2v.py script). */
export declare const H3_MODELS: {
    readonly unet: "10Eros_Max_h3_TURBO-hybrid_beta5_int8.safetensors";
    readonly clip: "qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors";
    readonly videoVae: "minimax_h3_video_vae_int8_convrot.safetensors";
    readonly audioVae: "minimax_h3_audio_vae_fp32.safetensors";
};
export declare const TEMPLATES: WorkflowTemplate[];
/** Look up a template by id. */
export declare function findTemplate(id: string): WorkflowTemplate | undefined;
/**
 * Merge per-node input overrides into a workflow copy. Each entry maps a node
 * id to a partial inputs object; later entries observe earlier merges.
 */
export declare function applyTemplateInputs(workflow: Record<string, {
    class_type: string;
    inputs: Record<string, unknown>;
}>, overrides: Record<string, Record<string, unknown>>): void;
/** Deep-copy a template's parameter list (callers may edit defaults). */
export declare function cloneParameters(parameters: WorkflowParameter[] | undefined): WorkflowParameter[] | undefined;
/** Clone a template workflow so callers never mutate the shared constant. */
export declare function cloneWorkflow(workflow: Record<string, {
    class_type: string;
    inputs: Record<string, unknown>;
}>): Record<string, {
    class_type: string;
    inputs: Record<string, unknown>;
}>;
