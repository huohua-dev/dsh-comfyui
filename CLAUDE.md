# CLAUDE.md

本文件为 Claude Code 在本仓库工作时的向导：项目结构、模块职责、开发命令与必须遵守的契约。

## 项目概览

`dsh-comfyui` 是 **DeepSeek Harness (DSH / cordis) 的 ComfyUI 插件**：让 Agent 通过工具直接驱动 ComfyUI 生成、处理图像与视频，并在浏览器端提供工作流库 / 资产 / 队列面板、对话内媒体卡片和设置页。

- 包名 `dsh-comfyui`，ESM（`"type": "module"`），Node ≥ 22.19，MIT。
- 入口：host 侧 `lib/index.js`（由 `src/*.ts` 经 tsc 编译）；浏览器侧 `client/client.js`（由 `src/client/*` 经 tsdown 打包）。
- peer 依赖：`@deepseek-ai/cordis`（`^4.0.1`）、`@deepseek-ai/dsh-settings`（**写死 `0.2.0-rc.2`**）。本仓库是上游 fandc520/dsh-comfyui 0.5.4 的 fork，0.6.0 起只适配 DSH 0.2.0-rc.2：宿主按 `semver.satisfies(运行版本, range, { includePrerelease: true })` 检查每个 `@deepseek-ai/dsh*` peer，不满足就拒装（除非 allow-version 豁免——我们不依赖豁免，`tests/compat.spec.ts` 用同一规则守住）。运行时依赖 `@deepseek-ai/schemastery`、`fflate`。
- `cordis.patch.yml` 把插件以 `id: comfyui` 插入 profile 层栈；`package.json` 的 `dsh` 字段声明 bundle patch 与 client 平台/注入。

## 常用命令

```sh
npm run typecheck    # host + client 双 tsconfig 类型检查（不产物）
npm run build        # build:host (tsc → lib/) && build:client (tsdown → client/client.js)
npm run build:host   # 仅 host
npm run build:client # 仅客户端 bundle
npm test             # build + vitest（tests/*.spec.ts）+ 旧的 scripts/test-*.mjs
REAL_COMFY=http://<comfyui-host>:8188 npx vitest run tests/real.e2e.spec.ts  # 真机 H3 端到端（会占用 GPU 约 1–2 分钟）
npm pack --dry-run   # 发布前必查：README 引用的资源都要在 files 白名单里
node scripts/test-store-params.mjs   # 离线自测：参数保存/重载（需先 build）
node scripts/test-skillpack.mjs      # 离线自测：技能包 CRUD / 路径穿越防护（需先 build）
node scripts/test-transfer.mjs       # 离线自测：预设导出/导入回环（需先 build）
node scripts/test-convert.mjs        # 离线自测：画布分析与图→API 转换回归（需先 build）
```

**改动生效规则**：`src/*.ts`（host：tools/routes/store/params/skill…）改完要 **重启 DSH**；`src/client/*` 改完 **刷新页面** 即可。skill 文本编译进 `lib/skill.js`，属 host 侧。

构建产物 `lib/`、`client/` 不入 master（见 `.gitignore`），clone 后需 `pnpm install && npm run build`。发布走 **`dist` 分支**（照 dsh-image-gen）：只含 `lib/`、`client/`、`cordis.patch.yml`、README、LICENSE、logo/images 与去掉 scripts/devDependencies 的 package.json，安装用 `dsh plugin --profile desktop add github:huohua-dev/dsh-comfyui#dist`。推送走 HTTPS + gh 凭据。**提交前必须扫描敏感信息**（真实 IP、本机路径、token），测试与注释里一律用 `<comfyui-host>` / `192.0.2.x` 这类占位。

测试设施（`tests/`）：`fake-comfy.ts` 是带队列语义和请求日志的 ComfyUI v0.39 替身（含 multipart `/upload/image`：写进 `files` 的 `input/<subfolder>/<name>`，不带 overwrite 时同名改为 `name (1).ext`）；`fake-host.ts` 用最小 DSH 0.2 宿主（tools 注册表、0.2 jobs 契约替身、按 exact/prefix 路由的 http 服务器、可选 connection.admit）跑**真实的** `apply()`，测试像模型（tool execute）和浏览器（HTTP）一样调用插件。

## 架构

插件分两半，通过同源 HTTP 路由通信，浏览器 **从不** 直连 ComfyUI（无 CORS、无混合内容、密钥不下发）：

```
Agent ──tools──┐
               ├─→ ComfyUIRuntime（src/index.ts 组装的能力对象）
浏览器 ─routes─┘        │
                        ├─ ComfyUIClient (comfyui.ts) ──HTTP/WS──→ ComfyUI 服务器
                        ├─ ComfyUIStore  (store.ts)   ──JSON 文件─→ $DSH_HOME/data/dsh-comfyui/
                        ├─ QueueTracker  (queue.ts)
                        └─ ProgressTracker (progress.ts, WebSocket)
浏览器 ←媒体─ /comfyui/media 同源代理 (proxy.ts)
```

`ComfyUIRuntime`（定义在 `src/tools.ts`，实例化在 `src/index.ts`）是唯一的能力面：工具层和路由层都只依赖它，不各自持有 client/store。新增功能优先加 runtime 方法，而不是在 routes/tools 里直接 new client。

### 两个"工作流主题"（贯穿全项目的核心概念）

- **图工作流（衍生主题）**：ComfyUI 端保存的画布 UI 图（nodes/links/widgets），是"源"，**不能直接运行**；一张画布可能含多个互相独立的流程。
- **API 工作流（运行主题）**：API 格式 prompt（node id → `{ class_type, inputs }`），是"运行单元"，由图 **提取（extract）** 而来或用户直接粘贴导入。

