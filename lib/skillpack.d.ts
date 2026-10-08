/**
 * Sub-directories offered by default. These are suggestions, not a whitelist:
 * a pack may hold any directory whose name matches {@link DIR_NAME}, so a user
 * can follow whatever layout their other tooling expects. The list covers the
 * conventions this plugin's packs are most likely to meet — the host skill
 * bundle shape (`references` / `scripts` / `assets`) plus the names agent and
 * prompt tooling commonly use.
 */
export declare const SKILL_PRESET_DIRS: readonly ["references", "scripts", "assets", "templates", "agents", "examples", "prompts", "commands", "docs", "data"];
/** A pack sub-directory name. Any {@link DIR_NAME}-valid name is accepted. */
export type SkillBucket = string;
/** The main document; it is the body `action: skill` returns and cannot be renamed or deleted. */
export declare const SKILL_MAIN = "SKILL.md";
/** One text file may not exceed this: SKILL.md is injected into the model context whole. */
export declare const MAX_FILE_BYTES: number;
/** Imported binaries live in `assets/` and never enter the prompt as text, so
 * they get a larger budget than the documents the model reads verbatim. */
export declare const MAX_ASSET_BYTES: number;
/** A pack is documentation, not storage — these caps keep it that way. The
 * byte cap is the real storage guard; the file count only stops pathological
 * noise, so it sits well above real bulk-copied packs (a ComfyUI music
 * template library lands at 1000+ small .txt files and MUST survive a
 * preset export → import round trip). */
export declare const MAX_PACK_FILES = 2000;
export declare const MAX_PACK_BYTES: number;
/** Per-file size budget by extension: binaries never enter the prompt as
 * text, so they get the larger budget wherever they live. Exported because
 * the preset importer pre-filters oversized files per file (skip + warning)
 * before handing the batch to {@link SkillPackStore.writeMany}. */
export declare function sizeLimitOf(file: string): number;
/** One file inside a pack. */
export interface SkillFileInfo {
    /** Path relative to the pack root, always forward-slashed (`references/styles.md`). */
    path: string;
    size: number;
    updatedAt: string;
}
/** A pack's listing plus the catalog summary derived from SKILL.md. */
export interface SkillPackInfo {
    slug: string;
    /** Absolute directory path; handed to the model as the skill's resource base. */
    dir: string;
    /** Short routing line shown by `comfyui_workflow action: list`. */
    summary: string;
    files: SkillFileInfo[];
    /** Sub-directories present in the pack, including empty ones. */
    dirs: string[];
    totalBytes: number;
}
/** A successful operation, or a message the panel and tools show verbatim. */
export type SkillPackResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: string;
};
/** The MIME type used when serving one pack file. */
export declare function contentTypeOf(path: string): string;
/**
 * Where an imported file belongs when the user did not pick a bucket.
 *
 * Host-side on purpose: the panel sends a file name and gets the resolved path
 * back, so the extension→bucket rule has exactly one definition.
 * @param file - the imported file's base name.
 * @returns the bucket to place it in, or undefined when the type is not accepted.
 */
export declare function defaultBucketFor(file: string): Exclude<SkillBucket, ''> | undefined;
/**
 * Build a stable directory name for a workflow's pack.
 *
 * The readable half is for whoever opens the folder in an editor; the id suffix
 * makes it unique and, more importantly, keeps the directory put when the user
 * renames the workflow — a pack that moved on every rename would strand the
 * absolute path already handed to a running agent.
 * @param name - the workflow's display name.
 * @param id - the workflow id.
 * @returns a slug matching the {@link SLUG} grammar.
 */
export declare function skillSlug(name: string, id: string): string;
/**
 * Split and validate a pack-relative path.
 * @param path - candidate relative path such as `references/styles.md`.
 * @returns the bucket and file name, or an error message.
 */
export declare function parseSkillPath(path: string): SkillPackResult<{
    bucket: SkillBucket;
    file: string;
}>;
/**
 * Validate one sub-directory name from the browser or a tool call.
 * @param name - candidate directory name.
 * @returns the name, or why it was refused.
 */
export declare function parseSkillDir(name: string): SkillPackResult<string>;
/**
 * Strip a leading `---` frontmatter block and read its `summary` key.
 *
 * Deliberately not a YAML parser: the only key this plugin interprets is
 * `summary`, and a dependency for one line of text is not worth it. Unknown
 * keys survive untouched in the file for whoever edits it by hand.
 * @param text - the raw SKILL.md contents.
 * @returns the body without frontmatter plus the summary when present.
 */
