import axios from 'axios';
import { extraMetadataEntries } from './base.js';
const TELEGRAM_API = 'https://api.telegram.org';
/**
 * Callback-data vocabulary for inline keyboards. Button taps are translated
 * back into the same text the InteractionBridge already parses (`Y`/`N`/
 * option number), so one routing path serves both text and button replies.
 */
const CB_APPROVE = 'notify:a';
const CB_REJECT = 'notify:r';
const CB_QUESTION = 'notify:q:'; // suffix: 1-based option index
/**
 * Menu-button prefix. The remainder is the bridge slash command the tap
 * stands for (e.g. `notify:c:/sel s 2` → `/sel s 2`), so menu buttons and
 * typed commands share one routing path. Indices (not ids) keep the payload
 * well under Telegram's 64-byte callback_data limit.
 */
const CB_COMMAND = 'notify:c:';
/** getUpdates long-poll hold time (server-side seconds). */
const POLL_TIMEOUT_S = 25;
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
export class TelegramNotificationAdapter {
    constructor(ctx, config, internal) {
        this.name = 'telegram';
        this.controller = null;
        this.ctx = ctx;
        this.config = config;
        this.enabled = config.enabled ?? false;
        this.interactive = this.enabled && config.interactive !== false && !!config.botToken && !!config.chatId;
        this.client = axios.create({
            baseURL: `${internal?.apiBase ?? TELEGRAM_API}/bot${config.botToken}`,
            timeout: config.timeout ?? 5000,
            headers: {
                'Content-Type': 'application/json',
            },
        });
        if (this.interactive) {
            this.controller = new AbortController();
            void this.registerCommands();
            void this.pollLoop(this.controller.signal);
        }
    }
    /**
     * Advertise the bridge's slash commands in the chat's menu button
     * (best-effort — a failure here never blocks the poll loop).
     */
    async registerCommands() {
        try {
            await this.api('setMyCommands', {
                commands: [
                    { command: 'sessions', description: '选择要续接的对话' },
                    { command: 'workspace', description: '切换工作区（沿用最新对话或新建）' },
                    { command: 'current', description: '查看当前对话' },
                    { command: 'help', description: '命令帮助' },
                ],
            });
        }
        catch (error) {
            this.ctx.logger.warn('[notify] Telegram setMyCommands failed:', error);
        }
    }
    /** Stop the poll loop. */
    dispose() {
        this.controller?.abort();
        this.controller = null;
    }
    // ── interaction surface (used by the InteractionBridge hooks) ─────────
    /** Whether this adapter participates in two-way interaction. */
    isInteractive() {
        return this.interactive;
    }
    /** Only the configured chat may drive interactions. */
    canInteract(userId) {
        return this.interactive && userId === String(this.config.chatId);
    }
    /** Best-effort plain-text push (interaction receipts); never throws. */
    async pushText(text) {
        try {
            await this.api('sendMessage', { chat_id: this.config.chatId, text });
        }
        catch (error) {
            this.ctx.logger.warn('[notify] Telegram pushText failed:', error);
        }
    }
    /**
     * Push an approval/question prompt with inline-keyboard buttons.
     * Returns false for prompts that cannot be button-ized (multi-question,
     * option-less free-text questions) — the bridge then falls back to plain
     * text via pushText.
     */
    async sendPrompt(entry) {
        if (!this.interactive)
            return false;
        try {
            if (entry.kind === 'approval') {
                const lines = [`🔐 ${this.cardHeader(entry)}需要授权（${entry.sessionId.slice(0, 8)}…）`, '', `🔧 操作: ${entry.toolName}`];
                if (entry.reason)
                    lines.push(`📝 原因: ${entry.reason}`);
                lines.push('', '点击按钮，或回复 Y 批准 / N 拒绝');
                await this.api('sendMessage', {
                    chat_id: this.config.chatId,
                    text: lines.join('\n'),
                    reply_markup: {
                        inline_keyboard: [[
                                { text: '✅ 批准', callback_data: CB_APPROVE },
                                { text: '❌ 拒绝', callback_data: CB_REJECT },
                            ]],
                    },
                });
                return true;
            }
            const question = entry.questions[0];
            const options = question?.options ?? [];
            if (entry.questions.length !== 1 || options.length === 0 || options.length > 8)
                return false;
            const lines = [`❓ ${this.cardHeader(entry)}需要回答（${entry.sessionId.slice(0, 8)}…）`, ''];
            if (question.header)
                lines.push(`📌 ${question.header}`);
            lines.push(question.question, '');
            options.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`));
            lines.push('', question.multiSelect ? '多选请回复序号（空格分隔），单选可点按钮' : '点击按钮，或回复序号/自定义文字');
            await this.api('sendMessage', {
                chat_id: this.config.chatId,
                text: lines.join('\n'),
                reply_markup: {
                    inline_keyboard: options.map((o, i) => [{ text: `${i + 1}. ${o.label}`, callback_data: `${CB_QUESTION}${i + 1}` }]),
                },
            });
            return true;
        }
        catch (error) {
            this.ctx.logger.warn('[notify] Telegram sendPrompt failed, falling back to text:', error);
            return false;
        }
    }
    /** `[workspace] ` prefix for prompt card headers, when the bridge knows it. */
    cardHeader(entry) {
        return entry.workspace ? `[${entry.workspace}] ` : '';
    }
    /**
     * Push a selection menu (session/workspace picker) as an inline keyboard.
     * Each button's `data` is the bridge command it stands for and goes out
     * under the CB_COMMAND prefix; oversized payloads (>64 bytes encoded) are
     * dropped defensively. Returns false when the menu cannot be button-ized —
     * the bridge then falls back to the numbered text via pushText.
     */
    async sendMenu(menu) {
        if (!this.interactive)
            return false;
        const keyboard = menu.buttons
            .map((row) => row
            .filter((b) => Buffer.byteLength(CB_COMMAND + b.data, 'utf8') <= 64)
            .map((b) => ({ text: b.text.slice(0, 60), callback_data: CB_COMMAND + b.data })))
            .filter((row) => row.length > 0);
        if (keyboard.length === 0)
            return false;
        try {
            await this.api('sendMessage', {
                chat_id: this.config.chatId,
                text: menu.text,
                reply_markup: { inline_keyboard: keyboard },
            });
            return true;
        }
        catch (error) {
            this.ctx.logger.warn('[notify] Telegram sendMenu failed, falling back to text:', error);
            return false;
        }
    }
    // ── getUpdates long poll ────────────────────────────────────────────────
    async pollLoop(signal) {
        // Drain any backlog so a restart does not replay stale replies.
        try {
            const backlog = await this.api('getUpdates', { timeout: 0, allowed_updates: ['message', 'callback_query'] }, signal, 15000);
            const updates = backlog?.result ?? [];
            if (updates.length > 0) {
                this.updateOffset = updates[updates.length - 1].update_id + 1;
            }
        }
        catch (error) {
            if (signal.aborted)
                return;
            this.ctx.logger.warn('[notify] Telegram getUpdates 初始化失败（若配置了 webhook 需先删除）:', error);
        }
        while (!signal.aborted) {
            try {
                const resp = await this.api('getUpdates', {
                    offset: this.updateOffset,
                    timeout: POLL_TIMEOUT_S,
                    allowed_updates: ['message', 'callback_query'],
                }, signal, (POLL_TIMEOUT_S + 10) * 1000);
                for (const update of resp?.result ?? []) {
                    this.updateOffset = update.update_id + 1;
                    await this.handleUpdate(update);
                }
            }
            catch (error) {
                if (signal.aborted)
                    return;
                const status = error?.response?.status;
                if (status === 409) {
                    this.ctx.logger.warn('[notify] Telegram getUpdates 冲突（409）：该 Bot 已配置 webhook，请先调用 deleteWebhook 或关闭交互');
                }
                this.ctx.logger.warn('[notify] Telegram poll error, retrying in 5s:', error?.message ?? error);
                await new Promise((r) => setTimeout(r, 5000));
            }
        }
    }
    async handleUpdate(update) {
        try {
            const message = update.message;
            if (message?.text) {
                const chatId = String(message.chat?.id ?? '');
                if (!this.canInteract(chatId))
                    return;
                if (!this.onUserMessage)
                    return;
                await Promise.resolve(this.onUserMessage(chatId, message.text)).catch((error) => {
                    this.ctx.logger.warn('[notify] Telegram inbound handler failed:', error);
                });
                return;
            }
            const callback = update.callback_query;
            if (callback?.data) {
                const chatId = String(callback.message?.chat?.id ?? callback.from?.id ?? '');
                // Always answer so the client's loading spinner clears.
                await this.api('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => { });
                if (!this.canInteract(chatId))
                    return;
                const text = this.translateCallback(String(callback.data));
                if (text && this.onUserMessage) {
                    await Promise.resolve(this.onUserMessage(chatId, text)).catch((error) => {
                        this.ctx.logger.warn('[notify] Telegram callback handler failed:', error);
                    });
                }
                // Clear the keyboard so a settled prompt cannot be tapped twice.
                if (callback.message?.message_id) {
                    await this.api('editMessageReplyMarkup', {
                        chat_id: callback.message.chat.id,
                        message_id: callback.message.message_id,
                        reply_markup: { inline_keyboard: [] },
                    }).catch(() => { });
                }
            }
        }
        catch (error) {
            this.ctx.logger.warn('[notify] Telegram update handling failed:', error);
        }
    }
    /** Map button callback data onto the bridge's text vocabulary. */
    translateCallback(data) {
        if (data === CB_APPROVE)
            return 'Y';
        if (data === CB_REJECT)
            return 'N';
        if (data.startsWith(CB_COMMAND)) {
            const command = data.slice(CB_COMMAND.length);
            return command.startsWith('/') ? command : null;
        }
        if (data.startsWith(CB_QUESTION)) {
            const index = data.slice(CB_QUESTION.length);
            return /^\d+$/.test(index) ? index : null;
        }
        return null;
    }
    // ── Bot API helper ──────────────────────────────────────────────────────
    async api(method, payload, signal, timeoutMs) {
        const response = await this.client.post(`/${method}`, payload, { signal, timeout: timeoutMs });
        if (!response.data?.ok) {
            throw new Error(`Telegram ${method} failed: ${response.data?.description || 'unknown'}`);
        }
        return response.data;
    }
    async send(event) {
        if (!this.enabled) {
            return;
        }
        try {
            const parseMode = this.config.parseMode || 'HTML';
            const text = parseMode === 'text'
                ? this.formatPlainText(event)
                : this.formatRichText(event, parseMode);
            const payload = {
                chat_id: this.config.chatId,
                text,
            };
            if (parseMode !== 'text') {
                payload.parse_mode = parseMode;
            }
            if (this.config.disableNotification) {
                payload.disable_notification = true;
            }
            const response = await this.client.post('/sendMessage', payload);
            if (!response.data?.ok) {
                throw new Error(`Telegram API error: ${response.data?.description || 'unknown'}`);
            }
            this.ctx.logger.info('[notify] Telegram notification sent to chat %s', this.config.chatId);
        }
        catch (error) {
            this.ctx.logger.error('[notify] Failed to send Telegram notification:', error);
            throw error;
        }
    }
    /**
     * Format the notification as plain text.
     * Slim: title + message; no type/time footer, no standard-metadata dump.
     */
    formatPlainText(event) {
        const extra = this.formatMetadata(event);
        return [
            `🔔 ${event.title}`,
            '',
            event.message,
            extra ? `\n${extra}` : '',
        ].filter(Boolean).join('\n');
    }
    /**
     * Format the notification as rich text (HTML or MarkdownV2).
     * Slim: title + message; only custom (non-standard) metadata appended.
     */
    formatRichText(event, parseMode) {
        const md = parseMode === 'MarkdownV2';
        const lines = [];
        // Title
        lines.push(md ? `*${this.escapeMarkdown(event.title)}*` : `<b>🔔 ${this.escapeHtml(event.title)}</b>`);
        lines.push('');
        // Message — the assistant's markdown renders as native Telegram
        // formatting in both rich modes (HTML tags / MarkdownV2 entities)
        lines.push(md ? this.markdownToTelegramMarkdownV2(event.message) : this.markdownToTelegramHtml(event.message));
        // Custom metadata only (standard turn-summary keys are omitted)
        const metadata = this.formatMetadata(event);
        if (metadata) {
            lines.push('');
            lines.push(metadata);
        }
        return lines.join('\n');
    }
    /** Custom metadata outside the standard turn-summary set, escaped per mode. */
    formatMetadata(event) {
        const extra = extraMetadataEntries(event);
        if (extra.length === 0) {
            return '';
        }
        const md = this.config.parseMode === 'MarkdownV2';
        const html = this.config.parseMode === 'HTML';
        return extra
            .map(([key, value]) => {
            const display = typeof value === 'string' ? value : JSON.stringify(value);
            // MarkdownV2: a raw '- ' at line start is a RESERVED character and
            // gets the whole message rejected with a 400 — use a bullet instead.
            if (md)
                return `• ${this.escapeMarkdown(key)}: ${this.escapeMarkdown(display)}`;
            if (html)
                return `- ${this.escapeHtml(key)}: ${this.escapeHtml(display)}`;
            return `- ${key}: ${display}`;
        })
            .join('\n');
    }
    escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
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
    markdownToTelegramHtml(markdown) {
        // 1. Stash code blocks, inline code and links as finished HTML tokens.
        const tokens = [];
        const stash = (html) => {
            tokens.push(html);
            return `%%DSHCB${tokens.length - 1}%%`;
        };
        let text = markdown
            .replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, code) => stash(`<pre>${this.escapeHtml(code.replace(/\n$/, ''))}</pre>`))
            .replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code>${this.escapeHtml(code)}</code>`))
            .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
            if (!/^https?:\/\//i.test(url))
                return m;
            return stash(`<a href="${this.escapeHtml(url.replace(/"/g, ''))}">${this.escapeHtml(label)}</a>`);
        });
        // 2. Escape everything else, then translate the inline constructs.
        text = this.escapeHtml(text)
            // Unordered list markers — Telegram has no list entity; render as bullets
            .replace(/^[-*] /gm, '• ')
            // bold / strikethrough / italic (bold first so ** is consumed before *)
            .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
            .replace(/~~([^~]+)~~/g, '<s>$1</s>')
            .replace(/(?<![\w*])\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>')
            // ATX headers → bold line
            .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
            // blockquote lines (the '>' is already escaped to &gt;)
            .replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>');
        // 3. Restore the stashed tokens. Iterate: a header/bold line may wrap a
        //    token, and replacement text is not re-scanned by one .replace pass.
        for (let i = 0; i < 8; i++) {
            const next = text.replace(/%%DSHCB(\d+)%%/g, (m, n) => tokens[Number(n)] ?? m);
            if (next === text)
                break;
            text = next;
        }
        return text;
    }
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
    markdownToTelegramMarkdownV2(markdown) {
        const tokens = [];
        const stash = (entity) => {
            tokens.push(entity);
            return `%%DSHMD${tokens.length - 1}%%`;
        };
        const esc = this.escapeMarkdown.bind(this);
        let text = markdown
            // fenced code blocks → ``` … ``` (content escaped, shown verbatim)
            .replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, code) => stash('```\n' + esc(code.replace(/\n$/, '')) + '\n```'))
            // inline code
            .replace(/`([^`\n]+)`/g, (_m, code) => stash('`' + esc(code) + '`'))
            // [label](url) — http(s) only; ')' and '\' in the URL must be escaped
            .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => /^https?:\/\//i.test(url) ? stash('[' + esc(label) + '](' + url.replace(/([)\\])/g, '\\$1') + ')') : m)
            // bold / strikethrough / italic (bold first so ** is consumed before *)
            .replace(/\*\*([^*]+)\*\*/g, (_m, c) => stash('*' + esc(c) + '*'))
            .replace(/~~([^~]+)~~/g, (_m, c) => stash('~' + esc(c) + '~'))
            .replace(/(?<![\w*])\*([^*\n]+)\*(?!\*)/g, (_m, c) => stash('_' + esc(c) + '_'))
            // ATX headers → bold line
            .replace(/^#{1,6}\s+(.+)$/gm, (_m, c) => stash('*' + esc(c) + '*'))
            // blockquote lines
            .replace(/^> ?(.*)$/gm, (_m, c) => stash('>' + esc(c)));
        // Unordered list markers — Telegram has no list entity; render as bullets.
        // Done post-stash so code spans / quotes are untouched.
        text = text.replace(/^[-*] /gm, '• ');
        // Escape everything that was not stashed, then restore the entities.
        // Restore iterates: later patterns may have stashed text that CONTAINS
        // earlier tokens (e.g. a header line holding an inline-code token), and
        // replacement text is not re-scanned by a single .replace pass.
        let out = this.escapeMarkdown(text);
        for (let i = 0; i < 8; i++) {
            const next = out.replace(/%%DSHMD(\d+)%%/g, (_m, n) => tokens[Number(n)] ?? _m);
            if (next === out)
                break;
            out = next;
        }
        return out;
    }
    escapeMarkdown(str) {
        return str
            .replace(/_/g, '\\_')
            .replace(/\*/g, '\\*')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/~/g, '\\~')
            .replace(/`/g, '\\`')
            .replace(/>/g, '\\>')
            .replace(/#/g, '\\#')
            .replace(/\+/g, '\\+')
            .replace(/-/g, '\\-')
            .replace(/=/g, '\\=')
            .replace(/\|/g, '\\|')
            .replace(/\{/g, '\\{')
            .replace(/\}/g, '\\}')
            .replace(/\./g, '\\.')
            .replace(/!/g, '\\!');
    }
}
//# sourceMappingURL=telegram.js.map