/**
 * Boots the real plugin `apply()` (src/index.ts) inside a minimal stand-in
 * for the DSH 0.2 host: a tools registry, the jobs registry double, and a
 * node:http web server that routes like dsh-host-webserver (exact table, then
 * longest prefix). Tests talk to the plugin exactly as the model (tool
 * execute) and the browser (HTTP) would.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import { fakeJobs } from './helpers.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export interface ToolDef {
  name: string
  execute(args: Record<string, unknown>, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown>
  output: { render(args: unknown, value: unknown): Array<{ type: string; text: string }>; presentationMeta?(args: unknown, value: unknown): unknown }
}

export interface FakeHost {
  /** Origin of the fake DSH web server, e.g. http://127.0.0.1:PORT. */
  origin: string
  port: number
  dataDir: string
  tools: Map<string, ToolDef>
  jobs: ReturnType<typeof fakeJobs>
  /** Execute a tool as session `session-1`. */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  /** Browser-like fetch against the plugin routes (loopback Host + auth cookie by default). */
  fetch(path: string, init?: RequestInit & { rawHeaders?: Record<string, string> }): Promise<Response>
  dispose(): Promise<void>
}

/** Cookie the fake connection service accepts as an authenticated browser session. */
export const AUTH_COOKIE = 'dsh-auth-test=ok'

export async function bootPlugin(config: Record<string, unknown>, opts: { connection?: boolean } = {}): Promise<FakeHost> {
  const dataDir = typeof config.dataDir === 'string' && config.dataDir !== ''
    ? config.dataDir
    : await mkdtemp(join(tmpdir(), 'dsh-comfyui-test-'))
  const disposers: Array<() => unknown> = []
  const tools = new Map<string, ToolDef>()
  const jobs = fakeJobs(['session-1'])
  const exact = new Map<string, Handler>()
  const prefixes = new Map<string, Handler>()
  const webServer = {
    port: 0,
    host: '127.0.0.1',
    register(route: { kind: string; path: string; handler: Handler }) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route ${route.path}`)
      table.set(route.path, route.handler)
      return () => { table.delete(route.path) }
    },
    tapIndex() { return () => {} },
  }
  const connection = {
    admit(req: IncomingMessage) {
      return (req.headers.cookie ?? '').split(/;\s*/).includes(AUTH_COOKIE) ? { peer: {} } : { rejection: 401 }
    },
  }
  const services: Record<string, unknown> = {
    jobs,
    webServer,
    ...(opts.connection !== false ? { connection } : {}),
  }
  const ctx: Record<string, unknown> = {
    fiber: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition: ToolDef) {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
    effect(callback: () => unknown) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => unknown)
    },
    on() { return () => {} },
    get(name: string) { return services[name] },
    inject(names: string[], callback: (sub: unknown) => void) {
      if (!names.every((name) => services[name] !== undefined)) return
      const sub = Object.create(ctx) as Record<string, unknown>
      for (const name of names) sub[name] = services[name]
      callback(sub)
    },
  }
  await apply(ctx as never, { ...config, dataDir } as never)

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    let handler = exact.get(path)
    if (handler === undefined) {
      let best = ''
      for (const [prefix, candidate] of prefixes) {
        if ((path === prefix || path.startsWith(`${prefix}/`)) && prefix.length > best.length) {
          best = prefix
          handler = candidate
        }
      }
    }
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  webServer.port = port
  const origin = `http://127.0.0.1:${port}`

  return {
    origin,
    port,
    dataDir,
    tools,
    jobs,
    call(name, args, signal) {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`no tool ${name}`)
      return tool.execute(args, { agent: { id: 'session-1' }, signal: signal ?? new AbortController().signal })
    },
    fetch(path, init = {}) {
      const headers = new Headers(init.headers)
      if (!headers.has('cookie')) headers.set('cookie', AUTH_COOKIE)
      return globalThis.fetch(`${origin}${path}`, { ...init, headers })
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
