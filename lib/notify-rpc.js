/**
 * Notify plugin Web RPC (authenticated channel): the Web settings page ⇄ Host
 * notification-configuration channel.
 *
 * The channel is a plain `webServer` prefix route fenced by Connection's own
 * Host/Origin + browser-auth check (`connection.requestRejection`). It does NOT
 * use `ctx.connection.rpc.handle()`: on current dsh-client-connection that
 * registry captures the Connection service's OWN context as the route owner
 * (`get rpc() { const owner = this.ctx; … }`) and registers through
 * `owner.webServer`, which the service's fiber does not inject — a third-party
 * caller gets `Error: cannot get property "webServer" without inject`, and the
 * throw aborts the calling plugin's activation entirely. Registering the route
 * ourselves is the same transport minus that ownership trap; dsh-advisors
 * (same author, same Web page pattern) does the same.
 *
 * THE CONSTANTS BELOW ARE DUPLICATED IN `src/client/rpc.ts` — the browser
 * bundle cannot import a Host file. Keep the channel string, endpoint names,
 * and the wire shapes in lockstep across the two.
 */
export const NOTIFY_RPC_CHANNEL = '/dsh-notify';
export const NOTIFY_ENDPOINTS = Object.freeze({
    configGet: 'notify.config.get',
    configSet: 'notify.config.set',
    wechatStatus: 'notify.wechat.status',
    wechatRelogin: 'notify.wechat.relogin',
    wecomAibotStatus: 'notify.wecom-aibot.status',
    wecomAibotQrStart: 'notify.wecom-aibot.qr-start',
    workspaceRoutesGet: 'notify.workspace-routes.get',
    workspaceRoutesSet: 'notify.workspace-routes.set',
    rulesGet: 'notify.rules.get',
    rulesSet: 'notify.rules.set',
});
/** RPC bodies are small JSON config documents; far above any realistic edit. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Mirrors dsh-client-connection: endpoint segments after the channel prefix. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/** DSH rpcErrorSchema-discriminated success. */
function ok(value) {
    return { ok: true, value };
}
/** Build a `bad-request` RPC error (issues is a free array). */
function fail(message) {
    return { ok: false, error: { code: 'bad-request', message, details: { issues: [{ message }] } } };
}
/** The endpoint after the channel prefix, or undefined for a foreign path. */
function endpointFromPath(channel, pathname) {
    if (!pathname.startsWith(`${channel}/`))
        return undefined;
    const endpoint = pathname.slice(channel.length + 1);
    const segments = endpoint.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..' || !ENDPOINT_SEGMENT_PATTERN.test(s))) {
        return undefined;
    }
    return endpoint;
}
/** Whether a parsed body is a plain JSON object. */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** `server-response` envelope, wire-identical to dsh-client-connection. */
function respondEnvelope(res, rpcId, result) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId, result }));
}
/** One channel request: buffered node:http ⇄ envelope bridge. */
async function serveRpc(req, res, handler) {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
    const endpoint = endpointFromPath(NOTIFY_RPC_CHANNEL, pathname);
    if (req.method !== 'POST' || endpoint === undefined) {
        res.writeHead(404);
        res.end('not found');
        return;
    }
    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
    if (contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        res.writeHead(415);
        res.end('content type must be application/json');
        return;
    }
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        res.writeHead(413, { connection: 'close' });
        res.end();
        req.destroy();
        return;
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
        const buffer = chunk;
        received += buffer.byteLength;
        if (received > MAX_BODY_BYTES) {
            res.writeHead(413, { connection: 'close' });
            res.end();
            req.destroy();
            return;
        }
        chunks.push(buffer);
    }
    let body;
    try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        res.writeHead(400);
        res.end('body is not JSON');
        return;
    }
    const rpcId = typeof body?.rpcId === 'string'
        ? body.rpcId
        : 'invalid-request';
    if (!isRecord(body) || body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') {
        respondEnvelope(res, rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } });
        return;
    }
    if (body.method !== endpoint) {
        respondEnvelope(res, rpcId, {
            ok: false,
            error: {
                code: 'gateway/bad-request',
                message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
                details: {},
            },
        });
        return;
    }
    const abort = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded)
            abort.abort();
    });
    try {
        respondEnvelope(res, rpcId, await handler(endpoint, body.payload, abort.signal));
    }
    catch (error) {
        res.writeHead(500);
        res.end(`handler failure: ${String(error)}`);
    }
}
/**
 * Endpoint dispatch for the notify channel — shared by the mounted route and
 * callable directly by tests.
 * @param bridge - the host notify service surface.
 * @returns a handler mapping one endpoint to its RPC result.
 */
