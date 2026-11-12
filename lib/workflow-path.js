/**
 * Workflow identities are relative to userdata/workflows. Validate without
 * resolving dot segments so untrusted names cannot escape that root on any OS.
 * Only the v2 listing adapter strips its documented userdata-root prefix;
 * canonical route inputs must retain a real subdirectory named "workflows".
 */
export function normalizeWorkflowPath(value) {
    if (typeof value !== 'string' || value.length === 0)
        return undefined;
    const path = value.replace(/\\/g, '/');
    // Also reject encoded path syntax: proxies may unquote more than once.
    if (path.startsWith('/') || /[:\x00-\x1f\x7f]/.test(path)
        || /%(?:2e|2f|5c|00|25)/i.test(path))
        return undefined;
    if (path.split('/').some((part) => part === '' || part.startsWith('.')))
        return undefined;
    return path.endsWith('.json') ? path : undefined;
}
/** Explicit v2 paths are authoritative. Legacy name-only entries are already
 * relative to the requested directory; never synthesize a prefix for them. */
export function workflowEntryPath(entry) {
    if (entry.path === undefined || entry.path === null)
        return normalizeWorkflowPath(entry.name);
    const path = normalizeWorkflowPath(entry.path);
    return path?.startsWith('workflows/') === true ? normalizeWorkflowPath(path.slice('workflows/'.length)) : path;
}
export function requireWorkflowPath(value) {
    const path = normalizeWorkflowPath(value);
    if (path === undefined)
        throw new Error('无效的工作流相对路径：必须是 workflows 内的非隐藏 JSON 文件');
    return path;
}