提取路径：`analyzeGraph`（连通分量分析）→ 用户在面板选 整体 / 按分量 / 主流程 → `convertGraphToApi`（图→API）→ `analyzeWorkflowParameters`（识别可调参数）→ `store.saveWorkflow`。

## host 侧模块（`src/`）

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 插件入口：解析配置、组装 `ComfyUIRuntime`、注册设置节 / 工具 / skill / 路由 / 媒体代理，全部挂在 fiber 上随插件卸载。`export const inject = ['tools']`。设置有两代宿主：dsh 0.1.2–0.1.5 经 `ctx.inject(['settings'])` 子 fiber 调 `settings.installSection(ctx, 'comfyui', Config, resolved, { setSource, onChange })`；dsh 0.1.7+ 没有 `installSection`，设置服务只编辑 Config 里 `.volatile()` 的字段（写进 profile 的 `cordis.patch.yml`），Loader 就地更新引用后发 `loader/volatile-update`，插件据此 `resolveConfig` 重读并在 `baseUrl` 变化时重连进度 WS（#11）；0.2 上调 `settings.configure({ auto: true }, ctx.fiber)`：DSH「插件」页按 volatile 字段（带 `.description()`）自动生成本插件的设置表单，用户在那里填 ComfyUI 地址；自带的 settings.section 页保留（有测试连接按钮）。settings 是可选服务，无该服务的 headless 宿主静默跳过；命名空间就是 profile 条目 id `'comfyui'`。 |
| `config.ts` | schemastery 配置 schema（同时供 cordis.yml 入口配置和设置页使用）+ 同形状的 TS 类型 + `resolveConfig`（把可能是 volatile 引用的字段解成普通对象，全插件只读这一个 `resolved`）。运行时读取的字段标 `.volatile()`（baseUrl/apiKeyEnv/超时/轮询/媒体上限/skillsDir/mediaHost/comfyuiDirs），`dataDir`/`maxAssets`/`outputDir` 保持普通字段（改了会重启插件）；需 schemastery ≥ 3.18.4。`outputDir` 只走 cordis.yml，留空时删除资产会自行推断 ComfyUI 输出目录。`skillsDir` 指定技能包根目录（留空 = `<dataDir>/skills`，必须绝对路径，相对值忽略；运行时经 getter 现读，设置页改完即生效，但不会自动搬走已有目录）。`comfyuiDirs`（字符串数组，可多填）记录用户本机 ComfyUI 安装目录（目录映射/多实例/便携版），Agent 据此定位 models、自定义节点、TTS 音色库等文件；变更经 `onChange` 热同步到 runtime 配置，无需重启。 |
| `comfyui.ts` | ComfyUI HTTP 客户端：queuePrompt / history / queue / jobs / userdata / object_info / view / upload / interrupt 等，加上 `collectMedia`、`mediaProxyUrl`、`waitForCompletion`。上传有两个入口：`uploadFile` 转发浏览器原样的 multipart，`uploadMedia` 用 FormData 包好字节再传（`/upload/image` 只吃 multipart，裸 body 会 400）。模块级 `CLIENT_ID` 让排队与 WS 进度同源。路由前缀按 baseUrl 自学习（模块级 `routePrefix`）：裸路由 404 时重试 `/api` 前缀，成功就记住——兼容只转发 `/api/*` 的反代（comfy-api-proxy，#6）；`listUserData` 在 `/v2/userdata` 404 时回退 v1 `/userdata?dir=…&recurse=true&full_info=true`（#5）。 |
| `store.ts` | 持久化：工作流库、资产索引、加载区加载位（`LoadSlot[]`，`null` = 空位，兼容旧的单图格式）、媒体尺寸、上传哈希、任务跟踪，均为 dataDir 下的 JSON 文件；`skillsRoot` 指向技能包目录树，`updateWorkflowSkill` 单独维护 `skillDir` / `requireSkill`（普通保存不碰这两个字段）。 |
| `queue.ts` | `QueueTracker`：记住本插件提交过的 prompt，`sweep()` 在读取（queue/assets 路由）时把完成的运行归档进资产索引；无后台定时器。 |
| `progress.ts` | `ProgressTracker`：连 ComfyUI `/ws` 收 `progress` 事件，best-effort（远端鉴权代理下可能无进度），断线重连直到 dispose。 |
| `analyze.ts` | 画布分析：groups 无执行语义，可执行单元 = 激活节点的连通分量，忽略 bypass(mode 4) 与悬空 UI 节点；bypass 节点按与 `convert.ts` 相同的直通规则（输出跟随**第一个**有连线的输入）连接上下游，否则分量会被切断、「主流程」漏掉上游（#8）。 |
| `graph.ts` | 图的公共预处理：`normalizeLinks`（位置行 / v0.4 对象行两种 links 统一成 `[id, origin, slot, target, slot, type]`）；`resolveVirtualLinks` 在分析与转换**之前**把虚拟节点改线——KJNodes `SetNode`/`GetNode` 按名称配对（同名取 `order` 小于 getter 的最大者），rgthree `Mute / Bypass Relay/Repeater` 的模式传播连线直接丢弃（#8）；link id 保持不变，节点 `inputs[].link` 引用仍有效。 |
| `convert.ts` | 图 → API 转换：链接变 `[String(nodeId), slot]`，widgets_values 按图节点自身 `inputs` 顺序对齐，Reroute/bypass 直通，无法表达的节点报错。产物做引用完整性检查（所有 `[id, slot]` 必须指向同一产物内的节点）。`COMFY_DYNAMICCOMBO_V3` 保持**扁平**（见契约 15），并校验所选 key 在可选项内；`flattenDynamicCombos` 在排队时把 0.2.0–0.5.1 存下的 `{ key, inputs }` 旧形状摊平。 |
| `params.ts` | 可调参数：自动识别（提示词/分辨率/步数/种子/时长/宽高比/加载节点）+ 用户高级参数；`numberSpecOf` 从 object_info 读数字输入的声明类型（INT/FLOAT + min/max/step），存进参数的 `numberKind`；`applyWorkflowParameters` 在运行时写回工作流（int 四舍五入、bool 归一化 `"true"`/`0` 这类写法、连线输入与加载参数不被空默认值覆盖、未传值的加载参数按加载位顺序取用）；`refreshParameterMetadata` 按最新 object_info 重算**已有**参数的 options / numberKind / min/max/step（参数集合与默认值一个不动，供快照刷新路由/工具用，返回 `{ parameters, changed }`）。可选支路：参数带 `prune`（`nodes` + 可选 `passthrough`）时，空值（未传且默认空 / 显式 `''` / 纯空白）把这些节点从产物里剪掉——消费方要么接到被删节点的直通输入（守卫/LoRA 这类链中节点），要么删掉那个输入键（可选/autogrow 输入），删键后的 autogrow 组（`group.name_<i>`）重新连续编号；`pruneWorkflowNodes` 末尾跑 `danglingReferences`（与 convert.ts 同款引用完整性检查），不闭合就抛错。`mirrors` 把同一个值写进多个输入（宽高同时写 ImageScale），`loadArea: false` 不从加载区取默认素材，`matchSize: false` 不让该图尺寸成为默认宽高；`required` 的空值在加载参数跳过逻辑之前就报错。 |
| `templates.ts` | 内置 API 模板：`txt2img`、`img2img`（核心节点）、`video`（Wan 2.1，需 ComfyUI-WanVideoWrapper）、`h3_t2v`（MiniMax H3 文生视频，核心节点 ≥ 0.39，10Eros TURBO，**不挂 LoRA**，seconds 提示上限 `H3_MAX_SECONDS` = 15.1 → 362 帧，训练范围 5–15 秒）、`h3_r2v`（MiniMax H3 参考生视频：`MiniMaxH3ReferenceToVideo` + 最多三条 `MiniMaxH3AddGuide`——续接 30–35 / 首帧 40–42 / 尾帧 50–52，ref 图 20–22、音色 23、可选 LoRA 15；所有可选位靠 `prune` 剪除，宽高经 `mirrors` 同步到三个 ImageScale；默认 480×864、5 秒、8 步）。带 `parameters` 的模板按参数名驱动（prompt/width/height/seconds/seed/steps）。`h3Frames(秒)` 复刻参考脚本：`x=max(5, round(秒×24))`，Python 的 round 是**银行家舍入**、`%` 非负，JS 必须显式处理（1s→39、3s→73、5s→124、0.9375s→22）。 |
| `jobs.ts` | 0.2 后台任务契约：`owner` 是 **session id（`exec.agent.id`）** 不是 Agent 对象；结果放 `outcome.result`（不是 `output`）；`job_kill` → `cancel()` 立即中止等待并只取消本 prompt，远端取消返回后即 settle `killed`；`updateProgress(line)` 只在内容变化时推送。 |
| `library.ts` | 对话里的库编辑：`draftForSave`（三选一来源：`prompt_id` 的运行记录 / 模板 / API JSON；运行记录保留命名参数，所用值成为默认值，随机 seed 保持随机）、`draftForUpdate`（替换工作流时保留仍然适用的参数）、`applyDefaults`（给 seed 默认值即固定它）；保存前用 `applyWorkflowParameters` 空跑校验。 |
| `archive.ts` | 本机归档 `RunArchive`：`<archiveDir>/<promptId>/meta.json` 在**提交时**写下（完整 API prompt、参数定义、实际取值含随机 seed、所有 seed 输入、状态），完成后经 `/view` 流式下载（`.part`+rename、sha256、同一 prompt 并发只下一次）；`resolveFile` 只放行 UUID 目录 + meta.json 列出的文件名 + 非符号链接 + containment；`serveLocalFile` 支持单 Range/206/416/HEAD；`findByRef` 让旧的 `/comfyui/media` URL 也命中本地。 |
| `route-guard.ts` | 所有 `/comfyui/*` 路由的信任栅栏（照 DSH `isTrustedApiRequest` / dsh-image-gen）：Host 必须回环、拒绝 `Sec-Fetch-Site: cross-site`、Origin 必须与 Host 一致；宿主有 `connection` 服务时再过 `connection.admit()`（DSH 登录 cookie）。 |
| `tools.ts` | 模型侧工具定义与注册 + `ComfyUIRuntime` 接口 + 后台任务/结果回显。 |
| `routes.ts` | 浏览器侧同源 HTTP 路由（面板与设置页的全部数据来源），写操作强制同源。 |
| `proxy.ts` | `/comfyui/media` 媒体代理：**先查本地归档**，再按 `file`+`subfolder`+`type` 转发 `/view`；`checkViewRef` 只放行 `type ∈ {output,input,temp}`、裸文件名、无 `..`/绝对路径/反斜杠/NUL 的相对 subfolder，不合法的请求不会到达 ComfyUI。旧的 prompt/node/index 链接先查归档，再查 history，再回落资产索引。 |
| `http.ts` | 路由小工具：`sendJson` / `readJsonBody` / `readRawBody` / `sameOrigin` / `errorMessage`。 |
| `host-hint.ts` | （0.6.0 起基本闲置）记住浏览器访问用的 origin。媒体 URL 现在一律是同源相对路径（`proxyBase()` 返回 `''`），`mediaHost` 配置不再生效，index.html 的 ping 注入已删除。 |
| `skillpack.ts` | 每个工作流可挂一个**技能包**：`<dataDir>/skills/<slug>/` 下的 `SKILL.md` + **任意一层子目录**（`SKILL_PRESET_DIRS` 只是面板下拉的建议名：references/scripts/assets/templates/agents/examples/prompts/commands/docs/data，用户与 Agent 都可以自建目录，`parseSkillDir` 按 `DIR_NAME` 文法校验）。`info()` 从磁盘枚举真实目录（含空目录，走 `dirs` 字段），`makeDir` 建空目录。`SkillPackStore` 管文件读写/重命名/删除并守住路径（文件名文法 + 目录名文法 + `relative()` containment + 扩展名白名单）；**尺寸上限按文件类型而不是按目录**：文本 256KB、二进制（`ASSET_EXTENSIONS`）4MB、每包 20MB/2000 文件（字节上限才是存储保护，文件数只挡病态噪音——真实的外部批量拷贝包如音乐模板库可达上千个小文件，必须完整走通导出→导入回环）；`splitFrontmatter`/`joinFrontmatter` 只认 `summary:` 一个键（不引 YAML 依赖）；`writeBytes`/`readBytes` 走字节，导入的图片与文本共用同一套上限检查（文本 256KB、`assets/` 4MB、每包 20MB/2000 文件），`defaultBucketFor` 按扩展名决定导入落点（md/txt/json/yaml→references、脚本→scripts、图片/csv→assets，导入时可用 `bucket` 显式覆盖）；`createWorkflowSkillPacks` 把目录树绑到工作流库，供 tools 与 routes 共用。slug = `<安全名>-<id前8位>`，工作流改名不迁目录。 |
| `upload.ts` | `comfyui_upload` 的校验与流程：扩展名白名单（`UPLOAD_EXTENSIONS`，只收媒体）、`MAX_UPLOAD_BYTES`（200MB，先 `stat` 再读）、普通文件检查、`parseUploadSubfolder`（单层 `[A-Za-z0-9_-]{1,64}`）、`resolveUploadPath`（绝对路径原样；相对路径只按会话 cwd `exec.agent.session.header.cwd` 解析，没有 cwd 就拒绝）、`imageSizeOf`（PNG/GIF/WebP/JPEG 头部读尺寸，不解码）；`uploadLocalFile` 经 `runtime.uploadInput` 上传并把图片尺寸记进 `saveMediaSize`（键 = 返回的 `subfolder/name`）。 |
| `skill.ts` | 配套 skill `dsh-comfyui-workflows`（runtime，rank 250）：另有「参考生视频 h3_r2v」一节（comfyui_upload → 参数 → 六段式提示词 → 关键帧 / 续接）；两个主题的区分、画布分析规则、图→API 技术规则、参数与加载区说明、省 token 的运行流程；另含「工作流技能包」（三级披露：list 里的一行摘要 → `action: skill` 取正文 → 正文点名时才读 references 里的单个文件；必读工作流不读会被 run 拒绝）、「本机环境」（先跑 `comfyui_workflow list` 读 `env`，不要反复问用户目录）与「TTS-Audio-Suite 音色库查询」三节（统一章节，正确流程 = **先刷新快照再查询**：刷新用 `action: refresh` / refresh-params 路由按最新 object_info 重算写回 workflows.json 里保存时拷贝的 options，`?refresh=1` 只重扫 TTS 进程缓存；查询分 HTTP 接口 / 文件系统两种方案）。 |
| `transfer.ts` | 工作流**预设导出/导入**（fflate 打 zip）：`buildExportPackage` 把选中工作流连同 `parameters`/`tags`/`requireSkill`/技能包字节打成一个 `.zip`（`preset.json` 清单 + `skills/<原id>/` 文件区）；`analyzeImportPackage` 只解清单列出可导入项（含逐项告警，不写盘）；`applyImportPackage` 把选中项**创建为新工作流**（新 `randomUUID`，重名追加 `（导入）`，技能包经 `enable` + `importFiles` 批量写（限额只查一次；逐文件写每次全量枚举包目录，千文件包是 O(n²) 文件系统调用、表现为导入假死数分钟）+ `makeDir` 原路还原，全部重过文法与尺寸校验）。安全姿态：文件系统路径从不取自 zip 条目名（落盘目录由 `skillSlug(新名, 新id)` 现生成），包内相对路径过 `parseSkillPath`，解压有单条目/总量上限，`version` 主版本更新拒绝导入。选择用**清单下标**（analyze/apply 解析同一份字节，下标稳定），避免对任意包内 id 做转义。 |

