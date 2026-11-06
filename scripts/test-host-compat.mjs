/**
 * Offline host-compatibility test for THIS FORK (dsh-comfyui 0.6.x, DSH 0.2 line).
 *
 * Upstream's copy of this file was written against upstream's own contracts:
 * four tools, no built-in templates, a `settings.configure({ auto: false })`
 * page policy, an index.html ping tap, DSH 0.1.x hosts, the 0.1.x jobs shape
 * (owner = the Agent handle, result in `output`) and a result text that asks
 * the model to paste the image as Markdown. This fork deliberately diverges
 * from every one of those (see CLAUDE.md), so this file tests the FORK's
 * contracts instead:
 *
 *   - five tools: comfyui_run / comfyui_object_info / comfyui_workflow /
 *     comfyui_skill / comfyui_upload;
 *   - the five built-in templates (txt2img, img2img, video, h3_t2v, h3_r2v) are
 *     still shipped and `comfyui_run` still takes a `template`;
 *   - the settings page policy is `{ auto: true }` — DSH 0.2 renders the
 *     plugin's volatile fields as a form on the plugin page;
 *   - there is NO index.html ping tap (media URLs are same-origin relative
 *     paths since 0.6.0), so the tap is asserted to be absent;
 *   - only the DSH 0.2 line installs: `engines.dsh` (read by dsh 0.2.1+) and
 *     the `@deepseek-ai/dsh-settings` peer (read by older hosts) must admit
 *     exactly the same hosts, and the 0.1 line must be rejected;
 *   - the 0.2 jobs contract only: `owner` is the session id (`exec.agent.id`)
 *     and the model-visible result rides `outcome.result` (not `output`);
 *   - the result text is Chinese, names the prompt that was actually
 *     submitted and points at the turn-tail media wall instead of asking the
 *     model to paste a Markdown image (contract 20).
 *
 * Everything runs offline: `globalThis.fetch` and `globalThis.WebSocket` are
 * replaced by stubs before the plugin is imported, the only writes are into
 * `mkdtempSync` directories that are removed again, no process is spawned and
 * the only environment variable read is the fake
 * `COMFYUI_API_KEY_HOST_COMPAT_TEST`.
 *
 * Needs `npm run build:host` first (it imports ../lib/index.js).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The ComfyUI address the stub client is told to talk to. Nothing ever dials
 * it: `globalThis.fetch` and `globalThis.WebSocket` are stubbed below, so the
 * plugin's HTTP calls and its progress socket never leave the process.
 */
const COMFY_BASE = 'http://127.0.0.1:18188'

/** The only environment variable this script may read — a fake one. */
const FAKE_API_KEY_ENV = 'COMFYUI_API_KEY_HOST_COMPAT_TEST'

// The cordis.patch.yml insert entry: `name` is the module specifier the loader
// imports (see section 9). Parsed leniently — a YAML dependency is not allowed.
const patchName = /(?:^|\n)[ \t]*-?[ \t]*name:[ \t]*['"]?([^'"\n]+?)['"]?[ \t]*$/m.exec(
  readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8'),
)?.[1]?.trim()

// ---------------------------------------------------------------------------
// Minimal semver comparator. Covers ONLY caret segments (`^x.y.z` and
// `^x.y.z-prerelease`) and plain comparator sets (`>=a <b`) joined by ` || `
// — exactly the range shapes this manifest uses (peer / engines.dsh).
// `semver` itself is not resolvable from this repo root. If the manifest ever
// adopts ~, *, x-ranges or hyphen ranges, extend this before trusting it.
// ---------------------------------------------------------------------------
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parseVersion(v) {
  const m = VERSION_RE.exec(v)
  if (m === null) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] === undefined ? null : m[4].split('.') }
}

function comparePrerelease(a, b) {
  if (a === null && b === null) return 0
  if (a === null) return 1 // a release sorts above any prerelease of the same triple
  if (b === null) return -1
  for (let i = 0; ; i++) {
    if (i >= a.length && i >= b.length) return 0
    if (i >= a.length) return -1 // fewer identifiers sort lower when equal so far
    if (i >= b.length) return 1
    const x = a[i]
    const y = b[i]
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const d = Number(x) - Number(y)
      if (d !== 0) return Math.sign(d)
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // numeric identifiers sort below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
}

function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return Math.sign(a[k] - b[k])
  }
  return comparePrerelease(a.pre, b.pre)
}

// Caret bounds mirror real semver: lower bound is the segment version itself
// (prerelease included), upper bound bumps the leftmost nonzero component and
// always carries a `-0` prerelease, e.g. `^0.2.0-rc.1` → [0.2.0-rc.1, 0.3.0-0).
function caretBounds(segment) {
  const lo = parseVersion(segment)
  if (lo === null) throw new Error(`unparseable range segment: ^${segment}`)
  let upper
  if (lo.major > 0) upper = `${lo.major + 1}.0.0-0`
  else if (lo.minor > 0) upper = `${lo.major}.${lo.minor + 1}.0-0`
  else upper = `${lo.major}.${lo.minor}.${lo.patch + 1}-0`
  return { lo, hi: parseVersion(upper) }
}

