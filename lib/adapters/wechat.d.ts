import { Context } from '@deepseek-ai/cordis';
import { NotificationAdapter } from './base.js';
import { NotifyEvent, WeChatNotifyConfig } from '../types.js';
/** Adapter lifecycle state surfaced to the settings page over RPC. */
export type WeChatAdapterState = 'disabled' | 'login' | 'ready' | 'error';
/** Status payload the settings page renders (login QR, known users, errors). */
export interface WeChatAdapterStatus {
    state: WeChatAdapterState;
    /** Bot account id once logged in. */
    accountId?: string;
    /** QR payload to encode and scan — present while login waits for a scan. */
    qrContent?: string;
    /** Last error message when state is 'error'. */
    error?: string;
    /** Users the bot can currently push to (they messaged the bot before). */
    knownUsers: string[];
}
export declare class WeChatClawBotAdapter implements NotificationAdapter {
    readonly name = "wechat";
    readonly enabled: boolean;
    private ctx;
    private config;
    private sessionFile;
    private channelVersion;
    /** HTTP timeout for iLink GETs (login QR + status); internal test hook. */
    private httpTimeoutMs;
    /** Backoff between transient GET retries; internal test hook. */
    private retryBackoffMs;
    /** Base URL for the QR login flow (no session yet); internal test hook. */
    private loginBaseUrl;
    private session;
    private state;
    private qrContent;
    private lastError;
    /** Aborts the poll/login loops; recreated on every (re)start. */
    private controller;
    /**
     * Inbound-message hook, set by the service when two-way interaction is on.
     * Invoked (fire-and-forget) for every text/voice message a WeChat user
     * sends the bot, AFTER the context token is captured.
     */
    onUserMessage: ((userId: string, text: string) => void | Promise<void>) | undefined;
    constructor(ctx: Context, config: WeChatNotifyConfig, internal?: {
        httpTimeoutMs?: number;
        retryBackoffMs?: number;
        loginBaseUrl?: string;
    });
    /**
     * Current status for the settings page (RPC `notify.wechat.status`).
     */
    getStatus(): WeChatAdapterStatus;
    /**
     * Forget the persisted session and restart the QR login flow.
     * Wired to the RPC `notify.wechat.relogin` endpoint.
     */
    relogin(): Promise<void>;
    /**
     * Send a notification to every reachable WeChat user.
     */
    send(event: NotifyEvent): Promise<void>;
    /**
     * Stop the poll/login loops. Called by the service on config rebuilds and
     * plugin disposal; safe to call multiple times.
     */
    dispose(): void;
    private stopLoops;
    /**
     * Entry point: resume a persisted session or run QR login, then poll.
     */
    private start;
    /**
     * Run the QR login flow: fetch a QR payload, wait for the user to scan and
     * confirm in WeChat, then persist the issued bot token.
     */
    private login;
    /**
     * Long-poll getupdates and capture context tokens from inbound messages.
     * Runs until disposed; session-expiry drops back into the QR login flow.
     */
    private pollLoop;
    /**
     * Whether a WeChat user may drive interactions: the toUserIds allowlist
     * gates replies when set; an empty allowlist allows every known user.
     */
    canInteract(userId: string): boolean;
    /**
     * Push a raw plain-text message to every reachable interactive user
     * (used by the InteractionBridge for prompts and receipts). Skips silently
     * when not logged in or nobody is reachable — interaction pushes are
     * best-effort complements to the Web UI, never hard failures.
     */
    pushText(text: string): Promise<void>;
    /**
     * Resolve push targets: the configured allowlist intersected with users we
     * hold a context token for, or every known user when no allowlist is set.
     */
    private resolveTargets;
    /** POST a plain-text message to one user. */
    private sendMessage;
    /**
     * Plain-text rendering of a notification (iLink text items only).
     *
     * Slim by design: title + message body only. Turn-summary bodies carry just
     * 💬 user prompt and 🤖 AI reply (the source no longer emits 🔧/📊 lines);
     * the type/time footer is redundant (title carries the state, WeChat
     * timestamps the message). Custom metadata outside the standard turn-summary
     * set is still appended.
     */
    private formatText;
    /** Request headers shared by every iLink call. */
    private buildHeaders;
    /**
     * GET an iLink endpoint, retrying transient transport timeouts with backoff.
     * Returns null when aborted by us or when retries are exhausted — callers
     * decide whether null is fatal. Mirrors apiPost's null-on-abort contract so
     * a single network blip can't kill the whole QR login.
     */
    private apiGet;
    /**
     * POST to an iLink endpoint, automatically attaching `base_info` and the
     * Bearer token. Returns null when the request was aborted by us (dispose or
     * a client-side long-poll timeout — both are normal control flow).
     */
    private apiPost;
    private loadSession;
    private saveSession;
}
//# sourceMappingURL=wechat.d.ts.map