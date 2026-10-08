import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Config, archiveRootOf, resolveConfig } from './config.js';
import { RunArchive } from './archive.js';
import { ComfyUIClient, CLIENT_ID, collectMedia } from './comfyui.js';
import { ComfyUIStore } from './store.js';
import { QueueTracker } from './queue.js';
import { convertGraphToApi, flattenDynamicCombos } from './convert.js';
import { analyzeGraph } from './analyze.js';
import { ProgressTracker } from './progress.js';
import { COMFYUI_SKILL } from './skill.js';
import { analyzeWorkflowParameters, applyWorkflowParameters } from './params.js';
import { createWorkflowSkillPacks } from './skillpack.js';
import { uploadContentType } from './upload.js';
import { registerComfyUITools } from './tools.js';
import { mountComfyUIRoutes } from './routes.js';
import { mountComfyUIProxy } from './proxy.js';
import { createHostHint } from './host-hint.js';
import { createRouteGuard } from './route-guard.js';
export const name = 'dsh-comfyui';
export { Config };
/**
 * Required services. `tools` is the model-facing registry the plugin writes
 * into, so the fiber must wait for it: reading `ctx.tools` without declaring
 * it here is what cordis rejects with `cannot get property "tools" without
 * inject`. `webServer`, `settings`, and `credentials` stay OUT of this list —
 * they are optional, and the plugin degrades gracefully without them (see
 * apply).
 */
export const inject = ['tools'];
const COMFYUI_NS = 'comfyui';
/** object_info is large and changes only when nodes are (re)installed. */
const OBJECT_INFO_TTL_MS = 60_000;
let objectInfoCache;
async function objectInfoCached(client) {
    const now = Date.now();
    if (objectInfoCache !== undefined && now - objectInfoCache.ts < OBJECT_INFO_TTL_MS)
        return objectInfoCache.value;
    try {
        const value = await client.objectInfo();
        objectInfoCache = { ts: now, value };
        return value;
    }
    catch {
        return undefined;
    }
}
async function resolveApiKey(ctx, envName) {
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
        try {
            const resolved = await credentials.resolve(envName);
            if (resolved !== undefined)
                return resolved.value;
        }
        catch {
            // Fall through to the process environment below.
        }
    }
    return process.env[envName];
}
/** Default plugin data directory under the harness home. */
function defaultDataDir() {
    const base = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(base, 'data', 'dsh-comfyui');
}
/**
 * The plugin body. The loader validates the entry config against `Config`
 * (defaults applied), then hands the resolved object to apply.
 */
