import { Context, Service } from '@deepseek-ai/cordis';
import { WeComAiBotState } from './adapters/wecom-aibot.js';
import { WeChatAdapterStatus } from './adapters/wechat.js';
import { NotifyEvent, NotifyPluginConfig } from './types.js';
/** Status of the WeCom AI Bot channel surfaced to the settings page (RPC). */
export interface WeComAiBotStatus {
    /** Adapter lifecycle; 'disabled' when the channel is off or unconfigured. */
    state: WeComAiBotState;
    /** Last adapter error (e.g. invalid credentials). */
    error?: string;
    /** Chats the bot can push to (learned from inbound messages). */
    knownChats: string[];
    /** QR-association attempt state ('idle' when no attempt is running). */
    qr: {
        phase: 'idle' | 'pending' | 'error';
        /** URL to render as a QR code while phase is 'pending'. */
        authUrl?: string;
        error?: string;
    };
}
/**
 * Main notification service for DSH
 *
 * Manages multiple notification adapters and dispatches events to enabled channels.
 */
export declare class NotifyService extends Service {
    private config;
    private adapters;
    /** Whether session event listeners have been registered (at most once). */
    private listenersRegistered;
    /** Chat two-way interaction bridge; null until attachHost() runs. */
    private bridge;
    /** In-flight WeCom AI Bot QR-association attempt, if any. */
    private qrAssociation;
    /** Last QR-association error, surfaced until the next attempt. */
    private qrError;
    private qrDisposed;
    /**
     * Called after the service changed its own config (QR association filled
     * in botId/secret) so the host can persist it. Set by the plugin entry.
     */
    onConfigChanged: (() => void | Promise<void>) | undefined;
    /**
     * Last pushed TODO-list signature per session, for dedupe. todo_write fires
     * on every task status flip; we only push when the PROGRESS actually moves
     * (completed count, total, or item contents change), not on pure
     * pending↔in_progress churn.
     */
    private lastTodoSignature;
    constructor(ctx: Context, config?: NotifyPluginConfig);
    /**
     * Wire the host interaction seams and start the chat bridge.
     *
     * The bridge composes with the current host APIs directly
     * (`approval/request` + `user-questions/request` waterfalls, the session
     * controller, the workspace registry) — there is no longer an API gateway to
     * wait for, so this runs unconditionally at mount and the bridge simply
     * stays idle until an interactive channel is configured. It survives
     * adapter rebuilds because its hooks resolve the CURRENT adapters on every
     * call.
     */
    attachHost(): void;
    /** The current WeChat adapter, if the channel is initialized. */
    private getWechatAdapter;
    /** The current Telegram adapter, if the channel is initialized. */
    private getTelegramAdapter;
    /** The current WeCom AI Bot adapter, if the channel is initialized. */
    private getWecomAibotAdapter;
    /** Whether the WeChat channel is configured for two-way interaction. */
    private wechatInteractiveEnabled;
    /** Whether the Telegram channel is configured for two-way interaction. */
    private telegramInteractiveEnabled;
    /** Whether the WeCom AI Bot channel is configured for two-way interaction. */
    private wecomAibotInteractiveEnabled;
    /** Whether an adapter participates in interaction (its plain push of an answerable event would duplicate the bridge's prompt). */
    private isInteractiveAdapter;
    /**
     * Start/stop the interaction bridge and (de)wire the adapters' inbound
     * message hooks according to the live config. Called after every adapter
     * (re)build and config update.
     */
    private syncInteraction;
    /**
     * Check if the plugin is enabled
     */
    isEnabled(): boolean;
    /**
     * Send a notification through all enabled channels
     */
    send(event: NotifyEvent): Promise<void>;
    /**
     * Convenience method: notify when conversation completes
     */
    notifyConversationCompleted(title: string, message: string, metadata?: any): Promise<void>;
    /**
     * Convenience method: notify when conversation pauses
     */
    notifyConversationPaused(title: string, message: string, metadata?: any): Promise<void>;
    /**
     * Convenience method: notify when conversation fails
     */
    notifyConversationFailed(title: string, message: string, metadata?: any): Promise<void>;
    /**
     * Convenience method: notify when authorization is required
     */
    notifyAuthorizationRequired(title: string, message: string, metadata?: any): Promise<void>;
    /**
     * Convenience method: notify when confirmation is required
     */
    notifyConfirmationRequired(title: string, message: string, metadata?: any): Promise<void>;
    /**
     * Convenience method: notify the agent's TODO list and its progress
     */
    notifyTodoProgress(title: string, message: string, metadata?: any): Promise<void>;
    /**
     * Current configuration
     */
    getConfig(): Required<NotifyPluginConfig>;
    /**
     * Status of the WeChat ClawBot adapter (login state, QR payload, reachable
     * users) for the settings page. Returns `{ state: 'disabled', knownUsers: [] }`
     * when the channel is off or the adapter failed to initialize.
     */
    getWechatStatus(): WeChatAdapterStatus;
    /**
     * Forget the persisted WeChat session and restart the QR login flow.
     * No-op when the channel is not enabled.
     */
    reloginWechat(): Promise<WeChatAdapterStatus>;
    /**
     * Status of the WeCom AI Bot channel for the settings page: adapter state,
     * reachable chats, and the in-flight QR-association attempt.
     */
    getWecomAibotStatus(): WeComAiBotStatus;
    /**
     * Start (or restart) a WeCom AI Bot QR association: fetch a QR payload,
     * then poll in the background until the user scans and confirms in 企业微信.
     * On success the issued BotId/Secret are written into the live config (the
     * channel is enabled), adapters rebuild, and `onConfigChanged` fires so the
     * host persists the credentials. Returns the QR payload to render.
     */
    startWecomAibotQr(): Promise<{
        authUrl: string;
    }>;
    /** One poll tick; schedule the next only after this request settles. */
    private pollQrAssociation;
    /** Cancel generation, polling, and both scheduled timers together. */
    private stopQrAssociation;
    /**
     * Update configuration at runtime.
     *
     * Merges the patch into the current config and REBUILDS the adapter list so
     * channel enable/disable changes take effect immediately. Without the
     * rebuild, `send()` would keep dispatching to adapter instances created at
     * startup whose readonly `enabled` flag still reflects the old config — a
     * channel disabled in the settings page would keep receiving notifications
     * (and a channel enabled at runtime would never start working).
     */
    updateConfig(newConfig: Partial<NotifyPluginConfig>): void;
    /**
     * Field-wise deep merge of the `channels` and `events` groups so a partial
     * update (e.g. only `channels.wecom`) does not reset sibling channels to
     * defaults. Top-level scalars from the patch win.
     */
    private deepMerge;
    /**
     * Dispose current adapters and rebuild them from the live config.
     */
    private rebuildAdapters;
    /**
     * Dispose and drop all current adapters (best-effort, errors are logged).
     */
    private teardownAdapters;
    /**
     * Dispose all adapters
     */
    dispose(): Promise<void>;
    /**
     * Merge user configuration with defaults
     */
    private mergeConfig;
    /**
     * Initialize notification adapters based on configuration
     */
    private initializeAdapters;
    /**
     * Register event listeners for DSH lifecycle events
     */
    private registerEventListeners;
    /**
     * Handle an `ask_user_question` tool call: the model paused the turn and is
     * waiting for the human to answer a question. Emits a "需要确认" notification
     * with the question text, options, and workspace context.
     * @param session - the Session instance.
     * @param event - the tool/call event.
     */
    private handleUserQuestion;
    /**
     * Best-effort parse of a tool call's `arguments` JSON string.
     */
    private parseToolArguments;
    /**
     * Handle a `todo_write` tool call: the agent published/updated its task
     * list. Emits a "TODO 进度" notification with the checklist and a
     * completed/total progress count.
     *
     * Noise control: todo_write fires on EVERY status flip, so a push is sent
     * only when the progress signature actually moves — completed count, total
     * count, or item contents changed since the last push for this session.
     * Pure pending↔in_progress churn (the agent merely picking up the next
     * task) does not push.
     * @param session - the Session instance.
     * @param event - the tool/call event.
     */
    private handleTodoUpdate;
    /**
     * Handle a `todo/write` session event: dsh-tool-todo appended a whole-list
     * snapshot (`event.data.todos`, already validated by the tool's invariant).
     * Shares the dedupe + push logic with the legacy tool/call path.
     * @param session - the Session instance.
     * @param event - the todo/write event.
     */
    private handleTodoWrite;
    /**
     * Push a TODO progress notification for a task-list snapshot, with
     * per-session signature dedupe (see handleTodoUpdate's noise-control note).
     * @param session - the Session instance.
     * @param todos - the task list snapshot.
     */
    private pushTodoProgress;
    /**
     * Handle an `approval/asked` session event: the model is requesting
     * authorization to perform a sensitive operation. Emits a "需要授权"
     * notification with the tool name, reason, and workspace context.
     * @param session - the Session instance.
     * @param event - the approval/asked event.
     */
    private handleApprovalRequest;
    /**
     * Whether a session is a delegated SUBAGENT child. DSH stamps subagent
     * sessions with `header.origin === 'subagent'` and a `delegationDepth`
     * greater than zero (top-level sessions have neither); accept either signal
     * so older hosts without `origin` are still recognized.
     */
    private isSubagentSession;
    /**
     * Check if a given event type should trigger notifications
     */
    private shouldNotify;
    /**
     * Build a rich human-readable summary of a turn from the session log:
     * the user's last question, the assistant's reply excerpt, the tools used,
     * the conversation title, and the workspace.
     * @param session - the Session instance passed to the session/event listener.
     * @param turn - the turn number that just ended.
     * @returns a display message plus structured details for metadata.
     */
    private extractTurnSummary;
    /**
     * Whether a user/message text is host-injected context rather than the
     * user's own words: XML-ish injection blocks (`<system-reminder>`,
     * `<hindsight_knowledge>`, …) or the runtime-context snapshot header.
     */
    private isInjectedContext;
    /**
     * Flatten message content blocks (text / reasoning / tool-call) into plain text.
     */
    /**
     * Flatten message content blocks into plain text. Only `text` blocks count —
     * `reasoning`/thinking blocks are the model's internal reasoning and must
     * never leak into notifications.
     */
    private extractText;
    /**
     * Extract a readable error message from a turn/end error reason.
     */
    private extractErrorMessage;
}
export default NotifyService;
//# sourceMappingURL=service.d.ts.map