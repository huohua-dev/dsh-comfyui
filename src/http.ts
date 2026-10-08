/**
 * Small HTTP helpers for the dsh-comfyui routes, mirroring the shapes the
 * dshmarket bundle uses for its own same-origin API.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { rejectUntrusted } from './route-guard.js'

/** Send a JSON response with no-store caching. */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** Read and parse a JSON request body; undefined when the body is empty. */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return undefined
  return JSON.parse(text) as unknown
}

/** Read a raw (possibly binary) request body, e.g. for multipart forwarding. */
export async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/**
 * Whether a request passes the browser-trust fence (route-guard.ts): loopback
 * Host, not cross-site, matching Origin. Every route is already wrapped in
 * that guard; this stays for the write handlers' own belt-and-braces checks.
 */
export function sameOrigin(request: IncomingMessage): boolean {
  return rejectUntrusted(request) === undefined
}

/** Human-readable error message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
