/**
 * Canvas analysis for ComfyUI UI-graph workflows. A saved canvas is often a
 * test bench holding several independent flows at once: `groups` are visual
 * rectangles only, and the executable unit is a connected component over the
 * graph links (with bypassed and dangling nodes excluded). The analysis feeds
 * the extract (拆分) choices in the panel and the agent-facing skill.
 */
export interface GraphNodeLike {
    id: number;
    type: string;
    mode?: number;
    inputs?: Array<{
        link: number | null;
    }>;
    pos?: [number, number] | number[];
}
export interface GraphGroupLike {
    title?: string;
    bounding: [number, number, number, number] | number[];
}
export interface GraphLike {
    nodes: GraphNodeLike[];
    /** Saved rows are positional or object entries depending on the frontend
     * version — always consumed through {@link normalizeLinks}. */
    links: unknown[];
    groups?: GraphGroupLike[];
}
export interface IsolatedNode {
    id: number;
    type: string;
}
export interface ComponentInfo {
    /** 1-based index, ordered largest first. */
    index: number;
    nodeIds: number[];
    size: number;
    /** Group titles that contain at least one node of the component. */
    groups: string[];
    /** Distinct node class types in the component (preview). */
    nodeTypes: string[];
}
export interface GraphAnalysis {
    ok: true;
    /** Executable components, largest first. */
    components: ComponentInfo[];
    /** Dangling nodes ignored by extraction (Markdown, UI-only, unused primitives). */
    isolated: IsolatedNode[];
    /** Count of bypassed (mode 4) nodes skipped by extraction. */
    bypassedCount: number;
    /** 'single' when at most one component exists; 'multi' when several. */
    mode: 'single' | 'multi';
}
/**
 * Analyze a saved ComfyUI graph: split its active nodes into connected
 * components, associate group titles, and list the dangling nodes that
 * extraction ignores.
 * @param graph - parsed ComfyUI UI graph (v0.4 format).
 * @returns the analysis, or an error object when the graph is not readable.
 */
export declare function analyzeGraph(graph: unknown): GraphAnalysis | {
    ok: false;
    error: string;
};
