/**
 * ComfyUI UI-graph link normalization. The frontend changed how saved graphs
 * serialize the `links` array: rows used to be positional
 * (`[id, originId, originSlot, targetId, targetSlot, type]`), while the v0.4
 * frontend writes object entries
 * (`{ id, origin_id, origin_slot, target_id, target_slot, type }`). Analysis
 * and conversion both want one canonical shape, so both go through
 * {@link normalizeLinks} before touching a graph.
 */
/** Canonical link row: [linkId, originId, originSlot, targetId, targetSlot, type]. */
export type GraphLink = [number, number, number, number, number, string];
/** Normalize one link entry; undefined when the entry is not a readable link. */
export declare function normalizeLink(raw: unknown): GraphLink | undefined;
/** Normalize a whole `links` array, skipping entries that are not readable. */
export declare function normalizeLinks(raw: unknown): GraphLink[];
/**
 * Frontend-only nodes whose links are rewired or dropped before analysis and
 * conversion (Issue #8). None of them exists on the server.
 *
 * - KJNodes `SetNode` / `GetNode`: "wireless" links paired by name. A GetNode's
 *   output is the value wired into the SetNode of the same name (and a
 *   SetNode's own passthrough output is its input).
 * - rgthree `Mute / Bypass Relay` / `Repeater`: their `OPT_CONNECTION` links
 *   only propagate mute/bypass mode between nodes and carry no data. The mode
 *   they set is already saved on each target node, so the links are dropped.
 */
export declare const SET_NODE = "SetNode";
export declare const GET_NODE = "GetNode";
/** Whether a node type is one of the virtual nodes {@link resolveVirtualLinks} removes. */
export declare function isVirtualNodeType(type: string): boolean;
/**
 * Rewire the virtual nodes out of a graph's links, keeping link ids stable so
 * node `inputs[].link` references stay valid.
 *
 * A GetNode resolves to the SetNode of the same name with the greatest `order`
 * below its own (the scope rule the frontend applies), falling back to any
 * SetNode of that name. A GetNode without a matching, wired SetNode (e.g. an
 * empty optional slot) resolves to nothing, so its consumer stays unconnected.
 * @param rawNodes - the graph's `nodes` array as saved.
 * @param links - normalized links.
 * @returns links with virtual-node hops replaced by their real origins, and
 *   every link touching a virtual node otherwise removed.
 */
export declare function resolveVirtualLinks(rawNodes: unknown, links: GraphLink[]): GraphLink[];
