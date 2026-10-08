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
import z from '@deepseek-ai/schemastery'
import { isAbsolute, join } from 'node:path'

const DEFAULT_UNREACHABLE_HINT_TEXT = 'win 可能在 LLM 模式，需要先运行 winmode.sh video'

export const Config = z.object({
  /** ComfyUI HTTP server base URL. */
  baseUrl: z.string().default('http://127.0.0.1:8188').volatile()
    .description('ComfyUI 服务器地址，例如 http://<comfyui-host>:8188'),
  /** Environment-variable name of the optional API key (credentials ref). */
  apiKeyEnv: z.string().default('COMFYUI_API_KEY').volatile()
    .description('可选 API Key 所在的环境变量名（凭据引用）'),
  /** Per-request connect/read timeout for the ComfyUI HTTP client. */
  connectTimeoutMs: z.number().min(1_000).max(60_000).default(10_000).volatile()
    .description('单次请求连接/读取超时（毫秒）'),
  /** How long a synchronous generation (or background job) waits for workflow completion. */
  timeoutMs: z.number().min(5_000).max(3_600_000).default(900_000).volatile()
    .description('一次生成（含后台任务）最长等待时间（毫秒）'),
  /** History polling interval while waiting for completion. */
  pollIntervalMs: z.number().min(200).max(10_000).default(1_000).volatile()
    .description('等待完成时轮询 history 的间隔（毫秒）'),
  /** Max media items returned per completed workflow. */
  maxMediaItems: z.number().min(1).max(50).default(12).volatile()
    .description('每次运行最多返回的媒体文件数'),
  /** Max bytes the media proxy streams (and the archive downloads) for one file. */
  maxMediaBytes: z.number().min(64 * 1024).max(4 * 1024 * 1024 * 1024).default(512 * 1024 * 1024).volatile()
    .description('单个媒体文件的大小上限（字节），代理与本地归档共用'),
  /** Directory for plugin data (workflow library, asset index); empty means DSH_HOME/data/dsh-comfyui. */
  dataDir: z.string().default('')
    .description('插件数据目录（工作流库、资产索引）；留空 = $DSH_HOME/data/dsh-comfyui。修改后插件会重启'),
  /** Max asset records kept in the asset index. */
  maxAssets: z.number().min(1).max(10_000).default(200)
    .description('资产索引保留的记录数上限（不影响本地归档文件）'),
  /** Directory holding the per-workflow skill packs. Empty = `<dataDir>/skills`.
   * Separate from `dataDir` on purpose: packs are documents a user may want on
   * another drive, in a synced folder, or under version control, while the
   * JSON state files belong with the rest of the plugin data. Must be absolute;
   * a relative value is ignored. */
  skillsDir: z.string().default('').volatile()
    .description('工作流技能包目录（绝对路径）；留空 = <数据目录>/skills'),
  /** Where finished runs are downloaded on this machine (one sub-directory per
   * prompt: the media files plus meta.json with the full workflow, seeds and
   * parameter values). Empty = `<dataDir>/archive`. Must be absolute; a
   * relative value is ignored. Chat cards play these local copies first, so
   * history keeps playing after ComfyUI goes offline. */
  archiveDir: z.string().default('').volatile()
    .description('成片本地归档目录（绝对路径）；留空 = <数据目录>/archive。每个任务一个子目录：媒体文件 + meta.json（完整工作流、seed、参数）'),
  /** Legacy external media origin. Ignored since 0.6.0: media URLs are
   * same-origin relative paths and the media routes only answer loopback hosts. */
  mediaHost: z.string().default('').volatile()
    .description('（0.6.0 起不再使用）旧版外部媒体地址'),
  /** ComfyUI's output directory on this machine, used to delete asset files
   * from the panel. Empty = infer it from the file paths ComfyUI reports;
   * deletion falls back to removing the index record when neither works
   * (e.g. a ComfyUI running on another host). */
  outputDir: z.string().default('')
    .description('本机上 ComfyUI 的 output 目录，仅用于面板删除资产文件；ComfyUI 在别的机器上时留空'),
  /** ComfyUI install root(s) on this machine (absolute paths). Multiple
   * entries are allowed because ComfyUI folders can be mapped/mounted (extra
   * models dirs, several installs, portable copies). The agent reads them to
   * locate ComfyUI files directly (workflows, models, the TTS-Audio-Suite
   * voice library) without guessing or asking the user. */
  comfyuiDirs: z.array(z.string()).default([]).volatile()
    .description('ComfyUI 安装目录（可多个，供 Agent 定位模型/自定义节点等文件）'),
  /** Appended to every "cannot reach ComfyUI" error so the agent can tell the
   * user what to do (e.g. how this particular server is brought online). */
  unreachableHint: z.string().default(DEFAULT_UNREACHABLE_HINT_TEXT).volatile()
    .description('连不上 ComfyUI 时附在报错后面的提示'),
})