export async function apply(ctx, entryConfig) {
    // Volatile fields arrive as references on dsh 0.1.7+ (plain values on older
    // hosts); `resolved` is the one plain object every consumer reads, refreshed
    // in place when the Loader commits a settings-page change.
    const resolved = resolveConfig(entryConfig, defaultDataDir());
    const store = new ComfyUIStore(resolved.dataDir, resolved.maxAssets);
    await store.init();
    // Per-workflow skill packs default to `<dataDir>/skills`; `skillsDir` moves
    // them anywhere absolute (another drive, a synced folder, a repo) without
    // dragging the JSON state along. The root is a getter, not a snapshot, so a
    // settings-page change applies to the next call rather than the next restart.
    // Directories are created lazily when a user attaches a pack, so nothing is
    // written for a library that never uses them.
    const skillPacks = createWorkflowSkillPacks({
        skillsRoot: () => {
            const configured = resolved.skillsDir.trim();
            // A relative path would resolve against the process cwd, which is not
            // something a user typing into the settings page can predict.
            return configured !== '' && isAbsolute(configured) ? configured : store.skillsRoot;
        },
        getWorkflow: (id) => store.getWorkflow(id),
        updateWorkflowSkill: (id, patch) => store.updateWorkflowSkill(id, patch),
    });
    const tracker = new QueueTracker({
        load: () => store.loadTracked(),
        save: (state) => store.saveTracked(state),
    });
    await tracker.init();
    const progress = new ProgressTracker();
    // Best-effort progress feed: listen on the server's WebSocket for `progress`
    // events. The socket uses the same client id as queued prompts (CLIENT_ID),
    // so progress events for prompts this plugin submits arrive here; the server
    // only broadcasts them to the submitting client. Node's global WebSocket
    // (undici) cannot set auth headers, so a remote server behind an
    // authenticating proxy simply shows no progress.
    const progressUrl = () => resolved.baseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '') + `/ws?clientId=${CLIENT_ID}`;
    let attachedUrl = progressUrl();
    ctx.effect(() => {
        progress.attach(attachedUrl);
        return () => progress.dispose();
    }, 'dsh-comfyui: progress');
    /** Pick up a new config in place; a new baseUrl re-points the progress socket. */
    const refreshConfig = (next) => {
        Object.assign(resolved, next);
        const url = progressUrl();
        if (url !== attachedUrl) {
            attachedUrl = url;
            progress.dispose();
            progress.attach(url);
        }
    };
    // dsh 0.1.7+: a settings-page save commits volatile values into the same
    // references without restarting the plugin, then notifies this fiber.
    ctx.on('loader/volatile-update', (() => {
        refreshConfig(resolveConfig(entryConfig, defaultDataDir()));
    }));
    const hostHint = createHostHint();
    // Finished runs land on this machine; the root is re-read per call so a
    // settings-page change applies to the next run (existing runs stay put).
    const archive = new RunArchive(() => archiveRootOf(resolved));
    const runtime = {
        getConfig: () => resolved,
        getApiKey: () => resolveApiKey(ctx, resolved.apiKeyEnv),
        createClient: (apiKey) => new ComfyUIClient(resolved.baseUrl, apiKey, resolved.connectTimeoutMs, resolved.maxMediaBytes, resolved.unreachableHint),
        hostHint,
        archive,
        // Media URLs are same-origin relative paths since 0.6.0: the card renders
        // them inside the page that served it, and the media routes only answer
        // loopback hosts anyway, so an absolute LAN/domain origin would be both
        // unnecessary and refused. Relative URLs also survive a port change,
        // which keeps old chat cards playable.
        proxyBase: () => '',
        settingsWritable: () => {
            const settings = ctx.get('settings');
            return settings?.writable === true;
        },
        updateConfig: async (patch) => {
            const settings = ctx.get('settings');
            if (settings === undefined) {
                return { ok: false, error: 'settings service unavailable — edit cordis.yml instead' };
            }
            try {
                await settings.update(COMFYUI_NS, patch);
                return { ok: true };
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
        queue: async (workflow, meta) => {
            const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv));
            // Heals library entries saved with the pre-0.5.2 wrapped DynamicCombo shape (Issue #10).
            let prompt = flattenDynamicCombos(workflow);
            const values = {};
            if (meta.parameters !== undefined && meta.parameters.length > 0) {
                const objectInfo = await objectInfoCached(client);
                const slots = await store.loadSlots();
                const loaded = slots.filter((slot) => slot !== null);
                prompt = applyWorkflowParameters(prompt, meta.parameters, meta.values ?? {}, objectInfo, await store.loadMediaSizes(), loaded, values);
            }
            const extraData = {};
            if (meta.workflowId !== undefined && meta.workflowId !== null && meta.workflowName !== null) {
                // ComfyUI's job metadata derives workflow_id from extra_pnginfo.workflow.id.
                extraData['extra_pnginfo'] = { workflow: { id: meta.workflowId, name: meta.workflowName } };
            }
            const promptId = await client.queuePrompt(prompt, { extraData });
            tracker.track({ promptId, ts: new Date().toISOString(), workflowName: meta.workflowName, source: meta.source });
            // meta.json goes down before the run finishes, so the exact prompt,
            // parameters and seeds survive even if DSH restarts mid-generation.
            await archive.recordSubmission({
                promptId,
                workflowName: meta.workflowName,
                ...(meta.workflowId !== undefined ? { workflowId: meta.workflowId } : {}),
                source: meta.source,
                baseUrl: resolved.baseUrl,
                ...(meta.parameters !== undefined && meta.parameters.length > 0 ? { parameters: meta.parameters } : {}),
                values,
                workflow: prompt,
            }).catch((error) => {
                ctx.logger.warn(`dsh-comfyui: could not record run ${promptId} in the archive: ${String(error)}`);
            });
            return { promptId, prompt, values };
        },
        complete: async (promptId, entry) => {
            const items = collectMedia({ promptId, entry, maxItems: resolved.maxMediaItems, proxyBase: runtime.proxyBase() });
            if (items.length === 0)
                return { media: items };
            const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv));
            try {
                const prompt = Array.isArray(entry.prompt) ? entry.prompt[2] : undefined;
                const meta = await archive.archive({
                    promptId,
                    items,
                    download: (ref) => client.fetchViewStreamed(ref),
                    maxBytes: resolved.maxMediaBytes,
                    fallback: {
                        workflowName: tracker.get(promptId)?.workflowName ?? null,
                        source: tracker.get(promptId)?.source ?? 'external',
                        baseUrl: resolved.baseUrl,
                        values: {},
                        workflow: (typeof prompt === 'object' && prompt !== null ? prompt : {}),
                    },
                });
                return { media: archive.localize(promptId, items, meta) };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.logger.warn(`dsh-comfyui: archiving ${promptId} failed: ${message}`);
                return { media: archive.localize(promptId, items, undefined), archiveError: message };
            }
        },
        markRun: async (promptId, status, error) => {
            await archive.markStatus(promptId, status, error).catch(() => undefined);
        },
        untrack: (promptId) => tracker.untrack(promptId),
        trackedRuns: () => tracker.list(),
        queueProgress: (promptId) => progress.get(promptId),
        listWorkflows: () => store.listWorkflows(),
        getWorkflow: (id) => store.getWorkflow(id),
        saveWorkflow: (input) => store.saveWorkflow(input),
        refreshVoiceLibrary: async () => {
            // TTS-Audio-Suite keeps a process-level voice-discovery cache behind the
            // object_info COMBO that does not self-heal: a voice added to disk stays
            // invisible until the cache is invalidated once. Hitting the custom-node
            // endpoint with refresh=1 performs the rescan and invalidates the cache,
            // so the object_info read that follows (refresh-params / action: refresh)
            // reports the current library. Servers without TTS-Audio-Suite answer
            // 404; the failure is swallowed and callers proceed with the object_info
            // snapshot they get anyway.
            const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv));
            return client.getOk('/api/tts-audio-suite/voice-library?refresh=1', 20_000);
        },
        deleteWorkflow: (id) => store.deleteWorkflow(id),
        runRecord: async (promptId) => {
            const archived = await archive.readMeta(promptId);
            if (archived !== undefined && Object.keys(archived.workflow).length > 0) {
                return {
                    workflow: archived.workflow,
                    ...(archived.parameters !== undefined ? { parameters: archived.parameters } : {}),
                    values: archived.values,
                    workflowName: archived.workflowName,
                };
            }
            const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv));
            const entry = await client.getHistory(promptId).catch(() => undefined);
            const prompt = Array.isArray(entry?.prompt) ? entry.prompt[2] : undefined;
            if (typeof prompt !== 'object' || prompt === null)
                return undefined;
            return { workflow: prompt };
        },
        objectInfo: async () => objectInfoCached(runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv))),
        skillPacks,
        uploadInput: async (bytes, filename, opts) => {
            const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv));
            const result = await client.uploadMedia(bytes, filename, uploadContentType(filename), opts);
            return { name: result.name ?? filename, subfolder: result.subfolder ?? opts.subfolder ?? '', type: result.type ?? 'input' };
        },
        listMediaSizes: () => store.loadMediaSizes(),
        saveMediaSize: (name, size) => store.saveMediaSize(name, size),
        lookupMediaHash: (hash) => store.lookupMediaHash(hash),
        saveMediaHash: (hash, name) => store.saveMediaHash(hash, name),
        loadSlots: () => store.loadSlots(),
        saveSlots: (slots) => store.saveSlots(slots),
        listAssets: () => store.listAssets(),
        deleteAsset: (promptId) => store.deleteAsset(promptId),
        sweep: async () => {
            const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv));
            return tracker.sweep({ client, store, complete: async (promptId, entry) => (await runtime.complete(promptId, entry)).media });
        },
        listComfyWorkflows: async () => {
            const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv));
            const entries = await client.listUserData('workflows');
            const library = await store.listWorkflows();
            return entries
                // Dot entries are ComfyUI bookkeeping (e.g. `.index.json`), not graphs.
                .filter((entry) => entry.type === 'file' && entry.name.endsWith('.json')
                && entry.name.split(/[\\/]/).every((segment) => !segment.startsWith('.')))
                .map((entry) => {
                const derived = library.filter((workflow) => workflow.comfyuiFile === entry.name);
                return {
                    name: entry.name,
                    size: entry.size,
                    modified: entry.modified,
                    extracted: derived.length > 0,
                    derived: derived.map((workflow) => ({ libraryId: workflow.id, name: workflow.name })),
                };
            });
        },
        getComfyWorkflow: async (file) => {
            const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv));
            return client.getUserDataFile(`workflows/${file}`);
        },
        analyzeComfyWorkflow: async (file) => {
            const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv));
            const graph = await client.getUserDataFile(`workflows/${file}`);
            return analyzeGraph(graph);
        },
        extractComfyWorkflow: async ({ file, mode }) => {
            const client = runtime.createClient(await resolveApiKey(ctx, resolved.apiKeyEnv));
            const [graph, objectInfo] = await Promise.all([
                client.getUserDataFile(`workflows/${file}`),
                client.objectInfo(),
            ]);
            const analysis = analyzeGraph(graph);
            if (!analysis.ok)
                return { ok: false, error: analysis.error };
            if (analysis.components.length === 0) {
                return { ok: false, error: '图里没有可执行的分量（所有节点都被绕过或悬空）' };
            }
            const base = file.replace(/\.json$/i, '').slice(0, 40);
            const groupLabel = (component) => component.groups.length > 0 ? `（${component.groups.slice(0, 3).join('+')}）` : '';
            const jobs = [];
            if (mode === 'all') {
                jobs.push({
                    name: base,
                    description: `从 ComfyUI 图工作流 ${file} 整体提取：${analysis.components.length} 个分量合成一个运行工作流。`,
                    includeNodeIds: new Set(analysis.components.flatMap((component) => component.nodeIds)),
                });
            }
            else if (mode === 'main') {
                const main = analysis.components[0];
                if (main === undefined) {
                    return { ok: false, error: '图里没有可提取的分量' };
                }
                jobs.push({
                    name: `${base} · 主流程`,
                    description: `从 ComfyUI 图工作流 ${file} 提取主流程（${main.size} 节点）${groupLabel(main)}。`,
                    includeNodeIds: new Set(main.nodeIds),
                });
            }
            else {
                for (const component of analysis.components) {
                    jobs.push({
                        name: `${base} · 分量${component.index}${groupLabel(component)}`,
                        description: `从 ComfyUI 图工作流 ${file} 提取第 ${component.index} 个分量（${component.size} 节点）${groupLabel(component)}。`,
                        includeNodeIds: new Set(component.nodeIds),
                    });
                }
            }
            const saved = [];
            const warnings = [];
            for (const job of jobs) {
                const converted = convertGraphToApi(graph, objectInfo, { includeNodeIds: job.includeNodeIds });
                if (!converted.ok)
                    return { ok: false, error: `${job.name}：${converted.error}` };
                for (const warning of converted.warnings)
                    warnings.push(`${job.name}：${warning}`);
                const hasOutput = Object.values(converted.workflow).some((node) => {
                    const def = objectInfo[node.class_type];
                    return def?.output_node === true;
                });
                if (!hasOutput) {
                    warnings.push(`${job.name}：分量没有任何输出节点（ComfyUI 无法排队），已跳过`);
                    continue;
                }
                const parameters = analyzeWorkflowParameters(converted.workflow, objectInfo);
                const result = await store.saveWorkflow({
                    name: job.name.slice(0, 80),
                    description: job.description,
                    workflow: converted.workflow,
                    parameters,
                    source: 'comfyui',
                    comfyuiFile: file,
                });
                if (!result.ok)
                    return result;
                saved.push(result.workflow);
            }
            if (saved.length === 0) {
                return { ok: false, error: '没有可提取的分量：所有分量都无输出节点或被跳过' };
            }
            return { ok: true, saved, analysis, warnings };
        },
    };
    // The settings section rides the plugin fiber: a host without a settings
    // service simply never registers it, and the entry config stands as composed.
    let source = () => resolved;
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.settings;
        if (typeof settings.installSection === 'function') {
            // dsh 0.1.2–0.1.5: the section registry keeps its own copy of the values.
            settings.installSection(ctx, COMFYUI_NS, Config, resolved, {
                setSource: (current) => {
                    source = current;
                },
                onChange: () => {
                    refreshConfig(resolveConfig(source(), defaultDataDir()));
                },
            });
            return;
        }
        // dsh 0.1.7+/0.2: forms are projected from the volatile Config fields and
        // a save arrives through loader/volatile-update above. On 0.2 the plugin
        // manager page renders that form for every plugin whose policy is
        // `auto: true`, which is where users expect to set the ComfyUI address —
        // so keep it on (the plugin's own settings section stays as a second door
        // with the connection test button).
        if (typeof settings.configure === 'function') {
            const configure = settings.configure.bind(settings);
            settingsCtx.effect(() => configure({ auto: true }, ctx.fiber), 'dsh-comfyui: settings page policy');
        }
    });
    ctx.effect(() => {
        const disposers = registerComfyUITools(ctx, runtime);
        return () => {
            for (const dispose of disposers)
                dispose();
        };
    }, 'dsh-comfyui: tools');
    // The companion skill rides the same optional-services pattern: headless
    // hosts without a skills service simply skip it. Runtime skills register at
    // rank 250, so project/user skills can override the shipped guidance.
    ctx.effect(() => {
        const skills = ctx.get('skills');
        if (skills === undefined)
            return () => { };
        return skills.register({
            ...COMFYUI_SKILL,
            content: COMFYUI_SKILL.content,
        });
    }, 'dsh-comfyui: skill');
    // Routes and the media proxy ride a `webServer` sub-fiber rather than a
    // one-shot `ctx.get` at apply time: loader entries settle concurrently, so
    // reading the service here would silently skip both mounts whenever the web
    // server happens to activate after this plugin. A headless host never
    // activates this fiber and keeps the tools alone.
    ctx.inject(['webServer'], (webCtx) => {
        webCtx.effect(() => {
            const disposers = [];
            // DSH's Connection service, when present, adds its browser-session
            // cookie check on top of the loopback/origin fence.
            const guard = createRouteGuard(() => {
                const connection = webCtx.get('connection');
                return connection !== undefined && typeof connection.admit === 'function' ? connection : undefined;
            });
            const routesDisposer = mountComfyUIRoutes(webCtx, runtime, guard);
            if (routesDisposer !== undefined)
                disposers.push(routesDisposer);
            const proxyDisposer = mountComfyUIProxy(webCtx, runtime, guard);
            if (proxyDisposer !== undefined)
                disposers.push(proxyDisposer);
            // (0.6.0 dropped the index.html ping tap: media URLs are relative now,
            // so the browser's origin no longer needs to be learned.)
            return () => {
                for (const dispose of disposers)
                    dispose();
            };
        }, 'dsh-comfyui: routes and media proxy');
    });
}
