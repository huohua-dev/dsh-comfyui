import { TEMPLATES, findTemplate, cloneWorkflow, cloneParameters, applyTemplateInputs } from './templates.js';
import { refreshParameterMetadata } from './params.js';
import { SKILL_MAIN, joinFrontmatter } from './skillpack.js';
import { ownerSessionOf, startGenerationJob } from './jobs.js';
import { describeParameters, draftForSave, draftForUpdate } from './library.js';
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS, uploadLocalFile } from './upload.js';
/** The calling session's workspace (`exec.agent.session.header.cwd`, as DSH's own file tools read it). */
function sessionCwd(exec) {
    const cwd = exec.agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}
/**
 * Which skill packs each agent has already read, for the `requireSkill` gate.
 *
 * Keyed by the live `Agent` handle the tools registry passes as `exec.agent`:
 * one per session and stable across turns, so a WeakMap entry lives exactly as
 * long as the session and needs no eviction pass. An execution without an
 * agent (a direct internal call) is never gated.
 */
const skillPackReads = new WeakMap();
/** Upper bound on the text one `comfyui_skill action: read` returns. The pack
 * caps files at 256 KB, which is still far more than a tool result should
 * inject in one go; a longer file comes back truncated with a marker. */
const MAX_TOOL_READ_CHARS = 40_000;
function markSkillPackRead(agent, workflowId) {
    if (typeof agent !== 'object' || agent === null)
        return;
    const seen = skillPackReads.get(agent);
    if (seen === undefined)
        skillPackReads.set(agent, new Set([workflowId]));
    else
        seen.add(workflowId);
}
function hasReadSkillPack(agent, workflowId) {
    if (typeof agent !== 'object' || agent === null)
        return true;
    return skillPackReads.get(agent)?.has(workflowId) === true;
}
const TOOL_TIMEOUT_MS = 3_600_000;
function missing(args, name) {
    return args[name] === undefined || args[name] === null;
}
function requireOneOf(args, names) {
    const present = names.filter((name) => !missing(args, name));
    if (present.length === 0)
        return `exactly one of ${names.join(', ')} is required`;
    if (present.length > 1)
        return `only one of ${names.join(', ')} may be given`;
    return undefined;
}
/**
 * Resolve comfyui_run's `workflow` / `template` into the prompt to submit.
 * Templates with named parameters (h3_t2v) are driven by `parameters`; a raw
 * `inputs` override on a parameterized input wins, and that parameter is then
 * dropped for this run so its default cannot overwrite the explicit value.
 */
export function buildWorkflow(args) {
    const inputs = args.inputs;
    if (inputs !== undefined && (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))) {
        throw new Error('comfyui_run: inputs must be an object keyed by node id');
    }
    const overrides = (inputs ?? {});
    const rawValues = args.parameters;
    if (rawValues !== undefined && (typeof rawValues !== 'object' || rawValues === null || Array.isArray(rawValues))) {
        throw new Error('comfyui_run: parameters must be an object keyed by parameter name');
    }
    const values = (rawValues ?? {});
    const template = args.template;
    if (typeof template === 'string') {
        const found = findTemplate(template);
        if (found === undefined) {
            throw new Error(`comfyui_run: unknown template "${template}" — use one of ${TEMPLATES.map((t) => t.id).join(', ')}`);
        }
        const workflow = cloneWorkflow(found.workflow);
        applyTemplateInputs(workflow, overrides);
        const parameters = cloneParameters(found.parameters)?.filter((param) => overrides[param.nodeId]?.[param.inputKey] === undefined);
        if (parameters === undefined && Object.keys(values).length > 0) {
            throw new Error(`comfyui_run: template "${template}" has no named parameters — use inputs keyed by node id`);
        }
        if (parameters !== undefined) {
            const known = new Set((found.parameters ?? []).map((param) => param.name));
            const unknown = Object.keys(values).filter((name) => !known.has(name));
            if (unknown.length > 0) {
                throw new Error(`comfyui_run: template "${template}" has no parameter ${unknown.join(', ')} — available: ${[...known].join(', ')}`);
            }
        }
        const prompt = typeof values.prompt === 'string' ? values.prompt.replace(/\s+/g, ' ').trim() : '';
        const label = prompt !== '' ? `${found.id} · ${prompt.slice(0, 24)}${prompt.length > 24 ? '…' : ''}` : `comfyui ${template}`;
        return {
            workflow,
            label,
            template: found.id,
            ...(parameters !== undefined ? { parameters, values } : {}),
        };
    }
    const workflow = args.workflow;
    if (typeof workflow !== 'object' || workflow === null || Array.isArray(workflow)) {
        throw new Error('comfyui_run: workflow must be an object');
    }
    if (Object.keys(values).length > 0) {
        throw new Error('comfyui_run: parameters only apply to templates and saved workflows — use inputs keyed by node id for a raw workflow');
    }
    const copy = cloneWorkflow(workflow);
    applyTemplateInputs(copy, overrides);
    return { workflow: copy, label: 'comfyui custom workflow' };
}
function summarizeMedia(media) {
    if (media.length === 0)
        return 'no media outputs';
    const images = media.filter((item) => item.kind === 'image').length;
    const videos = media.filter((item) => item.kind === 'video').length;
    const audio = media.filter((item) => item.kind === 'audio').length;
    const others = media.length - images - videos - audio;
    const parts = [];
    if (images > 0)
        parts.push(`${images} image(s)`);
    if (videos > 0)
        parts.push(`${videos} video(s)`);
    if (audio > 0)
        parts.push(`${audio} audio file(s)`);
    if (others > 0)
        parts.push(`${others} other file(s)`);
    return parts.join(', ');
}
/** Model-facing text of a finished run (tool result and job result alike). */
export function renderRunResultText(result) {
    const lines = [
        `ComfyUI ${result.status} (prompt ${result.promptId}) in ${result.elapsedMs} ms — ${summarizeMedia(result.media)}`,
    ];
    for (const item of result.media) {
        lines.push(`  ${item.kind}: ${item.url}${item.localPath !== undefined ? `（已存到本机 ${item.localPath}）` : ''}`);
    }
    if (result.archiveError !== undefined)
        lines.push(`注意：本地归档失败（${result.archiveError}），卡片暂时经 ComfyUI 代理播放。`);
    if (result.media.length > 0)
        lines.push('这些文件会显示在调用这次生成的那一轮回复下方（对话主流程里）直接播放，不需要再贴链接。');
    return lines.join('\n');
}
function backgroundText(result) {
    return `ComfyUI generation started in the background (job ${result.jobId}, prompt ${result.promptId}). A player card appears below this turn's reply in the main conversation flow, shows progress and plays the result when it finishes — no need to paste links; read the result text with job_output, stop it with job_kill (only this prompt is cancelled).`;
}
function renderRunResult(_args, value) {
    const result = value;
    if (result.kind === 'background')
        return [{ type: 'text', text: backgroundText(result) }];
    return [{ type: 'text', text: renderRunResultText(result) }];
}
/** Node classes whose progress events mean "sampling" / "decoding". */
const SAMPLER_CLASSES = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced)$/;
const DECODE_CLASSES = /VAEDecode/;
/**
 * One human-readable progress line for a queued prompt: the WebSocket
 * progress when the server reported any, else its queue position.
 */