// Space-separated comparator set (`>=a <b`) — the shape of engines.dsh.
function satisfiesComparatorSet(v, set) {
  return set.split(/\s+/).filter(Boolean).every((part) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part)
    const bound = m === null ? null : parseVersion(m[2])
    if (bound === null) throw new Error(`unsupported comparator "${part}"`)
    const d = compareVersions(v, bound)
    switch (m[1] ?? '=') {
      case '>=': return d >= 0
      case '<=': return d <= 0
      case '>': return d > 0
      case '<': return d < 0
      default: return d === 0
    }
  })
}

// Mirrors the host gate: semver.satisfies(version, range, { includePrerelease: true }).
function satisfiesRange(version, range) {
  const v = parseVersion(version)
  if (v === null) throw new Error(`unparseable version: ${version}`)
  return range
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((segment) => {
      if (!segment.startsWith('^')) return satisfiesComparatorSet(v, segment)
      const { lo, hi } = caretBounds(segment.slice(1))
      return compareVersions(v, lo) >= 0 && compareVersions(v, hi) < 0
    })
}

// ---------------------------------------------------------------------------
// Tiny assertion helpers (no test framework, same shape as scripts/test-*.mjs).
// ---------------------------------------------------------------------------
let failures = 0
let passed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function checkDeepEqual(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(name, a === b, `actual=${a} expected=${b}`)
}

// ---------------------------------------------------------------------------
// Stub host context — models only the host boundary seam, never plugin internals.
//
// The logger matters: src/index.ts reports archive failures through
// `ctx.logger.warn`, so a host stub without one turns a degraded path into a
// crash. Every real DSH host has one (tests/fake-host.ts models it the same
// way).
// ---------------------------------------------------------------------------
function createHostStub(extraServices = {}) {
  const calls = {
    tools: [],
    configure: [],
    skillsRegister: [],
    routes: [],
    tapIndex: 0,
    events: {},
    credentialResolve: [],
    logs: [],
  }
  const disposers = []
  const services = {
    // DSH 0.2 host shape: the settings service exposes `configure` (page
    // policy) and no `installSection`.
    settings: {
      configure: (options, fiber) => {
        calls.configure.push({ options, fiber })
        return () => {}
      },
    },
    skills: {
      register: (skill) => {
        calls.skillsRegister.push(skill)
        return () => {}
      },
    },
    webServer: {
      port: 3080,
      register: (route) => {
        calls.routes.push(route)
        return () => {}
      },
      tapIndex: () => {
        calls.tapIndex += 1
        return () => {}
      },
    },
    // Credential store that never resolves — exercises the absent-credential
    // path (resolve → undefined → environment fallback).
    credentials: {
      resolve: async (ref) => {
        calls.credentialResolve.push(ref)
        return undefined
      },
    },
    ...extraServices,
  }

  const ctx = {
    fiber: { id: 'host-compat-stub-fiber' },
    logger: {
      info: (...args) => calls.logs.push(['info', ...args]),
      warn: (...args) => calls.logs.push(['warn', ...args]),
      error: (...args) => calls.logs.push(['error', ...args]),
      debug: (...args) => calls.logs.push(['debug', ...args]),
    },
    tools: {
      register: (definition) => {
        calls.tools.push(definition)
        return () => {}
      },
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on: (event, cb) => {
      ;(calls.events[event] ??= []).push(cb)
      return () => {}
    },
    get: (name) => services[name],
    inject: (deps, cb) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return () => {}
      const child = Object.create(ctx)
      for (const dep of deps) child[dep] = services[dep]
      cb(child)
      return () => {}
    },
  }
  return { ctx, calls, disposers }
}

function disposeAll(disposers) {
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch {
      // best-effort teardown only
    }
  }
}

// ---------------------------------------------------------------------------
// Stub ComfyUI server. `globalThis.fetch` is replaced wholesale, so no request
// ever leaves the process; the plugin's own HTTP client code is exercised for
// real (route prefix learning, history polling, /view download, cancel).
// ---------------------------------------------------------------------------
function createComfyStub(opts = {}) {
  const state = {
    promptId: opts.promptId ?? '00000000-0000-4000-8000-000000000000',
    /** 'success' | 'error' | 'empty' (the prompt is still unknown / running). */
    historyMode: opts.historyMode ?? 'success',
    outputs: opts.outputs ?? { 9: { images: [{ filename: 'compat_00001_.png', subfolder: '', type: 'output' }] } },
    queue: opts.queue ?? { queue_running: [], queue_pending: [] },
    /** The archive download fails (ComfyUI /view answers 404). */
    viewFails: opts.viewFails === true,
    /** The API prompts that were queued, in order. */
    submitted: [],
    /** The mutating requests that reached the server (queue delete, interrupt). */
    posts: [],
    requests: [],
  }
  const stub = async (url, init) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    state.requests.push(`${method} ${path}`)
    const json = (body) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path === '/prompt' && method === 'POST') {
      state.submitted.push(JSON.parse(String(init?.body ?? '{}')).prompt)
      return json({ prompt_id: state.promptId, number: 1 })
    }
    if (path === `/history/${state.promptId}`) {
      if (state.historyMode === 'empty') return json({})
      if (state.historyMode === 'error') {
        return json({
          [state.promptId]: {
            status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'boom', exception_type: 'RuntimeError' }]] },
            outputs: {},
          },
        })
      }
      return json({
        [state.promptId]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: state.outputs,
        },
      })
    }
    if (path === '/view') {
      // A tiny PNG-ish payload: the local archive downloads it for real.
      if (state.viewFails) return new Response('not found', { status: 404 })
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }
    if (path === '/queue' && method === 'GET') return json(state.queue)
    if (path === '/queue' && method === 'POST') {
      state.posts.push({ path, body: String(init?.body ?? '') })
      return json({})
    }
    if (path === '/interrupt' && method === 'POST') {
      state.posts.push({ path, body: String(init?.body ?? '') })
      return json({})
    }
    // ComfyUI < 0.39 has no atomic per-job cancel endpoint — the client has to
    // fall back to the dequeue / targeted-interrupt pair.
    if (path.startsWith('/api/jobs/') && path.endsWith('/cancel')) {
      return new Response('not found', { status: 404 })
    }
    return new Response('not found', { status: 404 })
  }
  return { stub, state }
}

