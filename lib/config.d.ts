/**
 * dsh-comfyui host configuration. The same schema drives the Loader entry
 * config (cordis.yml patch) and the settings page, so one shape covers both
 * doors into the same values.
 *
 * Fields the plugin reads at use time are `.volatile()`: since dsh 0.1.7 the
 * settings service only edits volatile fields (anything else fails with
 * "Plugin entry has no volatile fields", Issue #11), and the Loader commits a
 * volatile-only change into the running references without restarting the
 * plugin. `dataDir` / `maxAssets` / `outputDir` stay ordinary: the store is
 * built from them at startup, so a change there restarts the plugin.
 */
import z from '@deepseek-ai/schemastery';
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    /** ComfyUI HTTP server base URL. */
    baseUrl: z<string, string, "volatile-defined">;
    /** Environment-variable name of the optional API key (credentials ref). */
    apiKeyEnv: z<string, string, "volatile-defined">;
    /** Per-request connect/read timeout for the ComfyUI HTTP client. */
    connectTimeoutMs: z<number, number, "volatile-defined">;
    /** How long a synchronous generation (or background job) waits for workflow completion. */
    timeoutMs: z<number, number, "volatile-defined">;
    /** History polling interval while waiting for completion. */
    pollIntervalMs: z<number, number, "volatile-defined">;
    /** Max media items returned per completed workflow. */
    maxMediaItems: z<number, number, "volatile-defined">;
    /** Max bytes the media proxy streams (and the archive downloads) for one file. */
    maxMediaBytes: z<number, number, "volatile-defined">;
    /** Directory for plugin data (workflow library, asset index); empty means DSH_HOME/data/dsh-comfyui. */
    dataDir: z<string, string, "defined">;
    /** Max asset records kept in the asset index. */
    maxAssets: z<number, number, "defined">;
    /** Directory holding the per-workflow skill packs. Empty = `<dataDir>/skills`.
     * Separate from `dataDir` on purpose: packs are documents a user may want on
     * another drive, in a synced folder, or under version control, while the
     * JSON state files belong with the rest of the plugin data. Must be absolute;
     * a relative value is ignored. */
    skillsDir: z<string, string, "volatile-defined">;
    /** Where finished runs are downloaded on this machine (one sub-directory per
     * prompt: the media files plus meta.json with the full workflow, seeds and
     * parameter values). Empty = `<dataDir>/archive`. Must be absolute; a
     * relative value is ignored. Chat cards play these local copies first, so
     * history keeps playing after ComfyUI goes offline. */
    archiveDir: z<string, string, "volatile-defined">;
    /** Legacy external media origin. Ignored since 0.6.0: media URLs are
     * same-origin relative paths and the media routes only answer loopback hosts. */
    mediaHost: z<string, string, "volatile-defined">;
    /** ComfyUI's output directory on this machine, used to delete asset files
     * from the panel. Empty = infer it from the file paths ComfyUI reports;
     * deletion falls back to removing the index record when neither works
     * (e.g. a ComfyUI running on another host). */
    outputDir: z<string, string, "defined">;
    /** ComfyUI install root(s) on this machine (absolute paths). Multiple
     * entries are allowed because ComfyUI folders can be mapped/mounted (extra
     * models dirs, several installs, portable copies). The agent reads them to
     * locate ComfyUI files directly (workflows, models, the TTS-Audio-Suite
     * voice library) without guessing or asking the user. */
    comfyuiDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    /** Appended to every "cannot reach ComfyUI" error so the agent can tell the
     * user what to do (e.g. how this particular server is brought online). */
    unreachableHint: z<string, string, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** ComfyUI HTTP server base URL. */
    baseUrl: z<string, string, "volatile-defined">;
    /** Environment-variable name of the optional API key (credentials ref). */
    apiKeyEnv: z<string, string, "volatile-defined">;
    /** Per-request connect/read timeout for the ComfyUI HTTP client. */
    connectTimeoutMs: z<number, number, "volatile-defined">;
    /** How long a synchronous generation (or background job) waits for workflow completion. */
    timeoutMs: z<number, number, "volatile-defined">;
    /** History polling interval while waiting for completion. */
    pollIntervalMs: z<number, number, "volatile-defined">;
    /** Max media items returned per completed workflow. */
    maxMediaItems: z<number, number, "volatile-defined">;
    /** Max bytes the media proxy streams (and the archive downloads) for one file. */
    maxMediaBytes: z<number, number, "volatile-defined">;
    /** Directory for plugin data (workflow library, asset index); empty means DSH_HOME/data/dsh-comfyui. */
    dataDir: z<string, string, "defined">;
    /** Max asset records kept in the asset index. */
    maxAssets: z<number, number, "defined">;
    /** Directory holding the per-workflow skill packs. Empty = `<dataDir>/skills`.
     * Separate from `dataDir` on purpose: packs are documents a user may want on
     * another drive, in a synced folder, or under version control, while the
     * JSON state files belong with the rest of the plugin data. Must be absolute;
     * a relative value is ignored. */
    skillsDir: z<string, string, "volatile-defined">;
    /** Where finished runs are downloaded on this machine (one sub-directory per
     * prompt: the media files plus meta.json with the full workflow, seeds and
     * parameter values). Empty = `<dataDir>/archive`. Must be absolute; a
     * relative value is ignored. Chat cards play these local copies first, so
     * history keeps playing after ComfyUI goes offline. */
    archiveDir: z<string, string, "volatile-defined">;
    /** Legacy external media origin. Ignored since 0.6.0: media URLs are
     * same-origin relative paths and the media routes only answer loopback hosts. */
    mediaHost: z<string, string, "volatile-defined">;
    /** ComfyUI's output directory on this machine, used to delete asset files
     * from the panel. Empty = infer it from the file paths ComfyUI reports;
     * deletion falls back to removing the index record when neither works
     * (e.g. a ComfyUI running on another host). */
    outputDir: z<string, string, "defined">;
    /** ComfyUI install root(s) on this machine (absolute paths). Multiple
     * entries are allowed because ComfyUI folders can be mapped/mounted (extra
     * models dirs, several installs, portable copies). The agent reads them to
     * locate ComfyUI files directly (workflows, models, the TTS-Audio-Suite
     * voice library) without guessing or asking the user. */
    comfyuiDirs: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    /** Appended to every "cannot reach ComfyUI" error so the agent can tell the
     * user what to do (e.g. how this particular server is brought online). */
    unreachableHint: z<string, string, "volatile-defined">;
}>>, "plain">;
export type Config = {
    /** ComfyUI HTTP server base URL. */
    baseUrl: string;
    /** Environment-variable name of the optional API key (credentials ref). */
    apiKeyEnv: string;
    /** Per-request connect/read timeout for the ComfyUI HTTP client. */
    connectTimeoutMs: number;
    /** How long a synchronous generation waits for workflow completion. */
    timeoutMs: number;
    /** History polling interval while waiting for completion. */
    pollIntervalMs: number;
    /** Max media items returned per completed workflow. */
    maxMediaItems: number;
    /** Max bytes the media proxy streams for one file. */
    maxMediaBytes: number;
    /** Directory for plugin data (workflow library, asset index); empty means DSH_HOME/data/dsh-comfyui. */
    dataDir: string;
    /** Max asset records kept in the asset index. */
    maxAssets: number;
    /** Directory holding the per-workflow skill packs; empty = `<dataDir>/skills`. */
    skillsDir: string;
    /** Local archive root for finished runs; empty = `<dataDir>/archive`. */
    archiveDir: string;
    /** Legacy external media origin; ignored since 0.6.0. */
    mediaHost: string;
    /** ComfyUI's output directory on this machine; empty infers it from reported file paths. */
    outputDir: string;
    /** ComfyUI install root(s) on this machine; the agent uses them to locate files directly. */
    comfyuiDirs: string[];
    /** Hint appended to unreachable-server errors. */
    unreachableHint: string;
};
/**
 * Resolve the Loader's parsed entry config into the plain object the plugin
 * reads. Call again after `loader/volatile-update`: the references are the
 * same objects, now holding the new values.
 * @param raw - parsed entry config; fields may be volatile references.
 * @param defaultDataDir - data directory used when `dataDir` is empty.
 * @returns a fully populated plain config.
 */
export declare function resolveConfig(raw: Partial<Record<keyof Config, unknown>>, defaultDataDir: string): Config;
/** Default hint appended to "cannot reach ComfyUI" errors. */
export declare const DEFAULT_UNREACHABLE_HINT = "win \u53EF\u80FD\u5728 LLM \u6A21\u5F0F\uFF0C\u9700\u8981\u5148\u8FD0\u884C winmode.sh video";
/**
 * The archive root in force: an absolute `archiveDir`, else `<dataDir>/archive`.
 * A relative value is ignored for the same reason as `skillsDir`.
 */
export declare function archiveRootOf(config: Pick<Config, 'archiveDir' | 'dataDir'>): string;
