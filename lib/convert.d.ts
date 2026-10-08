export interface ApiWorkflow {
    [nodeId: string]: {
        class_type: string;
        inputs: Record<string, unknown>;
    };
}
export type ConvertResult = {
    ok: true;
    workflow: ApiWorkflow;
    warnings: string[];
} | {
    ok: false;
    error: string;
};
/**
 * Flatten DynamicCombo values that 0.2.0–0.5.1 extraction wrapped as
 * `{ key, inputs: { sub: value } }` back into the flat API shape
 * (`master: key`, `master.sub: value`, recursively). Library entries saved by
 * those versions still carry the wrapped shape; normalizing at queue time
 * heals them without asking users to re-extract (Issue #10). Returns the same
 * object when nothing needed flattening.
 */
export declare function flattenDynamicCombos<W extends Record<string, {
    class_type: string;
    inputs: Record<string, unknown>;
}>>(workflow: W): W;
/**
 * Convert a UI-graph workflow (or one extracted component of it) to API
 * format using the live node definitions.
 * @param graph - parsed ComfyUI UI graph (v0.4 format).
 * @param objectInfo - the server's `/object_info` response.
 * @param options - `includeNodeIds` restricts conversion to one connected
 *   component (extraction); link resolution still uses the full graph, which
 *   is safe because components never share links.
 */
export declare function convertGraphToApi(graph: unknown, objectInfo: Record<string, unknown>, options?: {
    includeNodeIds?: Set<number>;
}): ConvertResult;
