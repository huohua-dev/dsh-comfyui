/**
 * Media proxy: serves generated ComfyUI files to the browser through the
 * same-origin route /comfyui/media?file=&subfolder=&type= (legacy:
 * ?prompt=&node=&index=), so the client never talks to the ComfyUI server
 * directly (no CORS, no mixed content, no key in the browser). A file that
 * was archived locally is served from disk without touching ComfyUI.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ComfyUIClient } from './comfyui.js'
import { guessContentType } from './comfyui.js'
import type { ComfyUIMediaRef } from './comfyui.js'
import { errorMessage, sendJson } from './http.js'
import type { ComfyUIRuntime } from './tools.js'
import { serveLocalFile } from './archive.js'
import type { RouteGuard } from './route-guard.js'

/**
 * Relay one ComfyUI /view download to the browser in streaming fashion.
 * Browser <audio>/<video> players seek with `Range: bytes=…` requests; without
 * 206 + Content-Range support the seekable range stays empty (progress bar
 * snaps back) and long audio's duration can be mis-derived. ComfyUI's /view
 * handles Range natively, so re-emit its status/headers and pipe the body
 * through — a 206 pass-through costs nothing extra.
 */
async function relayViewStream(
  client: ComfyUIClient,
  ref: ComfyUIMediaRef,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestMethod: 'GET' | 'HEAD' = request.method === 'HEAD' ? 'HEAD' : 'GET'
  const { status, headers, body } = await client.fetchViewStreamed(ref, request.headers.range, requestMethod)
  const head: Record<string, string | number> = {
    'content-type': headers.get('content-type') ?? guessContentType(ref.filename),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  }
  const contentLength = headers.get('content-length')
  if (contentLength !== null) head['content-length'] = contentLength
  const contentRange = headers.get('content-range')
  if (contentRange !== null) head['content-range'] = contentRange
  response.writeHead(status, head)
  if (requestMethod === 'HEAD' || body === null) {
    response.end()
    return
  }
  await pipeline(Readable.fromWeb(body), response)
}

/** ComfyUI's /view folder types; anything else is refused before it reaches the server. */
const VIEW_TYPES = new Set(['output', 'input', 'temp'])

/**
 * Validate a /view reference taken from the query string. ComfyUI joins
 * `subfolder` and `filename` onto its folder itself (and checks containment),
 * but this proxy must not depend on that: a bare file name, a relative
 * forward-slash subfolder without `..`/absolute/backslash/NUL segments, and a
 * known folder type are the only shapes passed on.
 */
export function checkViewRef(ref: ComfyUIMediaRef): string | undefined {
  if (!VIEW_TYPES.has(ref.type)) return `type must be one of ${[...VIEW_TYPES].join(', ')}`
  const bad = (value: string): boolean => /[\\\u0000]/.test(value) || value.split('/').some((segment) => segment === '..' || segment === '.')
  if (ref.filename === '' || ref.filename.includes('/') || bad(ref.filename) || ref.filename.startsWith('.')) return 'invalid file name'
  if (ref.subfolder !== '' && (ref.subfolder.startsWith('/') || /^[A-Za-z]:/.test(ref.subfolder) || bad(ref.subfolder) || ref.subfolder.split('/').some((segment) => segment === ''))) {
    return 'invalid subfolder'
  }
  return undefined
}

/**
 * Mount the media proxy route on the host web server. The local archive is
 * consulted first, so any media URL the plugin ever handed out keeps playing
 * after ComfyUI goes offline, as long as the run was archived.
 * @returns the disposer, or undefined when no web server is present.
 */
export function mountComfyUIProxy(ctx: Context, runtime: ComfyUIRuntime, guard: RouteGuard = (handler) => handler): (() => void) | undefined {
  const webServer = ctx.get('webServer') as {
    register(route: { kind: string; path: string; handler(request: IncomingMessage, response: ServerResponse): void | Promise<void> }): () => void
  } | undefined
  if (webServer === undefined) return undefined

  const serveArchived = async (request: IncomingMessage, response: ServerResponse, promptId: string, name: string): Promise<boolean> => {
    const file = await runtime.archive.resolveFile(promptId, name)
    if (file === undefined) return false
    await serveLocalFile(request, response, { path: file.path, size: file.size })
    return true
  }

  return webServer.register({
    kind: 'exact',
    path: '/comfyui/media',
    handler: guard(async (request, response) => {
      runtime.hostHint.record(request)
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const prompt = url.searchParams.get('prompt')
      const node = url.searchParams.get('node')
      const indexText = url.searchParams.get('index')
      const file = url.searchParams.get('file')
      try {
        if (file !== null) {
          const ref = { filename: file, subfolder: url.searchParams.get('subfolder') ?? '', type: url.searchParams.get('type') ?? 'output' }
          const problem = checkViewRef(ref)
          if (problem !== undefined) {
            sendJson(response, 400, { error: problem })
            return
          }
          const local = await runtime.archive.findByRef(ref)
          if (local !== undefined && await serveArchived(request, response, local.promptId, local.name)) return
          const client = runtime.createClient(await runtime.getApiKey())
          await relayViewStream(client, ref, request, response)
          return
        }
        if (prompt === null || node === null || indexText === null) {
          sendJson(response, 400, { error: 'prompt, node, and index query parameters are required (or file + subfolder + type)' })
          return
        }
        const index = Number(indexText)
        if (!Number.isInteger(index) || index < 0) {
          sendJson(response, 400, { error: 'index must be a non-negative integer' })
          return
        }
        const meta = await runtime.archive.readMeta(prompt)
        const archived = meta?.files.find((entry) => entry.node === node && entry.index === index)
        if (archived !== undefined && await serveArchived(request, response, prompt, archived.name)) return
        const client = runtime.createClient(await runtime.getApiKey())
        const entry = await client.getHistory(prompt)
        const outputs = entry?.outputs ?? {}
        const nodeOutput = outputs[node]
        const collections: Array<Array<{ filename: string; subfolder: string; type: string }> | undefined> = [
          nodeOutput?.images,
          nodeOutput?.videos,
          nodeOutput?.gifs,
          nodeOutput?.audio,
        ]
        let ref = collections
          .flatMap((items) => items ?? [])
          [index]
        if (ref === undefined) {
          // ComfyUI's /history is in-memory: a server restart or a "clear
          // history" click drops the entry and this lookup fails even though
          // the file is still on disk. The plugin's own asset index keeps the
          // file reference for every run it submitted, so fall back to it.
          const assets = await runtime.listAssets()
          const item = assets
            .find((asset) => asset.promptId === prompt)
            ?.media.find((entry) => entry.node === node && entry.index === index)
          if (item === undefined) {
            sendJson(response, 404, { error: `no media item ${node}[${index}] for prompt ${prompt} (history evicted and not in the asset index)` })
            return
          }
          ref = { filename: item.filename, subfolder: item.subfolder, type: item.type }
        }
        const problem = checkViewRef(ref)
        if (problem !== undefined) {
          sendJson(response, 400, { error: problem })
          return
        }
        await relayViewStream(client, ref, request, response)
      } catch (error) {
        if (response.headersSent) {
          // Headers already on the wire (mid-stream failure): close quietly.
          response.end()
        } else {
          sendJson(response, 502, { error: errorMessage(error) })
        }
      }
    }),
  })
}