export async function progressLine(runtime, client, promptId, workflow) {
    const live = runtime.queueProgress(promptId);
    if (live !== undefined) {
        const classType = live.node !== null ? workflow?.[String(live.node)]?.class_type : undefined;
        const stage = classType === undefined ? '执行' : SAMPLER_CLASSES.test(classType) ? '采样' : DECODE_CLASSES.test(classType) ? '解码' : classType;
        return `${stage} ${live.value}/${live.max}`;
    }
    const queue = await client.getQueue().catch(() => undefined);
    if (queue === undefined)
        return undefined;
    if (queue.queue_running.some((item) => item.prompt_id === promptId))
        return '运行中（加载模型 / 编码提示词）';
    const pending = [...queue.queue_pending].sort((a, b) => a.number - b.number);
    const index = pending.findIndex((item) => item.prompt_id === promptId);
    if (index >= 0)
        return `排队中（前面还有 ${index + queue.queue_running.length} 个任务）`;
    return undefined;
}
/**
 * Queue a workflow, then either wait for it here (sync) or hand the wait to a
 * background job (async). Both paths finish through `runtime.complete`, which
 * collects the media (and, from step 4 on, archives it locally).
 */
async function launch(runtime, ctx, exec, spec) {
    const config = runtime.getConfig();
    const client = runtime.createClient(await runtime.getApiKey());
    // Resolve the jobs registry before queueing, so a host without background
    // jobs fails without leaving an orphan prompt on the server.
    const jobs = spec.mode === 'async' ? ctx.get('jobs') : undefined;
    if (spec.mode === 'async' && jobs === undefined) {
        throw new Error('background jobs unavailable — load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs');
    }
    const queued = await runtime.queue(spec.workflow, {
        workflowName: spec.workflowName,
        workflowId: spec.workflowId,
        source: spec.source,
        parameters: spec.parameters,
        values: spec.values,
    });
    const { promptId } = queued;
    const wait = async (signal, onPoll, cancelOnAbort = true) => {
        const startedAt = Date.now();
        try {
            const entry = await client.waitForCompletion({
                promptId,
                timeoutMs: spec.waitMs,
                pollIntervalMs: config.pollIntervalMs,
                signal,
                cancelOnAbort,
                ...(onPoll !== undefined ? { onPoll } : {}),
            });
            const { media, archiveError } = await runtime.complete(promptId, entry);
            return {
                kind: 'sync', promptId, status: 'completed', elapsedMs: Date.now() - startedAt, media, summary: summarizeMedia(media),
                ...(archiveError !== undefined ? { archiveError } : {}),
            };
        }
        catch (error) {
            runtime.untrack(promptId);
            const message = error instanceof Error ? error.message : String(error);
            await runtime.markRun(promptId, signal.aborted ? 'cancelled' : 'failed', message);
            throw error;
        }
    };
    if (jobs !== undefined) {
        const owner = ownerSessionOf(exec.agent);
        const jobId = startGenerationJob(jobs, {
            label: spec.label,
            ...(owner !== undefined ? { owner } : {}),
            work: async (signal, progress) => {
                progress('已提交，等待 ComfyUI');
                const result = await wait(signal, async () => {
                    const line = await progressLine(runtime, client, promptId, queued.prompt);
                    if (line !== undefined)
                        progress(line);
                }, false);
                progress('完成');
                return renderRunResultText(result);
            },
            // Only this prompt: dequeued if pending, interrupted if running.
            cancelRemote: async () => { await client.cancelOwn(promptId); },
        });
        return { kind: 'background', jobId, promptId, label: spec.label };
    }
    try {
        return await wait(exec.signal);
    }
    catch (error) {
        if (error instanceof Error && error.name === 'ComfyUIError' && error.message.includes('interrupted')) {
            return { kind: 'sync', promptId, status: 'interrupted', elapsedMs: 0, media: [], summary: 'interrupted before completion' };
        }
        throw error;
    }
}
function runDefinition(runtime, ctx) {
    return {
        name: 'comfyui_run',
        description: [
            'Submit a workflow to the configured ComfyUI server and return the generated media (images/videos).',
            'Provide exactly one of `workflow` (ComfyUI API-format object: node id → { class_type, inputs }) or `template` (built-in: txt2img | img2img | video | h3_t2v | h3_r2v).',
            'h3_t2v — MiniMax H3 text-to-video with sound: pass `parameters` by name {prompt (required), width, height (multiples of 32; 480p = 864×480, 768p = 1344×768), seconds (3 → 73 frames, 5 → 124; trained range 5–15 s), seed (random if omitted), steps (default 8)} and ALWAYS mode "async". Finished videos are downloaded to the local archive and play in a card below your reply.',
            'h3_r2v — MiniMax H3 reference-to-video with sound: {prompt (required, official six-section format, see the dsh-comfyui-workflows skill), ref_image_1 (required) / ref_image_2 / ref_image_3 (character references = <Picture N>), ref_audio_1 (voice timbre = <Audio 1>), first_frame / last_frame (keyframes), continue_from (previous clip: its last 22 frames + audio pinned at frame 0), width/height (default 480×864), seconds (default 5, 5–15), seed, steps, ref_image_size (match|max), unet, lora}; media values are ComfyUI input file names (upload local files with comfyui_upload first); an empty optional slot removes that branch. ALWAYS mode "async".',
            'Use `inputs` to override node inputs by id, e.g. {"6": {"text": "a red cat"}} for the positive prompt in the templates.',
            'Templates: txt2img — 4 checkpoint, 5 EmptyLatentImage (width/height), 6 positive text, 7 negative text, 3 KSampler (seed/steps/cfg/denoise), 9 SaveImage. img2img — 10 LoadImage (image), 11 VAEEncode, 6 text, 3 KSampler (denoise). video — Wan 2.1, needs ComfyUI-WanVideoWrapper custom nodes (10 UNETLoader, 13 WanTextEncode, 14 WanImageToVideo, 15 KSampler, 17 SaveVideo).',
            'Inspect available node types with comfyui_object_info before hand-writing a workflow.',
            '`mode: sync` (default) waits and returns media URLs; `mode: async` starts a background job and returns a job id for job_output.',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                workflow: { type: 'object', description: 'ComfyUI API-format workflow: node id → { class_type, inputs }. Alternative to `template`.' },
                template: { type: 'string', enum: TEMPLATES.map((t) => t.id), description: 'Built-in workflow template id. Alternative to `workflow`.' },
                parameters: { type: 'object', description: 'Named parameter values for templates that declare them (h3_t2v: prompt, width, height, seconds, seed, steps; h3_r2v adds ref_image_1..3, ref_audio_1, first_frame, last_frame, continue_from, ref_image_size, unet, lora).' },
                inputs: { type: 'object', description: 'Per-node input overrides keyed by node id, e.g. {"3": {"seed": 42, "steps": 30}, "6": {"text": "prompt"}}.' },
                mode: { type: 'string', enum: ['sync', 'async'], default: 'sync', description: 'sync waits and returns media; async returns a background job id.' },
                timeout_ms: { type: 'number', minimum: 5_000, maximum: 3_600_000, description: 'Generation wait budget in ms (default 180000). Video needs minutes.' },
            },
            required: [],
        },
        output: {
            schema: { type: 'object' },
            render: renderRunResult,
            presentationMeta(_args, value) {
                const result = value;
                if (result.kind === 'background') {
                    return { kind: 'background', jobId: result.jobId, promptId: result.promptId, label: result.label };
                }
                return {
                    kind: 'sync',
                    promptId: result.promptId,
                    status: result.status,
                    elapsedMs: result.elapsedMs,
                    media: result.media,
                    summary: result.summary,
                    ...(result.archiveError !== undefined ? { archiveError: result.archiveError } : {}),
                };
            },
        },
        timeoutMs: TOOL_TIMEOUT_MS,
        async execute(args, exec) {
            const problem = requireOneOf(args, ['workflow', 'template']);
            if (problem !== undefined)
                throw new Error(`comfyui_run: ${problem}`);
            const mode = args.mode === undefined ? 'sync' : args.mode;
            if (mode !== 'sync' && mode !== 'async')
                throw new Error(`comfyui_run: mode must be sync or async, got ${String(mode)}`);
            const config = runtime.getConfig();
            const built = buildWorkflow(args);
            const waitMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : config.timeoutMs;
            return launch(runtime, ctx, exec, {
                workflow: built.workflow,
                label: built.label,
                workflowName: built.label,
                source: built.template !== undefined ? `template:${built.template}` : 'tool',
                ...(built.parameters !== undefined ? { parameters: built.parameters, values: built.values ?? {} } : {}),
                mode,
                waitMs,
            });
        },
    };
}
function summarizeFields(fields, required) {
    const out = [];
    for (const [name, spec] of Object.entries(fields ?? {})) {
        if (!Array.isArray(spec))
            continue;
        const [typeOrList, options] = spec;
        const optionsRecord = typeof options === 'object' && options !== null ? options : undefined;
        const entry = { name, type: 'unknown', required };
        if (Array.isArray(typeOrList)) {
            entry.type = 'enum';
            entry.options = typeOrList.slice(0, 6).map(String);
        }
        else if (typeof typeOrList === 'string') {
            entry.type = typeOrList;
        }
        if (optionsRecord !== undefined && optionsRecord.default !== undefined) {
            entry.default = optionsRecord.default;
        }
        out.push(entry);
        if (out.length >= 14)
            break;
    }
    return out;
}
function objectInfoDefinition(runtime) {
    return {
        name: 'comfyui_object_info',
        description: 'List the node definitions the configured ComfyUI server supports (class types, required and optional inputs). Use it to build valid API-format workflows for comfyui_run. Optional `filter` narrows by class-name substring, e.g. "KSampler", "VAE", "LoadImage".',
        parameters: {
            type: 'object',
            properties: {
                filter: { type: 'string', description: 'Optional substring filter on node class names.' },
            },
            required: [],
        },
        output: {
            schema: { type: 'object' },
            render(_args, value) {
                const data = value;
                const lines = [`ComfyUI nodes: ${data.total} total, showing ${data.shown}`];
                for (const node of data.nodes) {
                    lines.push(`- ${node.class_type}${node.display_name !== undefined ? ` (${node.display_name})` : ''}${node.description !== undefined && node.description !== '' ? `: ${node.description}` : ''}`);
                }
                if (data.hint !== undefined)
                    lines.push(data.hint);
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        timeoutMs: 60_000,
        async execute(args) {
            const client = runtime.createClient(await runtime.getApiKey());
            const raw = await client.objectInfo();
            const entries = Object.entries(raw);
            const filter = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : undefined;
            const filtered = filter === undefined || filter === ''
                ? entries
                : entries.filter(([name]) => name.toLowerCase().includes(filter));
            const nodes = filtered.slice(0, 60).map(([classType, def]) => ({
                class_type: classType,
                // Omitted rather than assigned undefined: a key holding undefined makes the
                // whole result fail DSH's lossless-JSON validation. The render type already
                // declares display_name optional.
                ...(def.display_name !== undefined ? { display_name: def.display_name } : {}),
                description: (def.description ?? '').slice(0, 200),
                required: summarizeFields(def.input?.required, true),
                optional: summarizeFields(def.input?.optional, false),
            }));
            const hint = filtered.length > nodes.length
                ? `filter matched ${filtered.length} nodes, showing first ${nodes.length} — narrow the filter for more`
                : undefined;
            return {
                total: entries.length,
                shown: nodes.length,
                filter: filter ?? null,
                // Omitted rather than assigned undefined, same reason as display_name.
                ...(hint !== undefined ? { hint } : {}),
                nodes,
            };
        },
    };
}
/** List and run saved workflows from the panel-managed library. */
function workflowDefinition(runtime, ctx) {
    return {
        name: 'comfyui_workflow',
        description: [
            'List and run saved ComfyUI workflows from the plugin workflow library (运行主题: API-format workflows extracted from a graph or pasted directly).',
            '`action: list` returns every runnable workflow with its id, name, description (what the workflow does), and input notes.',
            'It also lists workflows the user saved on the ComfyUI server (衍生主题: UI graph format canvases). A graph may hold SEVERAL independent flows; each is extracted into its own runnable workflow in the panel (整体/按分量/主流程). A graph with no extracted workflow yet cannot run — tell the user to open the ComfyUI panel and 提取 it first.',
            '`action: run` runs one saved workflow by id — pass only the id plus parameter overrides; the plugin submits the saved workflow JSON itself (never copy the JSON into your reply). It waits for media by default; add `mode: "async"` to run in the background and collect the result with job_output.',
            '`action: get` returns one saved workflow\'s complete API-format JSON by id for inspection/diagnostics only — it consumes many tokens and is not the run path.',
            '`action: save` stores a workflow in the library so it can be listed and run by id later — from exactly one of `prompt_id` (a run you just made: keeps its exact graph and named parameters, the values it used become defaults, random seeds stay random), `template` (built-in id such as h3_t2v) or `workflow` (API JSON; parameters auto-detected). Needs `name`; `description` says when to use it; `parameters` sets defaults by name (giving a seed pins it). Use this when the user says 存成模板 / 保存这个工作流.',
            '`action: update` changes a saved workflow by `id`: new `name` / `description` / `tags`, `parameters` as new defaults by name, or a replacement `workflow` (parameters whose node input still exists are kept). `action: delete` removes one by `id` (its skill pack directory, if any, stays on disk).',
            '`action: refresh` re-derives one saved workflow\'s parameter snapshot (options / numberKind / min/max/step) from the current node definitions and saves it back. Run it after the TTS-Audio-Suite voice library or node definitions changed: saved workflows snapshot their parameter options at save time, so a freshly added voice is not accepted by `action: run` until the snapshot catches up. It force-rescans the TTS voice library first, then updates only the fields derived from object_info — the parameter set (including user-added advanced parameters) is preserved. Returns `changed` with the parameter names that actually changed.',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'run', 'save', 'update', 'delete', 'skill', 'get', 'refresh'], description: 'list the library; run one by id; save / update / delete library entries; skill reads a workflow\'s skill pack; get returns full JSON (diagnostics only); refresh re-derives a parameter snapshot.' },
                id: { type: 'string', description: 'Workflow id (run, update, delete, skill, get, refresh).' },
                name: { type: 'string', description: 'Workflow name for save (required) and update.' },
                description: { type: 'string', description: 'What the workflow does / when to use it (save, update).' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (save, update).' },
                prompt_id: { type: 'string', description: 'save: the prompt id of a finished run to save as a reusable workflow.' },
                template: { type: 'string', enum: TEMPLATES.map((t) => t.id), description: 'save: built-in template id to save into the library.' },
                workflow: { type: 'object', description: 'save / update: API-format workflow JSON.' },
                mode: { type: 'string', enum: ['sync', 'async'], description: 'run mode (default sync); async starts a background job and returns its id for job_output. Video/audio workflows should use async — generation takes minutes and sync may time out.' },
                timeout_ms: { type: 'number', minimum: 5_000, maximum: 3_600_000, description: 'Generation wait budget in ms (default 900000 = 15 min). Video needs minutes; raise this for long videos.' },
                parameters: {
                    type: 'object',
                    description: 'run: per-run values for the workflow\'s parameters (e.g. {"prompt": "a red cat", "seconds": 5}); omitted ones keep their defaults, seeds marked 随机 randomize. save / update: new default values by parameter name.',
                },
            },
            required: ['action'],
        },
        output: {
            schema: { type: 'object' },
            render(_args, value) {
                const data = value;
                if (data.action === 'skill') {
                    const pack = data.skill;
                    if (pack === undefined)
                        return [{ type: 'text', text: `ComfyUI workflow ${data.name ?? data.id} 没有技能包。` }];
                    // Same framing the host uses for its own skills: a named block, the
                    // resource base, then the body verbatim. The reference files stay on
                    // disk until the body sends the model after one of them.
                    const others = pack.files.filter((file) => file !== 'SKILL.md');
                    return [{
                            type: 'text',
                            text: [
                                `<skill_content name="${pack.workflowName}">`,
                                '<skill_resources>',
                                `Base directory for this skill: ${pack.resourceBase}`,
                                others.length > 0
                                    ? `Files in this pack: ${others.join(', ')} — resolve them against the base directory and read one only when the instructions below point at it.`
                                    : 'This pack has no reference files.',
                                '</skill_resources>',
                                '',
                                '<skill_instructions>',
                                pack.body,
                                '</skill_instructions>',
                                '</skill_content>',
                            ].join('\n'),
                        }];
                }
                if (data.action === 'get') {
                    return [{ type: 'text', text: `ComfyUI workflow ${data.name ?? data.id}: ${JSON.stringify(data.workflow)}` }];
                }
                if (data.action === 'save' || data.action === 'update') {
                    return [{ type: 'text', text: `${data.action === 'save' ? '已保存到工作流库' : '已更新工作流'}：${data.name}（id ${data.id}）。默认参数：${data.parameterSummary ?? '（无）'}。运行：comfyui_workflow { action: "run", id: "${data.id}", parameters: {…}, mode: "async" }` }];
                }
                if (data.action === 'delete') {
                    return [{ type: 'text', text: `已从工作流库删除：${data.name}（id ${data.id}）${data.keptSkillPack === true ? '；它的技能包目录仍保留在磁盘上（面板里可彻底删除）' : ''}` }];
                }
                if (data.background !== undefined) {
                    return [{ type: 'text', text: backgroundText(data.background) }];
                }
                if (data.action === 'refresh') {
                    const changed = data.changed ?? [];
                    const changedText = changed.length > 0
                        ? `更新了 ${changed.length} 个参数的 options / 数值声明：${changed.join('、')}`
                        : 'options 与数值声明与最新节点定义一致，没有变化';
                    return [{ type: 'text', text: `ComfyUI workflow ${data.name ?? data.id}：参数快照已刷新（${data.parameterCount ?? 0} 个参数原样保留），${changedText}` }];
                }
                if (data.action === 'list') {
                    const lines = [];
                    const env = data.env;
                    if (env !== undefined) {
                        // The model's local-env one-liner: the ComfyUI server address and
                        // the user's ComfyUI install dirs, so it never has to ask where
                        // files live (TTS-Audio-Suite voice library etc.).
                        lines.push(`ComfyUI 服务器: ${env.baseUrl}；本机 ComfyUI 目录: ${env.comfyuiDirs.length > 0 ? env.comfyuiDirs.join('；') : '未配置（设置页 comfyuiDirs 可填写）'}`);
                    }
                    lines.push(`Saved ComfyUI workflows (${data.workflows?.length ?? 0}):`);
                    for (const workflow of data.workflows ?? []) {
                        lines.push(`- ${workflow.id} — ${workflow.name}${workflow.description !== '' ? `: ${workflow.description}` : ''}`);
                        const skill = workflow.skill;
                        if (skill !== undefined) {
                            const extra = skill.files > 1 ? `，另有 ${skill.files - 1} 篇参考文档` : '';
                            lines.push(`  技能包${skill.required ? '（运行前必读）' : ''}: ${skill.summary}${extra} — 运行前先 action: skill { id: "${workflow.id}" }`);
                        }
                        for (const param of workflow.parameters ?? []) {
                            const label = param.label ?? param.name;
                            const def = param.default === undefined ? '' : `，默认 ${typeof param.default === 'string' ? `"${param.default}"` : String(param.default)}`;
                            const options = Array.isArray(param.options) && param.options.length > 0 ? `，可选: ${param.options.join(' / ')}` : '';
                            const upload = param.upload !== undefined
                                ? `，上传类型: ${param.upload}${param.upload === 'media' ? `（${param.subfolder ?? ''}/，空值=移除该参考位）` : ''}`
                                : '';
                            lines.push(`  ${param.name}(${label}${param.random === true ? '，随机' : ''}${def}${options}${upload})`);
                        }
                    }
                    const loadArea = data.loadArea;
                    if (loadArea !== undefined && loadArea.slots > 0) {
                        lines.push(`用户加载区（${loadArea.slots} 个加载位，已放入 ${loadArea.loaded} 个素材，未显式传值的加载参数按顺序取用）:`);
                        for (const [index, item] of loadArea.items.entries()) {
                            lines.push(`  ${index + 1}. ${item.name}（${item.kind}）`);
                        }
                    }
                    for (const template of data.templates ?? []) {
                        lines.push(`内置模板 ${template.id} — ${template.name}：comfyui_run { template: "${template.id}", parameters: {…}, mode: "async" }，参数 ${template.parameters}；要存进库用 action: save { template: "${template.id}", name }`);
                    }
                    const comfyui = data.comfyuiWorkflows ?? [];
                    if (comfyui.length > 0) {
                        lines.push(`ComfyUI 端保存的图工作流（${comfyui.length} 个，UI 图格式，不能直接运行）:`);
                        for (const workflow of comfyui) {
                            if (workflow.extracted) {
                                lines.push(`- ${workflow.name} — 已提取 ${workflow.derived.length} 个运行工作流：${workflow.derived.map((d) => `${d.name}(${d.libraryId})`).join('、')}`);
                            }
                            else {
                                lines.push(`- ${workflow.name} — 未提取：如需运行，请转告用户先在 ComfyUI 面板里“提取”它（可选择整体/按分量/主流程）`);
                            }
                        }
                    }
                    return [{ type: 'text', text: lines.join('\n') }];
                }
                const result = data.result;
                if (result === undefined)
                    return [{ type: 'text', text: 'ComfyUI workflow run returned no result.' }];
                return [{ type: 'text', text: renderRunResultText(result) }];
            },
            presentationMeta(_args, value) {
                return value;
            },
        },
        timeoutMs: TOOL_TIMEOUT_MS,
        async execute(args, exec) {
            const action = args.action;
            if (action !== 'list' && action !== 'run' && action !== 'get' && action !== 'refresh' && action !== 'skill'
                && action !== 'save' && action !== 'update' && action !== 'delete') {
                throw new Error(`comfyui_workflow: action must be list, run, save, update, delete, skill, get, or refresh, got ${String(action)}`);
            }
            const tagsOf = (value) => Array.isArray(value) ? value.filter((tag) => typeof tag === 'string') : undefined;
            if (action === 'save') {
                const name = typeof args.name === 'string' ? args.name.trim() : '';
                if (name === '')
                    throw new Error('comfyui_workflow: save needs a name');
                let run;
                if (args.prompt_id !== undefined) {
                    if (typeof args.prompt_id !== 'string' || args.prompt_id === '')
                        throw new Error('comfyui_workflow: prompt_id must be a non-empty string');
                    run = await runtime.runRecord(args.prompt_id);
                    if (run === undefined) {
                        throw new Error(`comfyui_workflow: 找不到 prompt ${args.prompt_id} 的运行记录（本地归档和 ComfyUI history 都没有）`);
                    }
                }
                let draft;
                try {
                    draft = draftForSave({
                        ...(args.workflow !== undefined ? { workflow: args.workflow } : {}),
                        ...(args.template !== undefined ? { template: args.template } : {}),
                        ...(run !== undefined ? { run } : {}),
                        ...(args.parameters !== undefined ? { defaults: args.parameters } : {}),
                        objectInfo: run === undefined && args.workflow !== undefined ? await runtime.objectInfo() : undefined,
                    });
                }
                catch (error) {
                    throw new Error(`comfyui_workflow: save failed: ${error instanceof Error ? error.message : String(error)}`);
                }
                const description = typeof args.description === 'string'
                    ? args.description
                    : run !== undefined ? `从运行 ${String(args.prompt_id)}${run.workflowName ? `（${run.workflowName}）` : ''} 保存` : '';
                const result = await runtime.saveWorkflow({
                    name,
                    description,
                    workflow: draft.workflow,
                    parameters: draft.parameters,
                    ...(tagsOf(args.tags) !== undefined ? { tags: tagsOf(args.tags) } : {}),
                    source: 'user',
                });
                if (!result.ok)
                    throw new Error(`comfyui_workflow: save failed: ${result.error}`);
                return { action: 'save', id: result.workflow.id, name: result.workflow.name, parameterSummary: describeParameters(draft.parameters) };
            }
            if (action === 'list') {
                const [workflows, comfyui, slots] = await Promise.all([
                    runtime.listWorkflows(),
                    runtime.listComfyWorkflows().catch(() => []),
                    runtime.loadSlots().catch(() => []),
                ]);
                // What the user currently has loaded in the panel's load area. Unset
                // loader parameters take these files in slot order, so the model can
                // see how many references a run will pick up without asking.
                const loaded = slots.filter((slot) => slot !== null);
                // Rung one of the skill-pack disclosure ladder: a workflow that has a
                // pack contributes ONE summary line here, not its body. The model
                // reaches for `action: skill` only after this listing points it at a
                // specific workflow, so an unused pack costs nothing.
                const packs = new Map();
                await Promise.all(workflows
                    .filter((workflow) => workflow.skillDir !== undefined && workflow.skillDir !== '')
                    .map(async (workflow) => {
                    const pack = await runtime.skillPacks.infoFor(workflow).catch(() => undefined);
                    if (pack === undefined)
                        return;
                    packs.set(workflow.id, {
                        summary: pack.summary !== '' ? pack.summary : `${workflow.name} 的使用说明`,
                        files: pack.files.length,
                        required: pack.required,
                    });
                }));
                return {
                    action: 'list',
                    // Local environment the model can rely on: the ComfyUI server
                    // address and the user's ComfyUI install dirs (configured in the
                    // settings page comfyuiDirs). Fresh on every call, so config
                    // changes show up without restarting DSH.
                    env: {
                        baseUrl: runtime.getConfig().baseUrl,
                        comfyuiDirs: runtime.getConfig().comfyuiDirs,
                    },
                    loadArea: {
                        slots: slots.length,
                        loaded: loaded.length,
                        items: loaded.map(({ name, kind, source }) => ({ name, kind, source })),
                    },
                    workflows: workflows.map(({ id, name, description, parameters, updatedAt }) => ({
                        id,
                        name,
                        description,
                        ...(packs.has(id) ? { skill: packs.get(id) } : {}),
                        parameters: (parameters ?? []).map(({ name: pname, label, type, default: def, random, numberKind, options, upload }) => {
                            // DSH validates tool output as lossless JSON: JSON.stringify drops
                            // undefined keys, so omit optional fields instead of passing undefined.
                            const entry = { name: pname };
                            if (label !== undefined)
                                entry.label = label;
                            if (type !== undefined)
                                entry.type = type;
                            if (def !== undefined)
                                entry.default = def;
                            if (random !== undefined)
                                entry.random = random;
                            // Tells the model whether decimals are accepted; absent means the
                            // node's declared type is unknown and a float is safe.
                            if (numberKind !== undefined)
                                entry.numberKind = numberKind;
                            if (options !== undefined)
                                entry.options = options;
                            if (upload !== undefined)
                                entry.upload = upload;
                            return entry;
                        }),
                        updatedAt,
                    })),
                    comfyuiWorkflows: comfyui.map(({ name, extracted, derived }) => ({ name, extracted, derived })),
                    // Built-in templates that run by named parameters (comfyui_run template).
                    templates: TEMPLATES.filter((template) => template.parameters !== undefined).map((template) => ({
                        id: template.id,
                        name: template.name,
                        parameters: describeParameters(template.parameters ?? []),
                    })),
                };
            }
            const id = args.id;
            if (typeof id !== 'string' || id === '') {
                throw new Error('comfyui_workflow: id is required for action: run, update, delete, get, refresh and skill');
            }
            const saved = await runtime.getWorkflow(id);
            if (saved === undefined) {
                throw new Error(`comfyui_workflow: workflow "${id}" not found — run action: list first`);
            }
            if (action === 'delete') {
                const removed = await runtime.deleteWorkflow(saved.id);
                if (!removed)
                    throw new Error(`comfyui_workflow: workflow "${id}" not found`);
                return { action: 'delete', id: saved.id, name: saved.name, keptSkillPack: saved.skillDir !== undefined };
            }
            if (action === 'update') {
                let draft;
                try {
                    draft = draftForUpdate({ workflow: saved.workflow, parameters: saved.parameters ?? [] }, {
                        ...(args.workflow !== undefined ? { workflow: args.workflow } : {}),
                        ...(args.parameters !== undefined ? { defaults: args.parameters } : {}),
                        objectInfo: args.workflow !== undefined ? await runtime.objectInfo() : undefined,
                    });
                }
                catch (error) {
                    throw new Error(`comfyui_workflow: update failed: ${error instanceof Error ? error.message : String(error)}`);
                }
                const result = await runtime.saveWorkflow({
                    id: saved.id,
                    name: typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : saved.name,
                    description: typeof args.description === 'string' ? args.description : saved.description,
                    workflow: draft.workflow,
                    parameters: draft.parameters,
                    tags: tagsOf(args.tags) ?? saved.tags,
                    source: saved.source,
                    comfyuiFile: saved.comfyuiFile,
                });
                if (!result.ok)
                    throw new Error(`comfyui_workflow: update failed: ${result.error}`);
                return { action: 'update', id: saved.id, name: result.workflow.name, parameterSummary: describeParameters(draft.parameters) };
            }
            if (action === 'get') {
                return {
                    action: 'get',
                    id: saved.id,
                    name: saved.name,
                    description: saved.description,
                    parameters: saved.parameters ?? [],
                    workflow: saved.workflow,
                };
            }
            if (action === 'skill') {
                const pack = await runtime.skillPacks.load(saved.id);
                if (!pack.ok) {
                    throw new Error(`comfyui_workflow: ${pack.error}`);
                }
                // Reading the pack is what opens the `requireSkill` gate below.
                markSkillPackRead(exec.agent, saved.id);
                return {
                    action: 'skill',
                    id: saved.id,
                    name: saved.name,
                    skill: {
                        workflowName: pack.value.workflowName,
                        summary: pack.value.summary,
                        body: pack.value.body,
                        resourceBase: pack.value.resourceBase,
                        files: pack.value.files,
                    },
                };
            }
            if (action === 'refresh') {
                // The library snapshot is captured at save time and never re-reads
                // object_info, so a voice library that grew since then would reject
                // the new voice at run time. Force the TTS rescan first (the object_info
                // COMBO does not self-heal), then re-derive the derived fields only.
                await runtime.refreshVoiceLibrary();
                const client = runtime.createClient(await runtime.getApiKey());
                const objectInfo = await client.objectInfo().catch(() => undefined);
                const { parameters, changed } = refreshParameterMetadata(saved.parameters ?? [], objectInfo, saved.workflow);
                const result = await runtime.saveWorkflow({
                    id: saved.id,
                    name: saved.name,
                    description: saved.description,
                    workflow: saved.workflow,
                    parameters,
                    source: saved.source,
                    comfyuiFile: saved.comfyuiFile,
                    tags: saved.tags,
                });
                if (!result.ok) {
                    throw new Error(`comfyui_workflow: refresh failed: ${result.error}`);
                }
                return {
                    action: 'refresh',
                    id: saved.id,
                    name: saved.name,
                    parameterCount: parameters.length,
                    changed,
                };
            }
            // The 必读 gate: workflows the user marked `requireSkill` refuse to run
            // until this session has actually loaded their pack. The reminder in the
            // listing is advisory; this is the part that holds.
            if (saved.requireSkill === true && saved.skillDir !== undefined && !hasReadSkillPack(exec.agent, saved.id)) {
                throw new Error(`comfyui_workflow: 工作流 "${saved.name}" 标记了运行前必读技能包 — 先调用 action: skill { id: "${saved.id}" } 读完再运行。`);
            }
            const config = runtime.getConfig();
            const values = typeof args.parameters === 'object' && args.parameters !== null
                ? args.parameters
                : {};
            const mode = args.mode === undefined ? 'sync' : args.mode;
            if (mode !== 'sync' && mode !== 'async') {
                throw new Error(`comfyui_workflow: mode must be sync or async, got ${String(mode)}`);
            }
            const waitMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : config.timeoutMs;
            const launched = await launch(runtime, ctx, exec, {
                workflow: saved.workflow,
                label: saved.name,
                workflowName: saved.name,
                workflowId: saved.id,
                source: 'workflow-tool',
                parameters: saved.parameters,
                values,
                mode,
                waitMs,
            });
            if (launched.kind === 'background') {
                return { action: 'run', id, workflowName: saved.name, background: launched };
            }
            return { action: 'run', id, workflowName: saved.name, result: launched };
        },
    };
}
/**
 * `comfyui_skill`: read and write one workflow's skill pack.
 *
 * The pack is documentation the agent is expected to consult before running a
 * workflow (`comfyui_workflow action: skill`), and this tool is the other half:
 * the agent can also author it — record a pitfall it just hit, add a style
 * reference, lay out its own folders — with the same validation, size caps, and
 * path containment the panel goes through.
 *
 * Destroying a pack is deliberately absent. The files are hand-written by the
 * user and have no other copy, so removing the whole thing stays a panel
 * gesture behind an explicit confirmation; the agent can delete a file it owns
 * but cannot wipe the directory.
 */