### Agent 工具（`registerComfyUITools`）

| 工具 | 作用 |
| --- | --- |
| `comfyui_run` | 提交 `workflow`（API 格式）或 `template`（txt2img / img2img / video / h3_t2v / h3_r2v），`inputs` 按节点 id 覆盖输入，带参数的模板用 `parameters` 按名字传（`inputs` 覆盖了某个参数的输入时，该参数本次不生效）；`mode: sync`（默认，返回媒体）/ `async`（后台任务，卡片显示进度并播放）。两种模式与 `comfyui_workflow run` 共用 `launch()`：排队 → 等待 → `runtime.complete()`（收集媒体 + 归档）。 |
| `comfyui_object_info` | 列出服务器支持的节点定义，可用 `filter` 按类名子串收窄。 |
| `comfyui_upload` | 把本机媒体文件（`path`：绝对路径或相对会话工作目录）上传到 ComfyUI input 目录，可选 `subfolder`（单层）/ `overwrite`（默认 false，同名会被服务器改名）；返回 `{ ref, name, subfolder, type, kind, bytes, size? }`，`ref` 直接填 LoadImage.image / LoadAudio.audio / LoadVideo.file 或模板媒体参数。走 `runtime.uploadInput`（`client.uploadMedia` 的 multipart），校验见 `upload.ts`。 |
| `comfyui_skill` | 读写某个工作流的技能包（Agent 自治维护文档）：`list` / `read` / `write` / `append` / `mkdir` / `rename` / `delete` / `enable` / `require`，都要带 `workflow_id`。`read` 到 `SKILL.md` 同样解除 `requireSkill` 拦截（与 `comfyui_workflow action: skill` 共用那个 WeakMap）。**没有 destroy**：整包删除是用户在面板上的决定。单次 `read` 超过 40k 字符会截断。 |
| `comfyui_workflow` | `action: list` 列出库里可运行工作流（参数清单含 `numberKind` 整数/小数标注；挂了技能包的多一个 `skill` 字段：一句摘要 + 文件数 + 是否必读，**只有这一行进上下文**）+ ComfyUI 端图工作流（含 `extracted` / `derived`）+ `loadArea`（加载位数量与已放入的素材，Agent 据此知道用户加载了什么）+ `env`（**每次调用现读**：`baseUrl` 服务器地址 + `comfyuiDirs` 用户配置的本机 ComfyUI 目录，供定位文件/音色库用；改动契约，勿改形状）；`action: run` 按 id 运行并传 `parameters` 覆盖；`action: save`（`name` + `prompt_id`/`template`/`workflow` 三选一，`parameters` 设默认值）/ `update`（`id` + 新名称/描述/标签/默认值/替换工作流）/ `delete`（只删库条目，技能包目录保留）；list 另附带参数的内置模板一行；`action: skill` 按 id 返回该工作流技能包的 `SKILL.md` 正文 + 绝对目录 + 文件清单（渲染成 `<skill_content>` 块；读过才解除 `requireSkill` 拦截）；`action: get` 仅供诊断（输出完整 JSON，很费 token）；`action: refresh` 按 id 重算该工作流的参数快照并写回（先强制 TTS 音色库重扫 `?refresh=1` 再读最新 object_info，只更新 options / numberKind / min/max/step 等派生字段，**参数集合与用户手加的高级参数原样保留**，返回 `changed` 清单——音色库/节点定义变更后跑它，否则 run 对新音色会报"not one of the allowed options"）。 |