export function createNotifyRpcHandler(bridge) {
    return async (endpoint, payload = {}, signal) => {
        if (signal?.aborted) {
            return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.', details: {} } };
        }
        if (endpoint === NOTIFY_ENDPOINTS.configGet) {
            return ok(bridge.read());
        }
        if (endpoint === NOTIFY_ENDPOINTS.configSet) {
            if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
                return fail('notify.config.set expects an object payload');
            }
            bridge.write(payload);
            return ok(bridge.read());
        }
        if (endpoint === NOTIFY_ENDPOINTS.wechatStatus) {
            if (!bridge.wechatStatus)
                return fail('wechat status is not available');
            return ok(bridge.wechatStatus());
        }
        if (endpoint === NOTIFY_ENDPOINTS.wechatRelogin) {
            if (!bridge.wechatRelogin)
                return fail('wechat relogin is not available');
            return ok(await bridge.wechatRelogin());
        }
        if (endpoint === NOTIFY_ENDPOINTS.wecomAibotStatus) {
            if (!bridge.wecomAibotStatus)
                return fail('wecom-aibot status is not available');
            return ok(bridge.wecomAibotStatus());
        }
        if (endpoint === NOTIFY_ENDPOINTS.wecomAibotQrStart) {
            if (!bridge.wecomAibotQrStart)
                return fail('wecom-aibot qr association is not available');
            return ok(await bridge.wecomAibotQrStart());
        }
        if (endpoint === NOTIFY_ENDPOINTS.workspaceRoutesGet) {
            if (!bridge.workspaceRoutes)
                return fail('workspace routes are not available');
            return ok(bridge.workspaceRoutes());
        }
        if (endpoint === NOTIFY_ENDPOINTS.workspaceRoutesSet) {
            if (!bridge.setWorkspaceRoute)
                return fail('workspace route writes are not available');
            const path = typeof payload?.path === 'string' ? payload.path : '';
            const mode = typeof payload?.mode === 'string' ? payload.mode : '';
            if (path.length === 0 || !['off', 'status', 'full', 'default'].includes(mode))
                return fail('notify.workspace-routes.set expects { path, mode: off|status|full|default }');
            try {
                bridge.setWorkspaceRoute(path, mode);
            }
            catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
            }
            return ok(bridge.workspaceRoutes());
        }
        if (endpoint === NOTIFY_ENDPOINTS.rulesGet) {
            if (!bridge.rules)
                return fail('routing rules are not available');
            return ok(bridge.rules());
        }
        if (endpoint === NOTIFY_ENDPOINTS.rulesSet) {
            if (!bridge.applyRules)
                return fail('routing rule writes are not available');
            if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
                return fail('notify.rules.set expects an object payload');
            try {
                return ok(bridge.applyRules(payload));
            }
            catch (error) {
                return fail(error instanceof Error ? error.message : String(error));
            }
        }
        return fail(`unknown notify endpoint: ${String(endpoint)}`);
    };
}
/**
 * Mount the `/dsh-notify` channel on the host web server.
 *
 * Soft-injected: a deployment without `connection`/`webServer` (headless) skips
 * the channel and keeps notifying. The route is fenced by the same Host/Origin
 * + browser-auth check Connection applies to its own channels.
 *
 * @param ctx - the plugin's host cordis context.
 * @param bridge - service wiring: read the current config and apply a partial write.
 * @param log - optional logger.
 */
export function installNotifyRpc(ctx, bridge, log = {}) {
    ctx.inject(['connection', 'webServer'], (rpcCtxUnknown) => {
        const rpcCtx = rpcCtxUnknown;
        const { connection, webServer } = rpcCtx;
        if (typeof connection?.requestRejection !== 'function' || typeof webServer?.register !== 'function') {
            log.warn?.('[notify] DSH Connection RPC transport unavailable — settings page disabled | 无 Connection/webServer，设置页不可用');
            return;
        }
        const handler = createNotifyRpcHandler(bridge);
        rpcCtx.effect(() => webServer.register({
            kind: 'prefix',
            path: NOTIFY_RPC_CHANNEL,
            handler: async (req, res) => {
                const rejection = connection.requestRejection(req);
                if (rejection !== undefined) {
                    res.writeHead(rejection);
                    res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
                    return;
                }
                await serveRpc(req, res, handler);
            },
        }), `notify: ${NOTIFY_RPC_CHANNEL} rpc channel`);
    });
}
//# sourceMappingURL=notify-rpc.js.map