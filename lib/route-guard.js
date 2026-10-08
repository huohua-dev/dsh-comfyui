/** localhost, [::1] or any 127/8 address — DSH's loopback set. */
export function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
function header(request, name) {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
}
/** Why a request is refused (status + reason), or undefined when it is trusted. */
export function rejectUntrusted(request) {
    const host = header(request, 'host');
    let hostUrl;
    try {
        hostUrl = host === undefined || host === '' ? undefined : new URL(`http://${host}`);
    }
    catch {
        hostUrl = undefined;
    }
    if (hostUrl === undefined || hostUrl.username !== '' || hostUrl.pathname !== '/' || !isLoopbackHostname(hostUrl.hostname)) {
        return { status: 403, reason: 'host-rejected' };
    }
    if (header(request, 'sec-fetch-site') === 'cross-site')
        return { status: 403, reason: 'cross-site' };
    const origin = header(request, 'origin');
    if (origin === undefined)
        return undefined;
    let originHost;
    try {
        originHost = new URL(origin).host;
    }
    catch {
        originHost = undefined;
    }
    if (originHost !== hostUrl.host)
        return { status: 403, reason: 'origin-rejected' };
    return undefined;
}
/**
 * Build the guard. `connection` is read per request (the service may arrive
 * after the routes mount); without it only the loopback/origin fence applies.
 */
export function createRouteGuard(connection) {
    return (handler) => async (request, response) => {
        const rejected = rejectUntrusted(request);
        if (rejected !== undefined) {
            deny(response, rejected.status, rejected.reason);
            return;
        }
        const service = connection();
        if (service !== undefined) {
            const admission = service.admit(request);
            if ('rejection' in admission) {
                deny(response, admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden');
                return;
            }
        }
        await handler(request, response);
    };
}
function deny(response, status, reason) {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(JSON.stringify({ error: reason }));
}