### 浏览器路由（全部挂在 `webServer` 子 fiber 上）

`/comfyui/` 前缀，写操作要求同源：

- 配置与探活：`ping`(GET)、`config`(GET 读脱敏，含 `skillsDir` 与实际生效的 `skillsRoot` / POST 写)、`test`(POST 连接探测)
- 工作流库：`workflows`(GET/POST)、`workflows/recognize`(POST)、`workflows/input-options`(POST)、`workflows/refresh-params`(POST，body `{ id }`，按最新 object_info 重算该工作流参数快照并写回——先强制 TTS 音色库 `?refresh=1` 重扫，只更新派生字段、保留参数集合，返回 `{ ok, parameters, changed }`)、`workflows/skill`(GET 读技能包清单（含 `dirs` 与 `presetDirs`） / 带 `path` 读单个文件，SKILL.md 额外返回拆好的 `summary`+`body`；POST 动作 `enable` / `disable` / `destroy` / `require` / `mkdir` / `write` / `rename` / `delete`)、`workflows/skill/import`(POST，裸字节 body + query `id`/`name`/可选 `bucket`，落点由扩展名决定，返回最终 `path`)、`workflows/skill/raw`(GET/HEAD，按 `id`+`path` 原样吐字节，带 `nosniff`，供面板预览图片)、`workflows/skill/reveal`(POST，body `{ id }`，在 **DSH 所在机器**上用 explorer/open/xdg-open 打开技能包目录——全项目唯一会拉起本地进程的路由：目录取自 pack store 而非请求、`spawn` 传参数数组不走 shell、要求同源；Agent 工具**没有**这个能力)、`workflows/delete`(POST，body 可带 `deleteSkill: true` 一并销毁技能包)、`workflows/run`(POST)、`workflows/export`(POST，body 收 JSON `{ ids }` **或** urlencoded 表单（`ids` 重复字段）——面板用隐藏 form 原生提交下载：fetch→blob→objectURL 的 JS 下载链路在真实环境产出过 0 字节文件，故弃用；成功时写 `ctx.logger.info` 审计日志（数量+名单+警告，用于排查下载管理器混淆文件），并把打包事实（at/count/names/warnings）存进挂载期闭包变量供 `export/last`(GET) 读回——表单下载的响应体对 JS 不可见，面板靠它向用户报告**实际**打包内容而非勾选框以为的内容；另注册 `export/<文件名>`(**prefix** 路由，GET，`ids` 走 query 重复参数，文件名客户端生成、服务端按 `^dsh-comfyui-presets-[0-9A-Za-z-]+\.zip$` 白名单后用作 content-disposition——面板用 GET form 提交下载：本机的下载管理器会接管/改名/自行重取 POST 下载（"skills 时有时无"的元凶），GET + 文件名入路径使保存名恒等于回执名、重取也得到同 ids 的真实导出)；见 `transfer.ts`)、`workflows/import/analyze`(POST，裸字节 = 预设包，只解析列清单不写盘)、`workflows/import/apply`(POST，裸字节 + query `select=<清单下标逗号列表>`，把选中项创建为新工作流并还原技能包)
- ComfyUI 端图工作流：`comfy-workflows`(GET)、`comfy-workflows/analyze`(GET)、`comfy-workflows/extract`(POST)
- 加载区与媒体：`loadarea`(GET，返回全部加载位)、`current-image`(POST，动作 `pick` / `addSlot` / `clear` / `removeSlot`)、`upload`(POST)、`media-size`(POST)、`media-lookup`(POST)、`media-hash`(POST)、`media`(GET/HEAD，见 `proxy.ts`)
- 本机归档：`archive/<promptId>/<文件名>`(**prefix**，GET/HEAD，Range)
- 资产与队列：`assets`(GET)、`assets/delete`(POST，删记录 + 删输出文件)、`queue`(GET)、`jobs`(GET)、`jobs/media`(GET，**先读本地归档**，命中就不连 ComfyUI；完成时经 `runtime.complete` 归档后返回本地 URL；排队中附 `progress`；history 里没有时查 `/queue` 区分 `queued`（仍在排队）与 `unknown`（已被清掉），后台任务卡片只对 `unknown` 计超时并尝试从资产索引恢复)、`jobs/actions`(POST；`interrupt` 必须带 `promptId`，走 `cancelOwn`)

