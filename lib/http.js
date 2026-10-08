import { rejectUntrusted } from './route-guard.js';
/** Send a JSON response with no-store caching. */
export function sendJson(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    response.end(payload);
}
/** Read and parse a JSON request body; undefined when the body is empty. */
export async function readJsonBody(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '')
        return undefined;
    return JSON.parse(text);
}
/** Read a raw (possibly binary) request body, e.g. for multipart forwarding. */
export async function readRawBody(request) {
    const chunks = [];
    for await (const chunk of request)
        chunks.push(chunk);
    return Buffer.concat(chunks);
}
/**
 * Whether a request passes the browser-trust fence (route-guard.ts): loopback
 * Host, not cross-site, matching Origin. Every route is already wrapped in
 * that guard; this stays for the write handlers' own belt-and-braces checks.
 */
export function sameOrigin(request) {
    return rejectUntrusted(request) === undefined;
}
/** Human-readable error message from an unknown thrown value. */
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
