import { Context } from '@deepseek-ai/cordis';
import { NotificationAdapter } from './base.js';
import { NotifyEvent, TelegramNotifyConfig } from '../types.js';
import { PromptInteraction, MenuMessage } from '../interaction.js';
/**
 * Telegram bot adapter — Bot API `sendMessage` push plus, when `interactive`
 * is on (default), a `getUpdates` long-poll loop that feeds replies back to
 * the InteractionBridge:
 *
 *   - text messages from the configured chat → bridge routing (Y/N approval,
 *     option number for questions, free text continues the last session),
 *   - inline-keyboard button taps (callback_query) → translated to the same
 *     vocabulary, so buttons and text are interchangeable.
 *
 * Unlike WeChat iLink there is no ephemeral context token: the configured
 * chatId alone suffices to push, and it survives restarts.
 *
 * Setup:
 * 1. Create a bot with @BotFather and copy the token.
 * 2. Start a chat with the bot (or add it to a group).
 * 3. Find the chat ID (e.g. via `getUpdates` or @userinfobot).
 * 4. Configure `botToken` and `chatId`.
 */
export declare class TelegramNotificationAdapter implements NotificationAdapter {
    readonly name = "telegram";
    readonly enabled: boolean;
    private config;
    private ctx;
    private client;
    /** Whether the update-poll loop is running (interactive mode). */
    private interactive;
    private controller;
    private updateOffset;
    /**
     * Inbound-interaction hook — set by the service when the InteractionBridge
     * is active. userId is the chat ID as a string.
     */
    onUserMessage?: (userId: string, text: string) => void | Promise<void>;
    constructor(ctx: Context, config: TelegramNotifyConfig, internal?: {
        apiBase?: string;
    });
    /**
     * Advertise the bridge's slash commands in the chat's menu button
     * (best-effort — a failure here never blocks the poll loop).
     */
    private registerCommands;
    /** Stop the poll loop. */
    dispose(): void;
    /** Whether this adapter participates in two-way interaction. */
    isInteractive(): boolean;
    /** Only the configured chat may drive interactions. */
    canInteract(userId: string): boolean;
    /** Best-effort plain-text push (interaction receipts); never throws. */
    pushText(text: string): Promise<void>;
    /**
     * Push an approval/question prompt with inline-keyboard buttons.
     * Returns false for prompts that cannot be button-ized (multi-question,
     * option-less free-text questions) — the bridge then falls back to plain
     * text via pushText.
     */
    sendPrompt(entry: PromptInteraction): Promise<boolean>;
    /** `[workspace] ` prefix for prompt card headers, when the bridge knows it. */
    private cardHeader;
    /**
     * Push a selection menu (session/workspace picker) as an inline keyboard.
     * Each button's `data` is the bridge command it stands for and goes out
     * under the CB_COMMAND prefix; oversized payloads (>64 bytes encoded) are
     * dropped defensively. Returns false when the menu cannot be button-ized —
     * the bridge then falls back to the numbered text via pushText.
     */
    sendMenu(menu: MenuMessage): Promise<boolean>;
    private pollLoop;
    private handleUpdate;
    /** Map button callback data onto the bridge's text vocabulary. */
    private translateCallback;
    private api;
    send(event: NotifyEvent): Promise<void>;
    /**
     * Format the notification as plain text.
     * Slim: title + message; no type/time footer, no standard-metadata dump.
     */
    private formatPlainText;
    /**
     * Format the notification as rich text (HTML or MarkdownV2).
     * Slim: title + message; only custom (non-standard) metadata appended.
     */
    private formatRichText;
    /** Custom metadata outside the standard turn-summary set, escaped per mode. */
    private formatMetadata;
    private escapeHtml;
    /**
     * Convert the assistant's markdown body into Telegram-supported HTML
     * (<b> <i> <s> <code> <pre> <a> <blockquote>), used in HTML parse mode so
     * the reply renders with real formatting instead of raw `**`/`##` markers.
     *
     * Safety model: code spans, fenced blocks and links are stashed as
     * finished, already-escaped HTML tokens FIRST; everything left is then
     * HTML-escaped and the inline constructs (bold / strike / italic / headers
     * / quotes) are translated on the escaped text. Arbitrary model output can
     * therefore never inject Telegram tags, and — critically — the bold/italic
     * patterns never see the INSIDE of a code span: Telegram rejects
     * <code><b>…</b></code> (no entities allowed within code/pre) with a
     * "can't parse entities" 400, which used to drop the whole notification.
     * The reverse nesting (code inside bold) is valid and still produced.
     * Underscore emphasis (`_x_`) is deliberately NOT translated — identifiers
     * like `some_variable` are far more common than `_italic_` in replies.
     */
    private markdownToTelegramHtml;
    /**
     * Convert the assistant's markdown body into Telegram MarkdownV2, used in
     * MarkdownV2 parse mode so the reply renders with real formatting instead
     * of raw `**`/`##` markers.
     *
     * Safety model: the inverse of the HTML converter — every recognized
     * construct is stashed as an already-escaped token FIRST (its inner content
     * escaped, its markers supplied by us), then everything left over is
     * escaped wholesale, and finally the tokens are restored. Arbitrary model
     * output can therefore never smuggle in unescaped entity syntax. The
     * placeholder alphabet (`%%DSHMD<n>%%`) contains no MarkdownV2 specials, so
     * the escape pass leaves it untouched.
     */
    private markdownToTelegramMarkdownV2;
    private escapeMarkdown;
}
//# sourceMappingURL=telegram.d.ts.map