## 客户端模块（`src/client/`，React + slots）

`index.ts` 通过 `ctx.slots.inject` 注册五处贡献（turnTail 那处另在 `ctx.inject(['uiConversation'])` 子 fiber 里注册一个 ui-conversation 事件 Definition）：

| 槽位 | 内容 |
| --- | --- |
| `tool.call.toolview`（keys `comfyui_run` / `comfyui_workflow`） | `card.tsx`：对话内媒体墙卡片（生成中状态 / 结果 / 点击放大）。**注意**：DSH 0.2 把已完成轮次的所有工具调用折进「思考过程」分组，这张卡只在展开后可见 |
| `conversation.chat.turnTail`（id `dsh-comfyui-media`） | `turn-tail.tsx` + `turn-media.ts`：在该轮**收尾回复下方**（折叠分组之外，与内置 schedule_create 卡同一路线）复用 `ResultCard` / `BackgroundCard` 显示本轮生成结果。数据来自 `turnMediaDefinition`：按 Turn 累积 `comfyui_run` / `comfyui_workflow run` 的 tool/result `meta`（只认 `surfaceOp: append`，压缩替换副本不重复出卡），全部取自会话日志，回放即可重现 |
| `settings.section`（id `comfyui`） | `settings.tsx`：设置页，读写 `/comfyui/config`，`/comfyui/test` 探测，含 zh/en 界面语言切换 |
| `shell.overlay`（id `comfyui.panel`） | `panel.tsx`：浮动面板，三个页签 **工作流 / 资产 / 队列**，可拖拽缩放，几何信息存 localStorage（`clampPos`/`healGeom` 在拖拽、窗口缩放、换显示器、开闭面板时把标题栏钳在视口内，永不失去抓取面；标题栏「↺」按钮复位位置与大小、清 localStorage）；工作流页底部是多加载位的加载区；技能包编辑器支持「刷新」重新读盘与子目录折叠；资产页卡片带删除确认框 |
| `conversation.session.header.actions`（id `comfyui`） | `trigger.tsx`：会话头部按钮，开关面板 |