export declare function splitFrontmatter(text: string): {
    body: string;
    summary: string;
};
/** Compose SKILL.md text from a summary and a body, keeping the frontmatter canonical. */
export declare function joinFrontmatter(summary: string, body: string): string;
/**
 * The skill-pack directory tree under the plugin data directory.
 *
 * One instance per plugin fiber; every method takes the pack slug so a single
 * store serves the whole library.
 */
export declare class SkillPackStore {
    private readonly resolveRoot;
    /**
     * @param root - the pack directory tree, or a getter when it follows a config
     *   value the settings page can change while the plugin runs.
     */
    constructor(root: string | (() => string));
    /** The current pack root (re-read per call: `skillsDir` is hot-configurable). */
    get root(): string;
    /** Absolute path of one pack, after re-validating the slug from workflows.json. */
    private dirOf;
    /** Absolute path of one file inside a pack, guarded twice: grammar, then containment. */
    private fileOf;
    /** Create the pack directory and seed SKILL.md when it does not exist yet. */
    create(slug: string, seed: string): Promise<SkillPackResult<SkillPackInfo>>;
    /**
     * Find a pack directory belonging to a workflow id, whatever its readable
     * half says. Detaching a pack keeps the directory, and the workflow may have
     * been renamed since: without this, re-enabling would mint a new slug and
     * strand the user's hand-written notes in the old directory.
     * @param id - the workflow id whose suffix the directory carries.
     * @returns the matching slug, or undefined.
     */
    findBySuffix(id: string): Promise<string | undefined>;
    /** Whether the pack directory exists on disk. */
    exists(slug: string): Promise<boolean>;
    /** List a pack: SKILL.md plus one level of each bucket, with its derived summary. */
    info(slug: string): Promise<SkillPackResult<SkillPackInfo>>;
    /** Create one sub-directory. Empty directories are legal — a user may lay a
     * pack out before filling it in. */
    makeDir(slug: string, name: string): Promise<SkillPackResult<SkillPackInfo>>;
    /** Read one file as text. */
    read(slug: string, path: string): Promise<SkillPackResult<string>>;
    /** SKILL.md body with frontmatter stripped — the text handed to the model. */
    body(slug: string): Promise<SkillPackResult<{
        body: string;
        summary: string;
        dir: string;
    }>>;
    /** Create or overwrite one text file. */
    write(slug: string, path: string, content: string): Promise<SkillPackResult<SkillPackInfo>>;
    /**
     * Create or overwrite one file from raw bytes, enforcing the per-file and
     * per-pack caps. The text and import paths share this so an imported file
     * can never bypass a limit the editor honours.
     */
    writeBytes(slug: string, path: string, bytes: Buffer): Promise<SkillPackResult<SkillPackInfo>>;
    /** Bulk write for preset restore: ONE limit check for the whole batch
     * instead of per-file enumeration. Per-file checks re-count the entire
     * pack on every write, so restoring a 1000-file pack that way is O(n²)
     * filesystem calls — a frozen-looking import for minutes. Grammar and
     * per-file size limits are still enforced here; the batch is refused
     * whole (the caller reports which file tripped), never written partially. */
    writeMany(slug: string, entries: ReadonlyArray<{
        path: string;
        bytes: Buffer;
    }>): Promise<SkillPackResult<SkillPackInfo>>;
    /** Read one file as raw bytes (the panel's image preview and downloads). */
    readBytes(slug: string, path: string): Promise<SkillPackResult<Buffer>>;
    /** Rename one file; SKILL.md is fixed and both sides are validated. */
    rename(slug: string, from: string, to: string): Promise<SkillPackResult<SkillPackInfo>>;
    /** Delete one file; SKILL.md is fixed. */
    remove(slug: string, path: string): Promise<SkillPackResult<SkillPackInfo>>;
    /** Delete the whole pack directory. Only the explicit destroy gesture calls this. */
    destroy(slug: string): Promise<SkillPackResult<true>>;
}
/**
 * The SKILL.md a freshly enabled pack starts from.
 *
 * The seed is a table of contents on purpose: the body is what every
 * `action: skill` call pays for, so it should point at reference files rather
 * than hold their content.
 * @param workflowName - the workflow this pack documents.
 * @param parameters - adjustable parameter names, listed as a starting point.
 * @returns SKILL.md text including frontmatter.
 */