/** The ComfyUI server address as the plugin sees it. */
const COMFY_CONFIG = { baseUrl: COMFY_BASE, apiKeyEnv: FAKE_API_KEY_ENV }

/** A minimal hand-written API workflow (comfyui_run takes nothing else now). */
const handWritten = () => ({
  8: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 1, color: 0 } },
  9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'compat' } },
})

/** The calling session, as the host hands it to a tool: `exec.agent.id`. */
const agent = { id: 'compat-session' }

const realFetch = globalThis.fetch
const realWebSocket = globalThis.WebSocket

/** The progress tracker must not open a socket either — stub it out. */
class OfflineWebSocket {
  constructor(url) {
    this.url = String(url)
    this.readyState = 0
  }

  addEventListener() {}

  removeEventListener() {}

  send() {}

  close() {
    this.readyState = 3
  }
}

globalThis.WebSocket = OfflineWebSocket

const { apply } = await import('../lib/index.js')

// ---------------------------------------------------------------------------
// 1. Load seam: apply(ctx, entryConfig) against a 0.2-shaped host.
// ---------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-'))
const { ctx, calls, disposers } = createHostStub()

let applyCompleted = false
try {
  await apply(ctx, { ...COMFY_CONFIG, dataDir })
  applyCompleted = true
} catch (error) {
  console.log(`  FAIL apply(ctx, entryConfig) threw — ${error && error.stack ? error.stack : error}`)
  failures += 1
}
// The signal is the registrations apply left behind, not the absence of a throw.
check(
  'apply(ctx, entryConfig) completes against a 0.2-shaped host and registers onto it',
  applyCompleted && calls.tools.length > 0 && calls.configure.length > 0,
  `completed=${applyCompleted} tools=${calls.tools.length} configure=${calls.configure.length}`,
)

checkDeepEqual(
  'exactly 5 tools register with the expected names',
  calls.tools.map((t) => t.name).sort(),
  ['comfyui_object_info', 'comfyui_run', 'comfyui_skill', 'comfyui_upload', 'comfyui_workflow'],
)
for (const tool of calls.tools) {
  const out = tool.output
  const usable =
    out !== null && typeof out === 'object' && out.schema !== null && typeof out.schema === 'object' &&
    typeof out.render === 'function'
  check(`tool ${tool.name} carries a usable output (schema + render)`, usable, `output=${JSON.stringify(out)}`)
}

check(
  'settings.configure({ auto: true }, ctx.fiber) called exactly once (DSH 0.2 plugin-page form)',
  calls.configure.length === 1 &&
    JSON.stringify(calls.configure[0]?.options) === JSON.stringify({ auto: true }) &&
    calls.configure[0]?.fiber === ctx.fiber,
  `configure calls=${JSON.stringify(calls.configure.map((c) => c.options))}`,
)
check(
  'skills.register called (companion skill)',
  calls.skillsRegister.length >= 1 &&
    typeof calls.skillsRegister[0]?.name === 'string' &&
    calls.skillsRegister[0].name.length > 0,
  `registered=${JSON.stringify(calls.skillsRegister.map((s) => s.name))}`,
)
check('webServer route mounting called', calls.routes.length > 0, `routes registered=${calls.routes.length}`)
check(
  'no index.html ping tap is registered (media URLs are same-origin relative paths since 0.6.0)',
  calls.tapIndex === 0,
  `tapIndex calls=${calls.tapIndex}`,
)
check(
  "event subscription for 'loader/volatile-update' registered",
  (calls.events['loader/volatile-update']?.length ?? 0) >= 1,
  `events=${JSON.stringify(Object.keys(calls.events))}`,
)