配套：`panel-store.ts`（面板开关/页签的模块级 store + `useSyncExternalStore`）、`api.ts`（同源 fetch 封装）、`lightbox.tsx`（共享灯箱）、`i18n.ts`（zh/en 词典，语言存 localStorage，不跟随 host locale）、`styles.ts`（一次性注入样式，颜色取 host 主题 token `--dsw-alias-*`）。

客户端 bundle 由 `tsdown.config.mjs` 产出：CJS + `window.__ModuleLoader__.load({ id, factory })` banner/footer；`PLATFORM_EXTERNALS` 里的模块（react、cordis、dsh-client-ui-*）**必须保持 external**，其余全部内联。

## 运行时数据文件

默认 `$DSH_HOME/data/dsh-comfyui/`（未设则 `~/.dsh/data/dsh-comfyui/`），可用配置 `dataDir` 覆盖：

`workflows.json`（工作流库）、`assets.json`（资产索引）、`current-image.json`（加载区加载位列表，`null` = 空位）、`media-sizes.json`（上传图像素尺寸）、`media-hashes.json`（内容哈希 → 文件名，去重）、`tracked.json`（本插件提交的任务）、`archive/<promptId>/`（本机归档：`meta.json` + 媒体，可用 `archiveDir` 挪走，不设容量上限，删资产不删归档）；另有 `skills/<slug>/` 子目录树（位置可用配置 `skillsDir` 挪到别处）存放各工作流的技能包（`SKILL.md` + `references/` + `scripts/` + `assets/`），由面板编辑、`comfyui_workflow action: skill` 读取。

## 必须遵守的契约（踩过坑）

