/**
 * Host hint: remember the origin browsers use to reach this web server, so
 * generated media URLs (tool results) point at an address the requesting
 * browser can actually load. The hint is derived from the Host header and the
 * Referer of every /comfyui/* request the browser makes: a panel load records
 * the Host header before any generation happens, and a media <img> fetch
 * carries the page's own URL in Referer — which recovers the external origin
 * even when an earlier generated URL already fell back to loopback.
 *
 * Loopback origins (127.0.0.1/localhost) never displace an already-seen
 * external origin: server-side tool calls and local debug requests must not
 * overwrite the address remote browsers use.
 */
import type { IncomingMessage } from 'node:http';
/**
 * The server's own first reachable LAN origin (e.g. http://192.0.2.10:3080),
 * used as the media-URL fallback before loopback. Picks the first non-internal
 * IPv4 that is not loopback or link-local. Returns undefined when no such
 * address exists (no network interface), in which case callers keep loopback.
 */
export declare function detectLanOrigin(port: number): string | undefined;
export interface HostHint {
    /** Record the origin of one request (Host header + Referer + forwarded proto). */
    record(request: IncomingMessage): void;
    /** The best-known origin: the last external one, else the last loopback one, else undefined. */
    origin(): string | undefined;
}
/** Create a host hint accumulator. */
export declare function createHostHint(): HostHint;
