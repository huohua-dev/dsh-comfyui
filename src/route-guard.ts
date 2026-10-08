/**
 * Browser-trust fence for every /comfyui/* route, modeled on DSH's own
 * `isTrustedApiRequest` (dsh-client-connection) and dsh-image-gen's
 * assertSameOrigin:
 *
 * 1. the Host header must name a loopback address — defeats DNS rebinding
 *    (a hostile page resolving its own name to 127.0.0.1 still sends its own
 *    Host);
 * 2. `Sec-Fetch-Site: cross-site` is refused — no other site's page may make
 *    the browser call these routes, even no-cors GETs or <video src>;
 * 3. an Origin header, when present, must name exactly the same host:port.
 *
 * Unlike the upstream `sameOrigin` this applies to GETs too (media and the
 * archive are readable data) and does not wave through a request just
 * because it carries no Origin.
 *
 * When the host exposes its Connection service, the request must also pass
 * `connection.admit()` — the same fence plus the DSH browser-session cookie
 * (HttpOnly, SameSite=Strict, Path=/), which the page's own fetch and
 * <video> requests carry automatically. That keeps other local processes
 * (anything that can reach 127.0.0.1) out as well.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
export type RouteGuard = (handler: RouteHandler) => RouteHandler

/** localhost, [::1] or any 127/8 address — DSH's loopback set. */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Why a request is refused (status + reason), or undefined when it is trusted. */
export function rejectUntrusted(request: IncomingMessage): { status: 403; reason: string } | undefined {
  const host = header(request, 'host')
  let hostUrl: URL | undefined
  try {
    hostUrl = host === undefined || host === '' ? undefined : new URL(`http://${host}`)
  } catch {
    hostUrl = undefined
  }
  if (hostUrl === undefined || hostUrl.username !== '' || hostUrl.pathname !== '/' || !isLoopbackHostname(hostUrl.hostname)) {
    return { status: 403, reason: 'host-rejected' }
  }
  if (header(request, 'sec-fetch-site') === 'cross-site') return { status: 403, reason: 'cross-site' }
  const origin = header(request, 'origin')
  if (origin === undefined) return undefined
  let originHost: string | undefined
  try {
    originHost = new URL(origin).host
  } catch {
    originHost = undefined
  }
  if (originHost !== hostUrl.host) return { status: 403, reason: 'origin-rejected' }
  return undefined
}

/** The slice of the host Connection service used for browser-session auth. */
export interface ConnectionAdmission {
  admit(request: IncomingMessage): { rejection: number } | { peer: unknown }
}

/**
 * Build the guard. `connection` is read per request (the service may arrive
 * after the routes mount); without it only the loopback/origin fence applies.
 */
export function createRouteGuard(connection: () => ConnectionAdmission | undefined): RouteGuard {
  return (handler) => async (request, response) => {
    const rejected = rejectUntrusted(request)
    if (rejected !== undefined) {
      deny(response, rejected.status, rejected.reason)
      return
    }
    const service = connection()
    if (service !== undefined) {
      const admission = service.admit(request)
      if ('rejection' in admission) {
        deny(response, admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
    }
    await handler(request, response)
  }
}

function deny(response: ServerResponse, status: number, reason: string): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify({ error: reason }))
}