1. **服务注入**：任何通过 `ctx.<服务名>` 访问的 cordis 服务都必须出现在 `export const inject` 里，否则 cordis 在 boot 期抛 `cannot get property "<name>" without inject`，报错点远离肇事代码。可选服务（`webServer` / `settings` / `credentials` / `skills`）**不要**进 `inject`，改用 `ctx.get(...)` 或 `ctx.inject([...], cb)` 子 fiber，让插件在无该服务的 headless 宿主上优雅降级。
2. **注入会话的消息必须符合 host 的 `Message` 契约**：`id`（UUID 非空）+ `role` + `content` + `source` 四者齐全。缺 `id` 会写坏 append-only 会话日志，加载时 `assertMessageEventShape` 让 **整个会话报废**。见 `docs/INCIDENTS.md`；相关代码在 `src/tools.ts` 的 `echoCompletion`（带 CONTRACT 注释）。新增任何"向会话/模型注入内容"的路径后，用 `scripts/analyze-sessions.mjs` 复检会话日志。
3. **API 工作流的节点引用必须是字符串**：`[String(nodeId), slot]`，服务端按字符串键字典查找，数字会 KeyError。
4. **生命周期**：所有注册（工具、路由、代理、样式、WS）都要走 `ctx.effect` / 子 fiber 并返回 disposer，随插件卸载干净收回；不要留裸定时器（`queue.sweep` 就是为此改成"读时清扫"）。
5. **视频/音频工作流一律 `mode: "async"`**：同步等待会超时中断。
6. **不要把完整工作流 JSON 输出到回复里**：运行走 `comfyui_workflow run { id, parameters }`，`action: get` 只用于诊断。
7. **媒体 URL 必须按文件寻址**（`file` + `subfolder` + `type`），不要依赖 ComfyUI 的 `/history`：history 是内存态，ComfyUI 重启或用户点"清空历史"就没了，按 prompt/node/index 生成的链接会全部 404，面板显示"源文件已被 ComfyUI 清理"，而文件其实还在 output 目录。`collectMedia` 走 `mediaProxyUrl`，历史记录里的旧链接由 `/comfyui/assets`、`/comfyui/loadarea` 的 `healAssetUrls` 与代理的资产索引回落救回。
8. **参数写回要区分"没传"和"传了空值"**：`applyWorkflowParameters` 默认会把 `default` 写回节点输入，所以空默认值（`default: ''`）在未显式传值时必须跳过两类参数——暴露在**连线输入**上的高级参数（面板已不再提供这类输入，但库里可能有历史参数，写回会冲掉连线）和**加载参数**（否则清空节点的文件名，运行直接失败）。例外是 `upload: 'media'` 参考位，那里空值的语义就是"移除该位"。
9. **加载节点的输入键要从 object_info 读**（`loaderInputKey` 找带 `*_upload` 标记的输入），不要写死：`LoadImage` 是 `image`，`LoadVideo` 是 **`file`**，`LoadAudio` 是 `audio`——写死 `video` 会让整类媒体在加载区里凭空消失。文件类型按扩展名判定（同一个 `.mp4` 会同时出现在 LoadVideo 与 LoadAudio 的候选列表里）。
10. **删除资产只能自己动文件系统**：ComfyUI 全服务端唯一的 DELETE 路由是 `/userdata/{file}`（用户目录），0.32 的 `DELETE /api/assets/{uuid}` 需 `--enable-assets` 且源码里 `delete_content_if_orphan=False`——只软删数据库引用，**文件保留**。所以 `assets/delete` 路由用 `resolveOutputDir`（配置 `outputDir` 优先，否则从记录里的 `fullpath` 反推）+ `unlink`；务必保留那道 `relative()` 路径穿越检查，`subfolder` 是 ComfyUI 给的、不可信。输出目录不可达时降级为只删索引记录。
11. **加载区是一组加载位而不是一张图**：`store.loadSlots()` 返回 `Array<CurrentImage | null>`（`null` = 用户加过但还没放素材的空位），已放入的按顺序填进未显式传值的加载参数（同类型匹配）。加载位数量与内容通过 `comfyui_workflow action: list` 的 `loadArea` 字段暴露给 Agent，别让模型去猜或反复问用户。

## 辅助脚本（`scripts/`，不随 npm 包发布）

| 脚本 | 用途 |
| --- | --- |
| `analyze-sessions.mjs` | 只读扫描会话日志（zstd 逐帧解压），找缺 `id` 的 message 事件——新增任何"向会话注入消息"的路径后必须跑 |
| `inspect-tool-meta.mjs` | 按 promptId 查会话日志里的 tool-result meta，排查媒体回显 |
| `test-store-params.mjs` | 离线自测：参数经 store 保存 → 重载 → 编辑后仍保留（需先 `npm run build`，它导入 `lib/store.js`） |
| `test-skillpack.mjs` | 离线自测：技能包 slug / frontmatter / 文件 CRUD / 尺寸上限 / 路径穿越防护 / 工作流绑定（需先 `npm run build`，它导入 `lib/skillpack.js`） |
| `test-convert.mjs` | 离线自测：画布分析与图→API 转换——DynamicCombo 扁平（#10）、bypass 直通与越界引用拒绝（#8）、Set/Get 按名配对（作用域、链式、直通输出、缺 setter）、rgthree Relay/Repeater 连线丢弃（#8）（需先 `npm run build`，它导入 `lib/analyze.js`、`lib/convert.js`） |
| `test-transfer.mjs` | 离线自测：预设导出→分析→导入回环（参数/技能包字节/空目录/requireSkill 逐项断言）、重名 `（导入）` 后缀、zip-slip 防护、格式与版本拒绝（需先 `npm run build`，它导入 `lib/transfer.js`） |
| `run-cg-portrait.mjs` / `run-16x9.mjs` | 真机冒烟：打同源路由（默认 `http://127.0.0.1:3080`）跑一次带自定义 prompt 的工作流，需 DSH + ComfyUI 都在运行 |