export declare function seedSkillDocument(workflowName: string, parameters: string[]): string;
/** A pack as the panel and the tools see it: the listing plus its workflow-side flags. */
export interface WorkflowSkillPack extends SkillPackInfo {
    workflowId: string;
    workflowName: string;
    /** Whether `action: run` refuses until the agent has read this pack. */
    required: boolean;
}
/** The pack body handed to the model by `comfyui_workflow action: skill`. */
export interface WorkflowSkillBody {
    workflowId: string;
    workflowName: string;
    summary: string;
    body: string;
    /** Absolute directory the model resolves relative paths against. */
    resourceBase: string;
    /** Everything in the pack, so the model does not have to list the directory. */
    files: string[];
}
/** Minimal slice of the workflow store the pack API needs. */
interface SkillPackHost {
    /** Pack root; a getter when it follows a config value that can change. */
    readonly skillsRoot: string | (() => string);
    getWorkflow(id: string): Promise<StoredWorkflowLike | undefined>;
    updateWorkflowSkill(id: string, patch: {
        skillDir?: string | null;
        requireSkill?: boolean;
    }): Promise<StoredWorkflowLike | undefined>;
}
/** Structural view of a stored workflow (avoids importing the store class). */
interface StoredWorkflowLike {
    id: string;
    name: string;
    skillDir?: string;
    requireSkill?: boolean;
    parameters?: Array<{
        name: string;
    }>;
}
/** Workflow-aware skill-pack operations shared by the tools and the panel routes. */
export interface WorkflowSkillPacks {
    /** Absolute root of all packs (shown in the panel so users can open it). */
    readonly root: string;
    /** One workflow's pack, or undefined when it has none. */
    info(id: string): Promise<WorkflowSkillPack | undefined>;
    /** Same as {@link info}, for a workflow record the caller already holds —
     * `action: list` decorates the whole library and must not re-read
     * workflows.json once per pack. */
    infoFor(workflow: {
        id: string;
        name: string;
        skillDir?: string;
        requireSkill?: boolean;
    }): Promise<WorkflowSkillPack | undefined>;
    /** Attach a pack: create the directory, seed SKILL.md, record the slug. */
    enable(id: string): Promise<SkillPackResult<WorkflowSkillPack>>;
    /** Detach the pack from the workflow; the directory stays on disk. */
    disable(id: string): Promise<SkillPackResult<true>>;
    /** Detach and delete the directory. */
    destroy(id: string): Promise<SkillPackResult<true>>;
    /** Toggle the run-time gate. */
    setRequired(id: string, required: boolean): Promise<SkillPackResult<WorkflowSkillPack>>;
    /** Create one sub-directory inside the pack. */
    makeDir(id: string, name: string): Promise<SkillPackResult<WorkflowSkillPack>>;
    readFile(id: string, path: string): Promise<SkillPackResult<string>>;
    /** One file's raw bytes plus its MIME type, for the panel preview. */
    readRaw(id: string, path: string): Promise<SkillPackResult<{
        bytes: Buffer;
        contentType: string;
    }>>;
    /** Import one uploaded file. Without an explicit bucket the extension picks
     * it (`defaultBucketFor`), and the resolved path comes back to the caller. */
    importFile(id: string, file: string, bytes: Buffer, bucket?: string): Promise<SkillPackResult<{
        path: string;
        pack: WorkflowSkillPack;
    }>>;
    /** Bulk restore path: every entry's `path` is already bucket-qualified
     * (`references/x.txt` or `SKILL.md`). One limit check for the whole batch —
     * see {@link SkillPackStore.writeMany} for why per-file checks are not
     * good enough at 1000-file scale. */
    importFiles(id: string, entries: ReadonlyArray<{
        path: string;
        bytes: Buffer;
    }>): Promise<SkillPackResult<WorkflowSkillPack>>;
    writeFile(id: string, path: string, content: string): Promise<SkillPackResult<WorkflowSkillPack>>;
    renameFile(id: string, from: string, to: string): Promise<SkillPackResult<WorkflowSkillPack>>;
    deleteFile(id: string, path: string): Promise<SkillPackResult<WorkflowSkillPack>>;
    /** The model-facing body plus resource base. */
    load(id: string): Promise<SkillPackResult<WorkflowSkillBody>>;
}
/**
 * Bind the pack directory tree to the workflow library.
 * @param host - the workflow store (its data dir owns the pack root).
 * @returns the operations the tools and routes call.
 */
export declare function createWorkflowSkillPacks(host: SkillPackHost): WorkflowSkillPacks;
export {};
