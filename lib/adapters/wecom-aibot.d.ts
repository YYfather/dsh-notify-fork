import { Context } from '@deepseek-ai/cordis';
import { WSClient } from '@wecom/aibot-node-sdk';
import { NotificationAdapter } from './base.js';
import { NotifyEvent, WeComAiBotNotifyConfig } from '../types.js';
import { MenuMessage, PromptInteraction } from '../interaction.js';
/**
 * WeCom AI Bot (企业微信智能机器人) notification adapter.
 *
 * Unlike the WeCom group webhook bot (adapters/wecom.ts, push-only), the
 * 智能机器人 talks over a WebSocket long connection
 * (`wss://openws.work.weixin.qq.com`) via the official `@wecom/aibot-node-sdk`:
 * the plugin authenticates with a BotId + Secret (企业微信管理后台 → 智能机器人),
 * receives inbound messages on the socket, and can proactively push template
 * cards to any known chat (`sendMessage`) — no webhook URL, no
 * inbound-required reply token.
 *
 * Rendering: notifications go out as proactive markdown messages (the same
 * rendering as the webhook bot) — a proactive `text_notice` card is rejected
 * by WeCom with errcode 42045 unless it carries a `card_action` jump target,
 * and a notification has no meaningful URL to jump to;
 * approvals/questions/menus go out as button_interaction cards whose button
 * taps arrive as `template_card_event` callbacks and are translated back into
 * the InteractionBridge's plain-text reply vocabulary (Y/N, option index,
 * /sel commands) — the same contract the Telegram inline keyboards use.
 *
 * Push targets ("chats") are learned from inbound messages (single chat → the
 * sender's userid; group chat → the group chatid) and persisted to
 * `<DSH_HOME>/notify/wecom-aibot-session.json` (mode 0600) so notifications
 * survive a restart. A configured `toChatIds` allowlist both restricts the
 * push targets and gates interactive replies; with it empty, every chat that
 * messaged the bot receives pushes and may interact.
 *
 * Two-way interaction mirrors the WeChat/Telegram channels: inbound text (and
 * voice transcripts) is surfaced through `onUserMessage`, the InteractionBridge
 * routes it to pending approvals/questions or continues the last conversation,
 * and its receipts come back through `pushText`.
 */
/** Adapter lifecycle state. */
export type WeComAiBotState = 'disabled' | 'connecting' | 'ready' | 'error';
export declare class WeComAiBotAdapter implements NotificationAdapter {
    readonly name = "wecom-aibot";
    readonly enabled: boolean;
    private ctx;
    private config;
    private sessionFile;
    private client;
    private state;
    private lastError;
    private chats;
    private cardTasks;
    /** Test seams: build a client, and shorten the take-over reconnect delay. */
    private createClient;
    private reconnectDelayMs;
    private reconnectTimer;
    private reconnectAttempt;
    private disposed;
    onPromptReply: ((chatId: string, text: string, entry: PromptInteraction) => Promise<boolean>) | undefined;
    /**
     * Inbound-message hook, set by the service when two-way interaction is on.
     * Invoked (fire-and-forget) with (chatId, text) for every text/voice
     * message a user sends the bot, AFTER the chat id is captured.
     */
    onUserMessage: ((chatId: string, text: string) => void | Promise<void>) | undefined;
    constructor(ctx: Context, config: WeComAiBotNotifyConfig, internal?: {
        client?: WSClient;
        createClient?: () => WSClient;
        reconnectDelayMs?: number;
    });
    /** Status payload for the settings page (RPC `notify.wecom-aibot.status`). */
    getStatus(): {
        state: WeComAiBotState;
        error?: string;
        knownChats: string[];
    };
    /**
     * Send a notification to every reachable chat as a proactive markdown
     * message (same rendering as the webhook bot).
     */
    send(event: NotifyEvent): Promise<void>;
    /**
     * Push approvals as bound button cards.
     *
     * Question prompts deliberately do NOT become cards: WeCom clips a card's
     * quote area to a few lines and shrinks button labels to ~4 characters, so a
     * question with prose or several options loses content no matter how the
     * text is distributed. The bridge falls back to the complete plain-text
     * prompt (numbered options, reply with the index), which always shows fully.
     *
     * Best-effort per chat: true when at least one chat got it.
     */
    sendPrompt(entry: PromptInteraction): Promise<boolean>;
    /**
     * Push a selection menu (/sessions, /workspace) as a button card. Menus
     * with more than 6 entries cannot fit one card's button_list — returns
     * false and the bridge falls back to the numbered text (reply /sel …).
     */
    sendMenu(menu: MenuMessage): Promise<boolean>;
    /**
     * Push a raw text message to every reachable interactive chat (used by the
     * InteractionBridge for prompts and receipts). Best-effort: skips silently
     * when disconnected or nobody is reachable.
     */
    pushText(text: string): Promise<void>;
    /**
     * Whether a chat may drive interactions: the toChatIds allowlist gates
     * replies when set; an empty allowlist allows every known chat.
     */
    canInteract(chatId: string): boolean;
    /** Disconnect the socket. Safe to call multiple times. */
    dispose(): void;
    private registerCard;
    /**
     * Create the SDK client, wire events, and connect. The SDK owns reconnect
     * (exponential backoff) and heartbeat; failures surface through state/logs.
     */
    private start;
    /**
     * Recover from a server-side take-over (`disconnected_event`): WeCom kicks
     * the older connection when the same BotId authenticates elsewhere, and the
     * SDK deliberately does NOT reconnect after that kick (it treats it as a
     * manual close). Without this loop the channel would stay 'connecting'
     * forever and silently drop every notification, so build a fresh client with
     * exponential backoff, resetting the backoff once authenticated.
     */
    private scheduleReconnect;
    /** Attach message/event handlers to a client. */
    private wireEvents;
    /**
     * A tap on an interactive card: translate the button key back to the
     * bridge's text vocabulary and route it like a typed reply, then replace
     * the card with a static confirmation (must ack within 5s of the event;
     * the bridge's real outcome receipt follows as a separate message).
     */
    private handleCardEvent;
    /** Replace a tapped card with a static title (WeCom expires the reply after 5s). */
    private ackCard;
    /** Best-effort markdown note to one chat (after the card itself was acknowledged). */
    private sendChatText;
    /**
     * Capture the chat id of an inbound frame and surface its text to the
     * interaction bridge. Single chat pushes go to the sender's userid, group
     * chat pushes to the group chatid.
     */
    private handleInbound;
    /** `[workspace] ` prefix for prompt card titles, when the bridge knows it. */
    private cardHeader;
    /**
     * Resolve push targets: the configured allowlist when set, otherwise every
     * chat learned from inbound messages.
     */
    private resolveTargets;
    private loadSession;
    private saveSession;
}
//# sourceMappingURL=wecom-aibot.d.ts.map