export type Config = {
  /** ComfyUI HTTP server base URL. */
  baseUrl: string
  /** Environment-variable name of the optional API key (credentials ref). */
  apiKeyEnv: string
  /** Per-request connect/read timeout for the ComfyUI HTTP client. */
  connectTimeoutMs: number
  /** How long a synchronous generation waits for workflow completion. */
  timeoutMs: number
  /** History polling interval while waiting for completion. */
  pollIntervalMs: number
  /** Max media items returned per completed workflow. */
  maxMediaItems: number
  /** Max bytes the media proxy streams for one file. */
  maxMediaBytes: number
  /** Directory for plugin data (workflow library, asset index); empty means DSH_HOME/data/dsh-comfyui. */
  dataDir: string
  /** Max asset records kept in the asset index. */
  maxAssets: number
  /** Directory holding the per-workflow skill packs; empty = `<dataDir>/skills`. */
  skillsDir: string
  /** Local archive root for finished runs; empty = `<dataDir>/archive`. */
  archiveDir: string
  /** Legacy external media origin; ignored since 0.6.0. */
  mediaHost: string
  /** ComfyUI's output directory on this machine; empty infers it from reported file paths. */
  outputDir: string
  /** ComfyUI install root(s) on this machine; the agent uses them to locate files directly. */
  comfyuiDirs: string[]
  /** Hint appended to unreachable-server errors. */
  unreachableHint: string
}

/** The volatile-reference protocol shared across cosmokit copies (Symbol.for). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Read a config value that may be a volatile reference (dsh 0.1.7+) or a plain value (older hosts). */
function current(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && VOLATILE_WRITE in value) {
    return (value as unknown as { get(): unknown }).get()
  }
  return value
}

/**
 * Resolve the Loader's parsed entry config into the plain object the plugin
 * reads. Call again after `loader/volatile-update`: the references are the
 * same objects, now holding the new values.
 * @param raw - parsed entry config; fields may be volatile references.
 * @param defaultDataDir - data directory used when `dataDir` is empty.
 * @returns a fully populated plain config.
 */
export function resolveConfig(raw: Partial<Record<keyof Config, unknown>>, defaultDataDir: string): Config {
  const str = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback)
  const dataDir = str(current(raw.dataDir), '')
  const dirs = current(raw.comfyuiDirs)
  return {
    baseUrl: str(current(raw.baseUrl), 'http://127.0.0.1:8188'),
    apiKeyEnv: str(current(raw.apiKeyEnv), 'COMFYUI_API_KEY'),
    connectTimeoutMs: num(current(raw.connectTimeoutMs), 10_000),
    timeoutMs: num(current(raw.timeoutMs), 900_000),
    pollIntervalMs: num(current(raw.pollIntervalMs), 1_000),
    maxMediaItems: num(current(raw.maxMediaItems), 12),
    maxMediaBytes: num(current(raw.maxMediaBytes), 512 * 1024 * 1024),
    dataDir: dataDir !== '' ? dataDir : defaultDataDir,
    maxAssets: num(current(raw.maxAssets), 200),
    skillsDir: str(current(raw.skillsDir), ''),
    archiveDir: str(current(raw.archiveDir), ''),
    mediaHost: str(current(raw.mediaHost), ''),
    outputDir: str(current(raw.outputDir), ''),
    comfyuiDirs: Array.isArray(dirs)
      ? dirs.filter((dir): dir is string => typeof dir === 'string' && dir.trim() !== '')
      : [],
    unreachableHint: str(current(raw.unreachableHint), DEFAULT_UNREACHABLE_HINT),
  }
}

/** Default hint appended to "cannot reach ComfyUI" errors. */
export const DEFAULT_UNREACHABLE_HINT = DEFAULT_UNREACHABLE_HINT_TEXT

/**
 * The archive root in force: an absolute `archiveDir`, else `<dataDir>/archive`.
 * A relative value is ignored for the same reason as `skillsDir`.
 */
export function archiveRootOf(config: Pick<Config, 'archiveDir' | 'dataDir'>): string {
  const configured = config.archiveDir.trim()
  return configured !== '' && isAbsolute(configured) ? configured : join(config.dataDir, 'archive')
}
