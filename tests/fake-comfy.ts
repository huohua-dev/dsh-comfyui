/**
 * An in-process ComfyUI v0.39 stand-in: just the routes this plugin calls,
 * with the queue semantics that matter for cancellation (one running prompt,
 * a pending list, history on completion) and a request log so tests can
 * assert exactly which prompt ids each control call touched.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

export interface FakePrompt {
  id: string
  number: number
  prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  clientId?: string
}

export interface LoggedRequest {
  method: string
  path: string
  body?: unknown
}

export interface FakeComfy {
  url: string
  log: LoggedRequest[]
  running: FakePrompt[]
  pending: FakePrompt[]
  history: Map<string, Record<string, unknown>>
  /** Files served by /view (and written by /upload/image), keyed `type/subfolder/filename`. */
  files: Map<string, Buffer>
  /** Interrupt flags raised per prompt id (what a real server would abort). */
  interrupted: string[]
  /** Whether /api/jobs/{id}/cancel exists (false = older server → 404). */
  jobsCancelRoute: boolean
  /** Move the head of pending to running (what the executor does). */
  startNext(): FakePrompt | undefined
  /** Finish the running prompt with one video output. */
  finishRunning(bytes?: Buffer, filename?: string): string | undefined
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** ComfyUI's /upload/image naming: without overwrite, a clash becomes `name (1).ext`. */
function freeName(files: Map<string, Buffer>, subfolder: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  for (let i = 1; files.has(`input/${subfolder}/${candidate}`); i += 1) candidate = `${stem} (${i})${ext}`
  return candidate
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

export async function startFakeComfy(): Promise<FakeComfy> {
  let counter = 0
  const state: Omit<FakeComfy, 'url' | 'close'> & { server?: Server } = {
    log: [],
    running: [],
    pending: [],
    history: new Map(),
    files: new Map(),
    interrupted: [],
    jobsCancelRoute: true,
    startNext() {
      const next = state.pending.shift()
      if (next !== undefined) state.running.push(next)
      return next
    },
    finishRunning(bytes = Buffer.from('fake-mp4-bytes-0123456789'), filename) {
      const done = state.running.shift()
      if (done === undefined) return undefined
      const name = filename ?? `dsh_${String(done.number).padStart(5, '0')}_.mp4`
      state.files.set(`output/video/${name}`, bytes)
      state.history.set(done.id, {
        prompt: [done.number, done.id, done.prompt, {}, []],
        outputs: { '14': { images: [{ filename: name, subfolder: 'video', type: 'output' }], animated: [true] } },
        status: { status_str: 'success', completed: true, messages: [] },
      })
      return done.id
    },
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.pathname
      const bytes = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0)
      if (path === '/upload/image' && req.method === 'POST') {
        // Multipart like the real server: field "image" (file), "subfolder", "overwrite".
        const form = await new Response(bytes, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData()
        const file = form.get('image')
        if (typeof file === 'string' || file === null) return json(res, 400, { error: 'image field required' })
        const subfolder = String(form.get('subfolder') ?? '')
        const overwrite = ['true', '1'].includes(String(form.get('overwrite') ?? 'false'))
        const name = overwrite ? file.name : freeName(state.files, subfolder, file.name)
        const content = Buffer.from(await file.arrayBuffer())
        state.files.set(`input/${subfolder}/${name}`, content)
        state.log.push({ method: 'POST', path, body: { filename: file.name, subfolder, overwrite, size: content.length } })
        return json(res, 200, { name, subfolder, type: 'input' })
      }
      const raw = bytes.toString('utf8')
      let body: unknown
      try { body = raw === '' ? undefined : JSON.parse(raw) } catch { body = raw }
      state.log.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, ...(body !== undefined ? { body } : {}) })

      if (path === '/system_stats') return json(res, 200, { system: { comfyui_version: '0.39.0' } })
      if (path === '/object_info') return json(res, 200, {})
      if (path === '/prompt' && req.method === 'POST') {
        const payload = body as { prompt: FakePrompt['prompt']; client_id?: string; prompt_id?: string }
        counter += 1
        const item: FakePrompt = { id: payload.prompt_id ?? randomUUID(), number: counter, prompt: payload.prompt, clientId: payload.client_id }
        state.pending.push(item)
        return json(res, 200, { prompt_id: item.id, number: item.number, node_errors: {} })
      }
      if (path.startsWith('/history/')) {
        const id = decodeURIComponent(path.slice('/history/'.length))
        const entry = state.history.get(id)
        return json(res, 200, entry === undefined ? {} : { [id]: entry })
      }
      if (path === '/queue' && req.method === 'GET') {
        const row = (p: FakePrompt) => [p.number, p.id, p.prompt, {}, []]
        return json(res, 200, { queue_running: state.running.map(row), queue_pending: state.pending.map(row) })
      }
      if (path === '/queue' && req.method === 'POST') {
        const payload = body as { delete?: string[]; clear?: boolean }
        if (payload.clear === true) state.pending.length = 0
        for (const id of payload.delete ?? []) {
          const index = state.pending.findIndex((p) => p.id === id)
          if (index !== -1) state.pending.splice(index, 1)
        }
        res.writeHead(200)
        return res.end()
      }
      if (path === '/interrupt' && req.method === 'POST') {
        // v0.39: targeted when prompt_id names the running prompt, global otherwise.
        const id = (body as { prompt_id?: string } | undefined)?.prompt_id
        const current = state.running[0]
        if (id === undefined) {
          if (current !== undefined) state.interrupted.push(current.id)
        } else if (current?.id === id) {
          state.interrupted.push(id)
        }
        res.writeHead(200)
        return res.end()
      }
      const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path)
      if (cancel !== null && req.method === 'POST') {
        if (!state.jobsCancelRoute) return json(res, 404, { error: 'not found' })
        const id = decodeURIComponent(cancel[1]!)
        if (state.running.some((p) => p.id === id)) {
          state.interrupted.push(id)
          return json(res, 200, { cancelled: true })
        }
        const index = state.pending.findIndex((p) => p.id === id)
        if (index !== -1) {
          state.pending.splice(index, 1)
          return json(res, 200, { cancelled: true })
        }
        return json(res, 200, { cancelled: false })
      }
      if (path === '/view') {
        const key = `${url.searchParams.get('type') ?? 'output'}/${url.searchParams.get('subfolder') ?? ''}/${url.searchParams.get('filename') ?? ''}`
        const file = state.files.get(key)
        if (file === undefined) return json(res, 404, { error: 'missing' })
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
        if (range !== null) {
          const start = Number(range[1])
          const end = range[2] === '' ? file.length - 1 : Math.min(Number(range[2]), file.length - 1)
          res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${file.length}` })
          return res.end(req.method === 'HEAD' ? undefined : file.subarray(start, end + 1))
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': file.length })
        return res.end(req.method === 'HEAD' ? undefined : file)
      }
      json(res, 404, { error: `no route ${path}` })
    })().catch((error: unknown) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return Object.assign(state, {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }) as FakeComfy
}