function skillDefinition(runtime) {
    return {
        name: 'comfyui_skill',
        description: [
            "Read and write one workflow's skill pack: the SKILL.md the agent reads before running that workflow, plus its reference files, scripts, templates and assets.",
            '`action: list` returns the pack listing (files, sub-directories, byte sizes) and its absolute directory.',
            '`action: read` returns one file (path relative to the pack, e.g. `references/styles.md`); reading `SKILL.md` also satisfies the 必读 gate that blocks `comfyui_workflow action: run` for workflows marked required.',
            '`action: write` creates or overwrites one file (`content`); pass `summary` alongside when writing SKILL.md to set the one-line summary the workflow listing shows. `action: append` adds to the end of an existing file instead — the right choice for recording a newly discovered pitfall without rewriting the document.',
            '`action: mkdir` creates a sub-directory, `action: rename` moves a file within the pack, `action: delete` removes one file (SKILL.md cannot be renamed or deleted).',
            '`action: enable` attaches a pack to a workflow that has none (seeding SKILL.md), and `action: require` toggles whether running that workflow demands the pack be read first.',
            'Write documentation the next agent run will need: when to use the workflow, which parameter values matter, what fails. Keep SKILL.md short and put bulk material in separate files — SKILL.md is loaded whole, the other files only when it points at them.',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list', 'read', 'write', 'append', 'mkdir', 'rename', 'delete', 'enable', 'require'],
                    description: 'list the pack; read/write/append/rename/delete one file; mkdir a sub-directory; enable a pack on a workflow; require toggles the read-before-run gate.',
                },
                workflow_id: { type: 'string', description: 'Workflow id from comfyui_workflow action: list.' },
                path: { type: 'string', description: 'Pack-relative file path for read/write/append/rename/delete, e.g. "SKILL.md" or "references/styles.md". One level of sub-directory only.' },
                content: { type: 'string', description: 'File text for write and append.' },
                summary: { type: 'string', description: 'One-line summary stored in SKILL.md frontmatter; this is the line the workflow listing shows, so make it say when to use the workflow.' },
                to: { type: 'string', description: 'New path for rename (a bare name keeps the current directory).' },
                name: { type: 'string', description: 'Sub-directory name for mkdir (letters, digits, CJK, underscore, dash).' },
                required: { type: 'boolean', description: 'For action: require — true refuses to run the workflow until the pack has been read in this session.' },
            },
            required: ['action', 'workflow_id'],
        },
        output: {
            schema: { type: 'object' },
            render(_args, value) {
                const data = value;
                if (data.action === 'read') {
                    return [{ type: 'text', text: `${data.path} (${data.workflowName}):\n${data.content ?? ''}${data.truncated === true ? '\n…（文件过大，已截断）' : ''}` }];
                }
                const lines = [];
                if (data.action === 'list') {
                    lines.push(`技能包 ${data.workflowName}（${data.dir}）${data.required === true ? ' — 运行前必读' : ''}`);
                    if (data.summary !== undefined && data.summary !== '')
                        lines.push(`摘要: ${data.summary}`);
                    for (const file of data.files ?? [])
                        lines.push(`  ${file.path} (${file.size} B)`);
                    const empty = (data.dirs ?? []).filter((dir) => !(data.files ?? []).some((file) => file.path.startsWith(`${dir}/`)));
                    if (empty.length > 0)
                        lines.push(`  空目录: ${empty.map((dir) => `${dir}/`).join('、')}`);
                    return [{ type: 'text', text: lines.join('\n') }];
                }
                lines.push(`技能包 ${data.workflowName} 已更新（${data.action}${data.path !== undefined ? ` ${data.path}` : ''}）`);
                for (const file of data.files ?? [])
                    lines.push(`  ${file.path} (${file.size} B)`);
                return [{ type: 'text', text: lines.join('\n') }];
            },
            presentationMeta(_args, value) {
                return value;
            },
        },
        timeoutMs: TOOL_TIMEOUT_MS,
        async execute(args, exec) {
            const action = args.action;
            const id = args.workflow_id;
            if (typeof id !== 'string' || id === '') {
                throw new Error('comfyui_skill: workflow_id is required');
            }
            const saved = await runtime.getWorkflow(id);
            if (saved === undefined) {
                throw new Error(`comfyui_skill: workflow "${id}" not found — run comfyui_workflow action: list first`);
            }
            const path = typeof args.path === 'string' ? args.path : '';
            const content = typeof args.content === 'string' ? args.content : '';
            const listing = async (label, extra) => {
                const pack = await runtime.skillPacks.info(id);
                if (pack === undefined)
                    throw new Error(`comfyui_skill: 工作流 "${saved.name}" 没有技能包 — 先用 action: enable 挂一个`);
                return {
                    action: label,
                    workflowId: id,
                    workflowName: saved.name,
                    dir: pack.dir,
                    summary: pack.summary,
                    required: pack.required,
                    files: pack.files.map(({ path: file, size }) => ({ path: file, size })),
                    dirs: pack.dirs,
                    ...extra,
                };
            };
            if (action === 'enable') {
                const result = await runtime.skillPacks.enable(id);
                if (!result.ok)
                    throw new Error(`comfyui_skill: ${result.error}`);
                return listing('enable');
            }
            if (action === 'list')
                return listing('list');
            if (action === 'require') {
                const result = await runtime.skillPacks.setRequired(id, args.required === true);
                if (!result.ok)
                    throw new Error(`comfyui_skill: ${result.error}`);
                return listing('require');
            }
            if (action === 'read') {
                if (path === '')
                    throw new Error('comfyui_skill: path is required for action: read');
                const file = await runtime.skillPacks.readFile(id, path);
                if (!file.ok)
                    throw new Error(`comfyui_skill: ${file.error}`);
                // Reading the main document is the same gesture `comfyui_workflow
                // action: skill` performs, so it opens the run gate too.
                if (path === SKILL_MAIN)
                    markSkillPackRead(exec.agent, id);
                const truncated = file.value.length > MAX_TOOL_READ_CHARS;
                return {
                    action: 'read',
                    workflowId: id,
                    workflowName: saved.name,
                    path,
                    content: truncated ? file.value.slice(0, MAX_TOOL_READ_CHARS) : file.value,
                    truncated,
                };
            }
            if (action === 'write' || action === 'append') {
                if (path === '')
                    throw new Error(`comfyui_skill: path is required for action: ${action}`);
                let text = content;
                if (action === 'append') {
                    const existing = await runtime.skillPacks.readFile(id, path);
                    const before = existing.ok ? existing.value : '';
                    text = before === '' ? content : `${before.replace(/\s*$/, '')}\n\n${content}`;
                }
                const summary = typeof args.summary === 'string' ? args.summary : undefined;
                const result = path === SKILL_MAIN && summary !== undefined
                    ? await runtime.skillPacks.writeFile(id, path, joinFrontmatter(summary, text))
                    : await runtime.skillPacks.writeFile(id, path, text);
                if (!result.ok)
                    throw new Error(`comfyui_skill: ${result.error}`);
                return listing(action, { path });
            }
            if (action === 'mkdir') {
                const name = typeof args.name === 'string' ? args.name : '';
                const result = await runtime.skillPacks.makeDir(id, name);
                if (!result.ok)
                    throw new Error(`comfyui_skill: ${result.error}`);
                return listing('mkdir', { path: `${name}/` });
            }
            if (action === 'rename') {
                const to = typeof args.to === 'string' ? args.to : '';
                if (path === '' || to === '')
                    throw new Error('comfyui_skill: path and to are required for action: rename');
                const bucket = path.includes('/') ? `${path.split('/')[0] ?? ''}/` : '';
                const target = to.includes('/') ? to : `${bucket}${to}`;
                const result = await runtime.skillPacks.renameFile(id, path, target);
                if (!result.ok)
                    throw new Error(`comfyui_skill: ${result.error}`);
                return listing('rename', { path: target });
            }
            if (action === 'delete') {
                if (path === '')
                    throw new Error('comfyui_skill: path is required for action: delete');
                const result = await runtime.skillPacks.deleteFile(id, path);
                if (!result.ok)
                    throw new Error(`comfyui_skill: ${result.error}`);
                return listing('delete', { path });
            }
            throw new Error(`comfyui_skill: unknown action ${String(action)}`);
        },
    };
}
/**
 * `comfyui_upload`: put one local media file into ComfyUI's input directory.
 * Validation (path, extension allow-list, size cap, subfolder grammar) lives
 * in upload.ts; the bytes travel through the runtime's client, never a client
 * built here.
 */
