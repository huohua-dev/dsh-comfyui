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
import type { IncomingMessage, ServerResponse } from 'node:http';
export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
export type RouteGuard = (handler: RouteHandler) => RouteHandler;
/** localhost, [::1] or any 127/8 address — DSH's loopback set. */
export declare function isLoopbackHostname(hostname: string): boolean;
/** Why a request is refused (status + reason), or undefined when it is trusted. */
export declare function rejectUntrusted(request: IncomingMessage): {
    status: 403;
    reason: string;
} | undefined;
/** The slice of the host Connection service used for browser-session auth. */
export interface ConnectionAdmission {
    admit(request: IncomingMessage): {
        rejection: number;
    } | {
        peer: unknown;
    };
}
/**
 * Build the guard. `connection` is read per request (the service may arrive
 * after the routes mount); without it only the loopback/origin fence applies.
 */
export declare function createRouteGuard(connection: () => ConnectionAdmission | undefined): RouteGuard;
