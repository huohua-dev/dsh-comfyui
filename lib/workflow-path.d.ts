/**
 * Workflow identities are relative to userdata/workflows. Validate without
 * resolving dot segments so untrusted names cannot escape that root on any OS.
 * Only the v2 listing adapter strips its documented userdata-root prefix;
 * canonical route inputs must retain a real subdirectory named "workflows".
 */
export declare function normalizeWorkflowPath(value: unknown): string | undefined;
/** Explicit v2 paths are authoritative. Legacy name-only entries are already
 * relative to the requested directory; never synthesize a prefix for them. */
export declare function workflowEntryPath(entry: {
    path?: unknown;
    name?: unknown;
}): string | undefined;
export declare function requireWorkflowPath(value: unknown): string;
