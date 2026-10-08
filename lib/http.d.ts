/**
 * Small HTTP helpers for the dsh-comfyui routes, mirroring the shapes the
 * dshmarket bundle uses for its own same-origin API.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Send a JSON response with no-store caching. */
export declare function sendJson(response: ServerResponse, status: number, body: unknown): void;
/** Read and parse a JSON request body; undefined when the body is empty. */
export declare function readJsonBody(request: IncomingMessage): Promise<unknown>;
/** Read a raw (possibly binary) request body, e.g. for multipart forwarding. */
export declare function readRawBody(request: IncomingMessage): Promise<Buffer>;
/**
 * Whether a request passes the browser-trust fence (route-guard.ts): loopback
 * Host, not cross-site, matching Origin. Every route is already wrapped in
 * that guard; this stays for the write handlers' own belt-and-braces checks.
 */
export declare function sameOrigin(request: IncomingMessage): boolean;
/** Human-readable error message from an unknown thrown value. */
export declare function errorMessage(error: unknown): string;