function uploadDefinition(runtime) {
    return {
        name: 'comfyui_upload',
        description: [
            'Upload one local media file (absolute path, or relative to the session working directory) into the ComfyUI server\'s input directory and return its server-side reference.',
            'Put the returned `ref` (`subfolder/name` or `name`) straight into LoadImage.image / LoadAudio.audio / LoadVideo.file, or into template parameters such as h3_r2v ref_image_1 / ref_audio_1 / first_frame / continue_from.',
            `Allowed types: ${[...UPLOAD_EXTENSIONS].join(', ')}; at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
            'Optional `subfolder` (one directory level: letters, digits, underscore, dash) keeps a project\'s references together; `overwrite: true` replaces a same-named file, otherwise ComfyUI may store it under a new name — always use the returned ref.',
        ].join(' '),
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Local file path: absolute, or relative to the session working directory.' },
                subfolder: { type: 'string', description: 'Optional subfolder under ComfyUI input/ (single segment, [A-Za-z0-9_-]).' },
                overwrite: { type: 'boolean', description: 'Replace an existing file with the same name (default false).' },
            },
            required: ['path'],
        },
        output: {
            schema: { type: 'object' },
            render(_args, value) {
                const result = value;
                const loader = result.kind === 'image' ? 'LoadImage.image' : result.kind === 'audio' ? 'LoadAudio.audio' : 'LoadVideo.file';
                const size = result.size !== undefined ? `，${result.size.width}×${result.size.height}` : '';
                return [{ type: 'text', text: `已上传到 ComfyUI input：${result.ref}（${result.kind}，${result.bytes} 字节${size}）。可直接填 ${loader} 或模板的媒体参数。` }];
            },
            presentationMeta(_args, value) {
                return value;
            },
        },
        timeoutMs: 600_000,
        async execute(args, exec) {
            return uploadLocalFile(runtime, {
                path: args.path,
                subfolder: args.subfolder,
                overwrite: args.overwrite,
                cwd: sessionCwd(exec),
            });
        },
    };
}
/** Register the plugin tools; returns disposers. */
export function registerComfyUITools(ctx, runtime) {
    const tools = ctx.tools;
    const disposers = [];
    disposers.push(tools.register(runDefinition(runtime, ctx)));
    disposers.push(tools.register(objectInfoDefinition(runtime)));
    disposers.push(tools.register(workflowDefinition(runtime, ctx)));
    disposers.push(tools.register(skillDefinition(runtime)));
    disposers.push(tools.register(uploadDefinition(runtime)));
    return disposers;
}