12. **技能包是"按需披露"，不是常驻 skill**：per-workflow 的技能包**不注册进 `ctx.skills`**。宿主的 skill 目录（`dsh-tool-skill`）会把每个 model-invocable skill 无条件写进一条常驻消息，`modelInvocable: false` 的又会被 `skill` 工具拒绝加载——两头都不满足"用到才可见"。所以披露阶梯挂在 `comfyui_workflow` 上：list 一行摘要 → `action: skill` 取正文 → 模型自己用文件工具读 references。常驻的 `dsh-comfyui-workflows` skill 只负责放那条路由规则。**别把技能包改成 `ctx.skills.register`**，那会让每个工作流都在每轮请求里收费。
13. **技能包的路径全部不可信**：`path` 来自浏览器、`skillDir` 来自 workflows.json，两者都要过 `parseSkillPath`（文件名文法 + 桶白名单 + 扩展名白名单）再过 `relative()` containment 检查，和 `assets/delete` 同款。根目录只放 `SKILL.md`（它是 `action: skill` 的正文来源，禁改名禁删）。导入路径同理：上传文件名先剥到 base name（`/` 与 `\` 都剥）再进同一套校验，浏览器给的路径一律不当路径用。文本的尺寸上限不是防滥用而是防上下文爆炸（SKILL.md 会整份进模型），`assets/` 的上限才是防滥用。
14. **删工作流不默认删技能包**：技能包是用户手写的文档，没有别的副本。`workflows/delete` 只在 body 显式带 `deleteSkill: true` 时销毁目录，面板在有技能包时会先问"一起删/只删工作流"。停用（`disable`）同理，只清 `skillDir` 字段、留着目录。

15. **DynamicCombo V3 在 API prompt 里是扁平的**：主输入的值 = 选中项的 key 字符串，子控件以 `master.sub` 为同级键（如 `codec: "auto"`、`aspect_ratio.size`）。服务端自己重组嵌套结构；包成 `{ key, inputs }` 会匹配不上、输入被丢弃，节点在 `execute()` 才报 `missing ... 'codec'`（#10，视频要白跑整轮才发现）。`params.ts` 的 combo 子参数也按扁平键工作。

16. **归档在提交时写 meta，在完成时下载，播放先本地**：`runtime.queue` 提交成功后立刻 `archive.recordSubmission`；所有完成路径（sync、后台任务、`jobs/media`、`sweep`）都走 `runtime.complete` → `archive.archive`（幂等、去重）。卡片优先 `/comfyui/archive/...`，失败才回落 `proxyUrl`。ComfyUI 下线后历史卡片能播，靠的就是这条链——别绕过 `runtime.complete` 直接 `collectMedia`。
17. **只取消自己的任务**：一律 `client.cancelOwn(promptId)`（v0.39 `POST /api/jobs/{id}/cancel`，原子；旧服务器回落 `/queue {delete}` / `/interrupt {prompt_id}`）。**禁止**不带 id 的 `/interrupt`——它会中断别人正在跑的任务。`waitForCompletion` 在 abort（包括睡眠中 abort）时取消本 prompt；后台任务传 `cancelOnAbort: false` 由任务自己的 `cancelRemote` 取消，保证每次 kill 只发一次取消。
18. **所有路由先过 `route-guard`**（读也一样）：`mountComfyUIRoutes` / `mountComfyUIProxy` 收到的 `register` 已经包了 guard，新增路由照常 `webServer.register` 即可；不要另起一个绕过 guard 的注册。媒体与归档路径一律当不可信输入：归档只认 meta.json 列出的文件，`/view` 引用过 `checkViewRef`。
19. **连不上 ComfyUI 的错误**由 `ComfyUIClient.reach()` 统一生成：`无法连接 ComfyUI（baseUrl）：原因。<unreachableHint>`（`code: 'unreachable'`）。HTTP 错误状态不改写。插件**不包含**切换远端模式的功能，提示文字可配置。
20. **成片要出现在对话主流程，靠 turnTail 而不是工具卡**：DSH 0.2 的 ui-chat 把一个已完成 Turn 的所有 tool-call 折进「思考过程」分组（`INDEPENDENT` 之外的节点一律进组），工具卡在折叠后不可见；Markdown 也没有视频形式。所以结果靠 `conversation.chat.turnTail` 渲染在收尾回复下方。新增会产出媒体的工具或改 meta 形状时，同步 `turn-media.ts` 的 `TOOL_NAMES` / `entryFromMeta` 与 `tests/turn-media.spec.ts`。

21. **可选媒体位用 `prune` 剪掉整条支路，不要留空的加载节点**：ComfyUI 会校验所有喂给输出的节点，`LoadImage { image: '' }` 让整条 prompt 被拒。模板里可选的参考图/关键帧/音色/LoRA 一律声明 `prune`（链中节点给 `passthrough`），新增此类模板时在测试里对"全空"与"全满"两种产物都断言 `danglingReferences(...)` 为空。`upload: 'media'` 参考位（单个输入里的 JSON 数组）是另一套机制，不能用来剪节点。

## 代码风格约定

- ESM + NodeNext：host 侧相对导入**必须带 `.js` 后缀**（`./store.js`）。客户端侧由打包器解析，现有代码 `.ts` / `.tsx`（`allowImportingTsExtensions`）与 `.js` 后缀混用（如 `./lightbox.js`），两种都能构建，改动时跟随所在文件的写法即可。
- `strict` + `noUncheckedIndexedAccess` 全开：索引访问结果按 `T | undefined` 处理；判空一律显式 `=== undefined` / `!== undefined`，不用真值判断（现有代码通篇如此）。
- 每个文件顶部有一段块注释说明该模块"为什么存在"，新增文件保持同样风格；关键取舍（如为什么不用 WS 拿结果、为什么 sweep 放在读路径）就地写进注释。
- 客户端不用 JSX 语法而是 `createElement as h` 调用，样式集中在 `styles.ts` 的单个 CSS 字符串里，颜色只用 host 主题变量 `--dsw-alias-*`。
- 面向用户/Agent 的文案是中文（skill、面板、错误提示），代码注释与标识符是英文。

## 相关文档

| 文件 | 内容 |
| --- | --- |
| `README.md` / `README.en.md` | 用户文档（中 / 英，npm 首页渲染 `README.md`）。改功能时同步更新两份的功能列表与截图。 |
| `DEVELOPMENT.md` | 维护者笔记：版本状态、时间线、辅助脚本、git / npm 发布流程、运行时数据文件。**本地文件，不入版本库**。 |
| `docs/INCIDENTS.md` | 事故复盘：注入消息缺 `id` 写坏会话日志导致整个会话无法加载。 |
| `AWESOME.md` | 上架 awesome-dsh-plugin / dshmarket 的材料与核对清单。 |

改动时的同步义务：**改功能** → 两份 README + `src/skill.ts`；**改结构 / 新增模块、路由、工具或契约** → 本文件；**发版** → `DEVELOPMENT.md` 的版本表与时间线。
