import { Context } from '@deepseek-ai/cordis';
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
export declare const NOTIFY_RPC_CHANNEL = "/dsh-notify";
export declare const NOTIFY_ENDPOINTS: Readonly<{
    configGet: "notify.config.get";
    configSet: "notify.config.set";
    wechatStatus: "notify.wechat.status";
    wechatRelogin: "notify.wechat.relogin";
    wecomAibotStatus: "notify.wecom-aibot.status";
    wecomAibotQrStart: "notify.wecom-aibot.qr-start";
}>;
/** The persistence + apply surface the host notify service exposes to the channel. */
export interface NotifyRpcBridge {
    /** Read the current effective config. */
    read(): unknown;
    /** Apply a partial config to the running service and persist it. */
    write(partial: unknown): void;
    /** Read the WeChat ClawBot adapter status (login state, QR payload, users). */
    wechatStatus?(): unknown;
    /** Forget the WeChat session and restart QR login; returns the new status. */
    wechatRelogin?(): unknown | Promise<unknown>;
    /** Read the WeCom AI Bot status (adapter state, known chats, QR attempt). */
    wecomAibotStatus?(): unknown;
    /** Start a WeCom AI Bot QR association; returns the QR payload to render. */
    wecomAibotQrStart?(): unknown | Promise<unknown>;
}
/**
 * Endpoint dispatch for the notify channel — shared by the mounted route and
 * callable directly by tests.
 * @param bridge - the host notify service surface.
 * @returns a handler mapping one endpoint to its RPC result.
 */
export declare function createNotifyRpcHandler(bridge: NotifyRpcBridge): (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;
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
export declare function installNotifyRpc(ctx: Context, bridge: NotifyRpcBridge, log?: {
    warn?: (...args: unknown[]) => void;
}): void;
//# sourceMappingURL=notify-rpc.d.ts.map