// The one fully-offline tool path (comfyui_workflow action 'list'): it must
// consult the credential store and still answer.
const workflowTool = calls.tools.find((t) => t.name === 'comfyui_workflow')
if (workflowTool === undefined) {
  failures += 1
  console.log('  FAIL comfyui_workflow tool not found — cannot exercise the credentials path')
} else {
  try {
    const result = await workflowTool.execute({ action: 'list' }, {})
    check(
      'comfyui_workflow action:list executes offline without throwing',
      result !== null && typeof result === 'object' && result.action === 'list',
      `result.action=${JSON.stringify(result?.action)}`,
    )
    check(
      'credentials.resolve consulted and absent credential handled (environment fallback)',
      calls.credentialResolve.length >= 1 && calls.credentialResolve.includes(FAKE_API_KEY_ENV),
      `resolve calls=${JSON.stringify(calls.credentialResolve)}`,
    )
    // The listing is the agent's map of the library: the server address and
    // the load area have to be in it (CLAUDE.md: `env` is read fresh on every
    // call, contract 11 exposes the load area through the same call).
    check(
      'action:list reports the ComfyUI server address (env is read fresh on every call)',
      result.env?.baseUrl === COMFY_BASE && Array.isArray(result.env?.comfyuiDirs),
      `env=${JSON.stringify(result.env)}`,
    )
    check(
      'action:list exposes the load area (slot count + what is loaded)',
      typeof result.loadArea?.slots === 'number' && typeof result.loadArea?.loaded === 'number' &&
        Array.isArray(result.loadArea?.items),
      `loadArea=${JSON.stringify(result.loadArea)}`,
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL credentials path threw — ${error && error.stack ? error.stack : error}`)
  }
}

// ---------------------------------------------------------------------------
// 2. Route guard (contract 18): every mounted /comfyui/* route — reads
//    included — has to pass the browser-trust fence: loopback Host, no
//    cross-site fetch, matching Origin.
// ---------------------------------------------------------------------------
check(
  'src/route-guard.ts is present (the trust fence this fork ships)',
  existsSync(join(repoRoot, 'src', 'route-guard.ts')),
)
{
  const ping = calls.routes.find((r) => r.path === '/comfyui/ping')
  check('the /comfyui/ping route is mounted', ping !== undefined, `routes=${calls.routes.length}`)
  if (ping !== undefined) {
    const call = async (headers) => {
      const state = { status: 0, body: '' }
      const response = {
        writeHead(status) {
          state.status = status
        },
        setHeader() {},
        end(body) {
          state.body = body === undefined ? '' : String(body)
        },
      }
      await ping.handler({ method: 'GET', url: '/comfyui/ping', headers }, response)
      return state
    }
    const foreign = await call({ host: '192.0.2.10:3080' })
    check('route guard: a non-loopback Host is refused (403)', foreign.status === 403, `status=${foreign.status}`)
    const crossSite = await call({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })
    check('route guard: Sec-Fetch-Site: cross-site is refused (403)', crossSite.status === 403, `status=${crossSite.status}`)
    const crossOrigin = await call({ host: '127.0.0.1:3080', origin: 'http://evil.example.com' })
    check('route guard: a foreign Origin is refused (403)', crossOrigin.status === 403, `status=${crossOrigin.status}`)
    const own = await call({ host: '127.0.0.1:3080' })
    check('route guard: the page\'s own loopback request is served (200)', own.status === 200, `status=${own.status}`)
  }
}
disposeAll(disposers)
rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

// ---------------------------------------------------------------------------
// 3. Built-in templates: this fork KEEPS them (upstream removed them), and
//    `comfyui_run` still takes a `template` argument.
// ---------------------------------------------------------------------------
{
  const comfy = createComfyStub({ promptId: '11111111-0000-4000-8000-000000000001' })
  globalThis.fetch = comfy.stub
  const stub = createHostStub()
  const templateDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-templates-'))
  try {
    await apply(stub.ctx, { ...COMFY_CONFIG, dataDir: templateDir })
    const run = stub.calls.tools.find((t) => t.name === 'comfyui_run')
    checkDeepEqual(
      'comfyui_run still offers the five built-in templates',
      run.parameters?.properties?.template?.enum,
      ['txt2img', 'img2img', 'video', 'h3_t2v', 'h3_r2v'],
    )

    const value = await run.execute(
      { template: 'txt2img', inputs: { 6: { text: 'a red fox' } } },
      { agent, signal: new AbortController().signal },
    )
    const queued = comfy.state.submitted.at(-1)
    check(
      'comfyui_run { template: "txt2img" } resolves to the built-in API workflow and runs it',
      value?.kind === 'sync' && value?.status === 'completed' &&
        queued?.['3']?.class_type === 'KSampler' && queued?.['9']?.class_type === 'SaveImage' &&
        queued?.['6']?.inputs?.text === 'a red fox',
      `queued=${JSON.stringify(queued)}`,
    )

    let refused = ''
    try {
      await run.execute({ template: 'no-such-template' }, { agent, signal: new AbortController().signal })
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    check(
      'comfyui_run: an unknown template id is refused and the available ids are named',
      refused.includes('unknown template "no-such-template"') &&
        ['txt2img', 'img2img', 'video', 'h3_t2v', 'h3_r2v'].every((id) => refused.includes(id)) &&
        comfy.state.submitted.length === 1,
      refused,
    )

    let refusedParam = ''
    try {
      await run.execute(
        { template: 'h3_t2v', parameters: { promt: 'a red fox' } },
        { agent, signal: new AbortController().signal },
      )
    } catch (error) {
      refusedParam = error instanceof Error ? error.message : String(error)
    }
    check(
      'comfyui_run: a misspelt template parameter is refused, nothing is queued',
      refusedParam.includes('has no parameter promt') && refusedParam.includes('available: prompt') &&
        comfy.state.submitted.length === 1,
      `error=${JSON.stringify(refusedParam)} submitted=${comfy.state.submitted.length}`,
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL template checks threw — ${error && error.stack ? error.stack : error}`)
  } finally {
    disposeAll(stub.disposers)
    rmSync(templateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}
globalThis.fetch = realFetch

// ---------------------------------------------------------------------------
// 4. Install gate: this fork targets the DSH 0.2 line ONLY. dsh 0.2.1+ reads
//    `engines.dsh` alone (older hosts read the dsh-settings peer), so the two
//    ranges must accept and refuse exactly the same hosts.
// ---------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const gates = {
  'engines.dsh': manifest.engines?.dsh,
  'dsh-settings peer': manifest.peerDependencies?.['@deepseek-ai/dsh-settings'],
}
/** The host releases this fork is verified against (tests/compat.spec.ts). */
const SUPPORTED_HOSTS = ['0.2.0-rc.2', '0.2.1-rc.1']
/** Every 0.2 host the ranges must admit. */
const ADMITTED_HOSTS = ['0.2.0-rc.2', '0.2.0', '0.2.1-alpha.1', '0.2.1-rc.1', '0.2.1', '0.2.9']
/** Every host the ranges must refuse: the 0.1 line, a pre-rc 0.2 build, 0.3. */
const REJECTED_HOSTS = [
  '0.1.1', '0.1.5-alpha.1', '0.1.6-alpha.2', '0.1.7-alpha.1', '0.1.7-rc.2',
  '0.2.0-rc.1', '0.3.0-alpha.1', '0.3.0',
]
for (const [gate, range] of Object.entries(gates)) {
  check(`manifest declares ${gate}`, typeof range === 'string' && range.length > 0, `range=${JSON.stringify(range)}`)
  if (typeof range !== 'string') continue
  const refused = ADMITTED_HOSTS.filter((version) => !satisfiesRange(version, range))
  check(`${gate} admits every 0.2 host`, refused.length === 0, `refused=${refused.join(', ')} range=${range}`)
  const accepted = REJECTED_HOSTS.filter((version) => satisfiesRange(version, range))
  check(`${gate} rejects the 0.1 line, pre-rc 0.2 builds and 0.3`, accepted.length === 0, `accepted=${accepted.join(', ')} range=${range}`)
  const missing = SUPPORTED_HOSTS.filter((version) => !satisfiesRange(version, range))
  check(`${gate} admits the host releases we build against`, missing.length === 0, `missing=${missing.join(', ')} range=${range}`)
}
{
  const engineRange = gates['engines.dsh']
  const peerRange = gates['dsh-settings peer']
  if (typeof engineRange === 'string' && typeof peerRange === 'string') {
    const disagree = [...ADMITTED_HOSTS, ...REJECTED_HOSTS, ...SUPPORTED_HOSTS]
      .filter((version) => satisfiesRange(version, engineRange) !== satisfiesRange(version, peerRange))
    check(
      'engines.dsh and the dsh-settings peer agree on every probed host',
      disagree.length === 0,
      `disagree=${disagree.join(', ')} engines=${engineRange} peer=${peerRange}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 5. Jobs contract (DSH 0.2 only): `owner` is the session id, the
//    model-visible result rides `outcome.result`, and the background receipt
//    points at the turn-tail media wall instead of a pasted Markdown image.
// ---------------------------------------------------------------------------
for (const outcome of ['success', 'error']) {
  const comfy = createComfyStub({
    promptId: '22222222-0000-4000-8000-000000000002',
    historyMode: outcome,
  })
  globalThis.fetch = comfy.stub
  const specs = []
  const stub = createHostStub({
    jobs: {
      start: (spec) => {
        specs.push(spec)
        return 'job-1'
      },
    },
  })
  const jobDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-jobs-'))
  try {
    await apply(stub.ctx, { ...COMFY_CONFIG, dataDir: jobDir, pollIntervalMs: 200 })
    const run = stub.calls.tools.find((t) => t.name === 'comfyui_run')
    const value = await run.execute(
      { template: 'h3_t2v', parameters: { prompt: 'a red fox in snow' }, mode: 'async' },
      { agent, signal: new AbortController().signal },
    )
    check(
      `jobs (${outcome}): comfyui_run async starts one background job`,
      value?.kind === 'background' && value.jobId === 'job-1' && specs.length === 1,
      JSON.stringify(value),
    )
    // The receipt the model reads.
    const receipt = run.output.render({}, value)[0]?.text ?? ''
    check(
      `jobs (${outcome}): background receipt names the job, points at the turn-tail card and the job tools`,
      receipt.includes('job-1') && receipt.includes('22222222-0000-4000-8000-000000000002') &&
        receipt.includes("below this turn's reply") && receipt.includes('job_output') &&
        receipt.includes('job_kill') && receipt.includes('no need to paste links'),
      receipt,
    )
    check(
      `jobs (${outcome}): background receipt does not use the upstream "end your turn / completion notice" wording`,
      !receipt.includes('end your turn') && !receipt.includes('completion notice'),
      receipt,
    )
    const spec = specs[0]
    check(
      `jobs (${outcome}): owner is the session id (exec.agent.id), not the Agent handle`,
      spec?.owner === agent.id,
      `owner=${JSON.stringify(spec?.owner)}`,
    )
    const progress = []
    const hooks = spec.run({ id: 'job-1', append: () => {}, updateProgress: (line) => progress.push(line) })
    const done = await hooks.done
    check(
      `jobs (${outcome}): progress lines are published once per change (no repeats)`,
      progress[0] === '已提交，等待 ComfyUI' &&
        progress.every((line, index) => index === 0 || line !== progress[index - 1]),
      JSON.stringify(progress),
    )
    if (outcome === 'success') {
      const text = typeof done.result === 'string' ? done.result : ''
      check(
        'jobs (success): the completed outcome carries the result text in `result` only',
        done.status === 'completed' && text.length > 0 && !('output' in done),
        JSON.stringify({ status: done.status, keys: Object.keys(done) }),
      )
      check(
        'jobs (success): the result text names the prompt that was actually submitted',
        text.includes('Prompt used (prompt): "a red fox in snow"'),
        text,
      )
      check(
        'jobs (success): the result text says the media shows below the reply (no paste-Markdown instruction)',
        text.includes('这些文件会显示在调用这次生成的那一轮回复下方') && !text.includes('!['),
        text,
      )
    } else {
      check(
        'jobs (error): the failed outcome surfaces the ComfyUI error in `result` (and `detail`), never in `output`',
        done.status === 'failed' && typeof done.result === 'string' && done.result.length > 0 &&
          typeof done.detail === 'string' && done.detail.includes('ComfyUI execution failed') &&
          !('output' in done),
        JSON.stringify(done),
      )
    }
    // No key may be present-but-undefined (lossless-JSON validation).
    check(
      `jobs (${outcome}): outcome has no undefined-valued keys`,
      Object.values(done).every((v) => v !== undefined),
      JSON.stringify(done),
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL jobs (${outcome}) threw — ${error && error.stack ? error.stack : error}`)
  } finally {
    disposeAll(stub.disposers)
    rmSync(jobDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}
globalThis.fetch = realFetch

// ---------------------------------------------------------------------------
// 5a. job_kill cancels THIS prompt only: dequeue while pending, targeted
//     interrupt while running — never a bare /interrupt that would stop
//     whatever ComfyUI is running (another session's job). The killed job
//     settles as `killed`, and exactly one cancel request leaves the plugin.
// ---------------------------------------------------------------------------
for (const where of ['pending', 'running']) {
  const promptId = '33333333-0000-4000-8000-000000000003'
  const comfy = createComfyStub({
    promptId,
    historyMode: 'empty',
    queue: where === 'pending'
      ? { queue_running: [[0, 'someone-else', {}, {}, []]], queue_pending: [[1, promptId, {}, {}, []]] }
      : { queue_running: [[1, promptId, {}, {}, []]], queue_pending: [] },
  })
  globalThis.fetch = comfy.stub
  const specs = []
  const stub = createHostStub({
    jobs: {
      start: (spec) => {
        specs.push(spec)
        return 'job-cancel'
      },
    },
  })
  const cancelDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-cancel-'))
  try {
    await apply(stub.ctx, { ...COMFY_CONFIG, dataDir: cancelDir, pollIntervalMs: 200 })
    const run = stub.calls.tools.find((t) => t.name === 'comfyui_run')
    await run.execute(
      { workflow: handWritten(), mode: 'async' },
      { agent, signal: new AbortController().signal },
    )
    const progress = []
    const hooks = specs[0].run({ id: 'job-cancel', append: () => {}, updateProgress: (line) => progress.push(line) })
    await new Promise((resolve) => setTimeout(resolve, 150))
    hooks.cancel('test')
    const done = await hooks.done
    const expected = where === 'pending'
      ? { path: '/queue', body: `{"delete":["${promptId}"]}` }
      : { path: '/interrupt', body: `{"prompt_id":"${promptId}"}` }
    check(
      `job_kill while ${where}: exactly one cancel request, scoped to this prompt (${expected.path})`,
      comfy.state.posts.length === 1 && comfy.state.posts[0].path === expected.path &&
        comfy.state.posts[0].body === expected.body,
      `posts=${JSON.stringify(comfy.state.posts)}`,
    )
    check(`job_kill while ${where}: job settles as killed`, done.status === 'killed', JSON.stringify(done))
    check(
      `job_kill while ${where}: progress lines are published once per change (no repeats)`,
      progress[0] === '已提交，等待 ComfyUI' &&
        progress.every((line, index) => index === 0 || line !== progress[index - 1]),
      JSON.stringify(progress),
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL job_kill while ${where} threw — ${error && error.stack ? error.stack : error}`)
  } finally {
    disposeAll(stub.disposers)
    rmSync(cancelDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  // `done` settles as soon as the job is killed, but the aborted work is still
  // unwinding: it records the cancelled run in the archive on its way out,
  // which would re-create the directory the finally block just removed. Give
  // it a moment, then sweep again so no temp directory survives the run.
  await new Promise((resolve) => setTimeout(resolve, 200))
  rmSync(cancelDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
globalThis.fetch = realFetch

// ---------------------------------------------------------------------------
// 5b. Sync result: final, with the media archived locally — the model's reply
//     is not the display path any more (contract 20), the turn-tail media wall
//     is, so the text points there instead of handing out a Markdown image.
// ---------------------------------------------------------------------------
{
  const comfy = createComfyStub({
    promptId: '44444444-0000-4000-8000-000000000004',
    outputs: { 9: { images: [{ filename: 'sync_00001_.png', subfolder: '', type: 'output' }] } },
  })
  globalThis.fetch = comfy.stub
  const stub = createHostStub()
  const syncDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-sync-'))
  try {
    await apply(stub.ctx, { ...COMFY_CONFIG, dataDir: syncDir, pollIntervalMs: 200 })
    const run = stub.calls.tools.find((t) => t.name === 'comfyui_run')
    const value = await run.execute(
      { workflow: handWritten() },
      { agent, signal: new AbortController().signal },
    )
    const text = run.output.render({}, value)[0]?.text ?? ''
    check(
      'sync result: final, names the prompt and points at the media wall (no pasted Markdown image)',
      text.includes('ComfyUI completed (prompt 44444444-0000-4000-8000-000000000004)') &&
        text.includes('这就是最终结果') && text.includes('这些文件会显示在调用这次生成的那一轮回复下方') &&
        !text.includes('!['),
      text,
    )
    check(
      'sync result: the media is served from the local archive first, the proxy URL is the fallback',
      value.media?.[0]?.url?.startsWith('/comfyui/archive/44444444-0000-4000-8000-000000000004/') &&
        value.media?.[0]?.proxyUrl?.startsWith('/comfyui/media?file=sync_00001_.png'),
      JSON.stringify(value.media?.[0]),
    )
    check(
      'sync result: the same text travels in `report` (the path that renders no tool card)',
      typeof value.report === 'string' && value.report === text,
      JSON.stringify(value.report),
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL sync result check threw — ${error && error.stack ? error.stack : error}`)
  } finally {
    disposeAll(stub.disposers)
    rmSync(syncDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  globalThis.fetch = realFetch
}

// ---------------------------------------------------------------------------
// 5c. A failing archive degrades the run, it does not break it: the media
//     keeps its ComfyUI proxy URL, the reason comes back as `archiveError`,
//     and the host logger is told about it (src/index.ts logs through
//     `ctx.logger.warn` — a host stub without a logger turns this degraded
//     path into a crash).
// ---------------------------------------------------------------------------
{
  const promptId = '66666666-0000-4000-8000-000000000006'
  const comfy = createComfyStub({ promptId, viewFails: true })
  globalThis.fetch = comfy.stub
  const stub = createHostStub()
  const archiveDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-archive-'))
  try {
    await apply(stub.ctx, { ...COMFY_CONFIG, dataDir: archiveDir, pollIntervalMs: 200 })
    const run = stub.calls.tools.find((t) => t.name === 'comfyui_run')
    const value = await run.execute(
      { workflow: handWritten() },
      { agent, signal: new AbortController().signal },
    )
    check(
      'archive failure: the run still completes and says why the archive is missing',
      value.status === 'completed' && typeof value.archiveError === 'string' &&
        value.archiveError.length > 0,
      JSON.stringify({ status: value.status, archiveError: value.archiveError }),
    )
    check(
      'archive failure: the media falls back to the ComfyUI proxy URL',
      value.media?.[0]?.url?.startsWith('/comfyui/media?file=compat_00001_.png'),
      JSON.stringify(value.media?.[0]),
    )
    check(
      'archive failure: the host logger is told about it (ctx.logger.warn)',
      stub.calls.logs.some(([level, message]) => level === 'warn' && String(message).includes(promptId)),
      JSON.stringify(stub.calls.logs),
    )
    check(
      'archive failure: the result text warns that the card plays through the ComfyUI proxy',
      run.output.render({}, value)[0]?.text?.includes('注意：本地归档失败') === true,
      run.output.render({}, value)[0]?.text,
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL archive-failure check threw — ${error && error.stack ? error.stack : error}`)
  } finally {
    disposeAll(stub.disposers)
    rmSync(archiveDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  globalThis.fetch = realFetch
}

// ---------------------------------------------------------------------------
// 5d. Saved-workflow runs: unknown parameter names are refused before
//     anything is queued; the result names the prompt actually submitted (and
//     flags a silently used default); the same text travels in `report` for the
//     code-dispatched callers that render no tool card.
// ---------------------------------------------------------------------------
{
  const comfy = createComfyStub({ promptId: '55555555-0000-4000-8000-000000000005' })
  globalThis.fetch = comfy.stub
  const wfDir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-host-compat-wf-'))
  writeFileSync(join(wfDir, 'workflows.json'), JSON.stringify([{
    id: 'wf-test',
    name: 'Compat T2I',
    description: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workflow: {
      3: { class_type: 'KSampler', inputs: { seed: 1, steps: 8, model: ['4', 0], positive: ['6', 0] } },
      4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: 'a default cat', clip: ['4', 1] } },
      8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0] } },
      9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
    },
    parameters: [
      { id: 'p1', name: 'prompt', label: '提示词', type: 'string', nodeId: '6', inputKey: 'text', default: 'a default cat' },
      { id: 'p2', name: 'seed', label: '种子', type: 'number', nodeId: '3', inputKey: 'seed', default: 1 },
    ],
  }]))
  const stub = createHostStub()
  try {
    await apply(stub.ctx, { ...COMFY_CONFIG, dataDir: wfDir, pollIntervalMs: 200 })
    const tool = stub.calls.tools.find((t) => t.name === 'comfyui_workflow')
    const direct = { agent, signal: new AbortController().signal, callId: 'call-1', rootCallId: 'call-1' }
    const render = (value) => tool.output.render({}, value)[0]?.text ?? ''

    const listing = await tool.execute({ action: 'list' }, direct)
    const listingText = render(listing)
    check(
      'workflow list: every parameter is listed with its label and default',
      listing.workflows?.[0]?.parameters?.length === 2 &&
        listingText.includes('  prompt(提示词，默认 "a default cat")') &&
        listingText.includes('  seed(种子，默认 1)'),
      listingText,
    )

    let refused = ''
    try {
      await tool.execute({ action: 'run', id: 'wf-test', parameters: { promt: 'a red fox' } }, direct)
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    check(
      'workflow run: a misspelt parameter name is refused and nothing is queued',
      refused.includes('不是工作流') && refused.includes('可用：prompt, seed') &&
        comfy.state.submitted.length === 0,
      `error=${JSON.stringify(refused)} submitted=${comfy.state.submitted.length}`,
    )

    const passed = await tool.execute({ action: 'run', id: 'wf-test', parameters: { prompt: 'a red fox in snow' } }, direct)
    const passedText = render(passed)
    check(
      'workflow run: the passed prompt is submitted and reported back by name',
      comfy.state.submitted.at(-1)?.['6']?.inputs?.text === 'a red fox in snow' &&
        passedText.includes('Prompt used (prompt): "a red fox in snow"'),
      passedText,
    )

    const defaulted = await tool.execute({ action: 'run', id: 'wf-test' }, direct)
    check(
      'workflow run: a prompt left out is reported as the default that was used',
      render(defaulted).includes('Prompt used (prompt, default — not passed): "a default cat"'),
      render(defaulted),
    )

    const nested = await tool.execute(
      { action: 'run', id: 'wf-test', parameters: { prompt: 'a lighthouse' } },
      { agent, signal: new AbortController().signal, callId: 'call-2:ptc:1', rootCallId: 'call-2', parent: { token: 'run_code' } },
    )
    check(
      'workflow run from run_code: the value carries `report` with the same account',
      typeof nested.result?.report === 'string' &&
        nested.result.report.includes('Prompt used (prompt): "a lighthouse"') &&
        !nested.result.report.includes('!['),
      JSON.stringify(nested.result?.report),
    )
  } catch (error) {
    failures += 1
    console.log(`  FAIL saved-workflow run checks threw — ${error && error.stack ? error.stack : error}`)
  } finally {
    disposeAll(stub.disposers)
    rmSync(wfDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  globalThis.fetch = realFetch
}

// ---------------------------------------------------------------------------
// 6. Identity consistency: every artifact the host resolves BY PACKAGE NAME
//    must carry the current package name (a fork that renames the package must
//    not have to chase literals). Two failure modes were hit in the field:
//      - cordis.patch.yml `name` is the module specifier the cordis loader
//        imports; a stale value leaves the bundle layer composed while the
//        plugin module never loads.
//      - the client bundle banner registers the factory id the renderer's
//        module graph looks up by graph-row id (= package name); a stale
//        banner makes the row fall back to its one-resource URL, re-executes
//        the bundle and aborts web boot with `duplicate factory registration`.
// ---------------------------------------------------------------------------
check(
  'cordis.patch.yml entry name equals the npm package name',
  patchName === manifest.name,
  `patch=${JSON.stringify(patchName)} package=${JSON.stringify(manifest.name)}`,
)
const clientBundlePath = join(repoRoot, 'client', 'client.js')
if (existsSync(clientBundlePath)) {
  const clientBundle = readFileSync(clientBundlePath, 'utf8')
  const bannerId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientBundle)?.[1]
  check(
    'client bundle registers under the npm package name (renderer module-graph id)',
    bannerId === manifest.name,
    `banner=${JSON.stringify(bannerId)} package=${JSON.stringify(manifest.name)}`,
  )
} else {
  console.log('  skip  client bundle not built (npm run build:client) — the bundle-id check needs it')
}

globalThis.fetch = realFetch
globalThis.WebSocket = realWebSocket

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log(`\nall ${passed} checks passed — the fork's DSH 0.2 contracts hold (install gates, load seam, templates, jobs, routes, package identity)`)
process.exit(0)
