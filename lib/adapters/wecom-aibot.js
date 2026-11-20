import { WSClient, WSAuthFailureError } from '@wecom/aibot-node-sdk';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatWeComMarkdown } from './wecom.js';
import { dshHome } from '../persist.js';
/** WeCom markdown bodies cap well below this; keep pushes comfortably small. */
const MAX_MARKDOWN_LENGTH = 4000;
/** Card quote text (full notification body) cap — well under protocol limits. */
const MAX_QUOTE_LENGTH = 1000;
/** button_interaction cards allow at most 6 buttons. */
const MAX_CARD_BUTTONS = 6;
/** WeCom recommends no more than 10 characters for each card button label. */
const MAX_BUTTON_LABEL_LENGTH = 10;
/** WeCom discards a card-event reply after 5s; ack well inside that window. */
const CARD_ACK_DEADLINE_MS = 3000;
/** Pending card tasks expire defensively (the host settles prompts long before). */
const CARD_TASK_TTL_MS = 60 * 60000;
/** First delay before rebuilding a connection the server took over. */
const RECONNECT_BASE_DELAY_MS = 3000;
/** Cap for the take-over reconnect backoff (a busy bot can be taken over repeatedly). */
const RECONNECT_MAX_DELAY_MS = 60000;
/** Button keys on interactive cards, mapped back to the bridge's text vocabulary. */
const CB_APPROVE = 'a';
const CB_REJECT = 'r';
const CB_QUESTION = 'q:'; // suffix: 1-based option index
const CB_COMMAND = 'c:'; // suffix: bridge slash command (e.g. /sel s 1)
/** Translate only the button callback contract declared by the official SDK. */
function translateCardEvent(event) {
    const key = event?.event_key;
    if (key === CB_APPROVE)
        return 'Y';
    if (key === CB_REJECT)
        return 'N';
    if (key?.startsWith(CB_QUESTION)) {
        const index = key.slice(CB_QUESTION.length);
        return /^[1-6]$/.test(index) ? index : null;
    }
    if (key?.startsWith(CB_COMMAND)) {
        const command = key.slice(CB_COMMAND.length);
        return command.startsWith('/sel ') ? command : null;
    }
    return null;
}
/**
 * Read the clicked-card fields off a callback body.
 *
 * WeCom nests the payload under `event.template_card_event`
 * (`{"eventtype":"template_card_event","template_card_event":{"event_key":…,"task_id":…}}`
 * — 接收事件 · 模板卡片事件), while the SDK's TypeScript type and README example
 * flatten `event_key`/`task_id` onto `event`. Reading only the flat shape makes
 * every real tap look like an unknown button, so it is dropped silently and
 * WeCom falls back to its generic "ok" acknowledgement: the reported symptom of
 * 批准没有送到会话。 Accept the nested shape first, keep the flat one for
 * compatibility with older payloads.
 */
function cardEventOf(body) {
    const raw = body?.event;
    if (!raw)
        return undefined;
    const nested = raw.template_card_event;
    if (nested !== null && typeof nested === 'object') {
        // The nested object carries only the card fields (card_type/event_key/
        // task_id); `eventtype` stays on the outer event and is never needed here.
        return nested;
    }
    return raw;
}
/** Neutral ack title replacing a card after a tap (the real outcome follows as a receipt message). */
function cardAckTitle(key) {
    if (key === CB_APPROVE)
        return '已提交：✅ 批准';
    if (key === CB_REJECT)
        return '已提交：🚫 拒绝';
    return '已提交选择';
}
/** Truncate with an ellipsis marker. */
function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/**
 * Truncate at a line boundary near the limit (a hard slice can cut a markdown
 * table row in half). Falls back to a hard slice for a single giant line.
 */
function truncateAtLine(text, max) {
    if (text.length <= max)
        return text;
    const newline = text.lastIndexOf('\n', max - 1);
    const at = newline >= Math.floor(max * 0.6) ? newline : max - 1;
    return `${text.slice(0, at).trimEnd()}…`;
}
export class WeComAiBotAdapter {
    constructor(ctx, config, internal) {
        this.name = 'wecom-aibot';
        // Routing key (fork addition): 'main' is the general channel, any other id
        // is a workspace-dedicated bot from routes.json.
        this.botKey = typeof config?.botKey === 'string' && config.botKey.length > 0 ? config.botKey : 'main';
        this.client = null;
        this.chats = {};
        this.cardTasks = new Map();
        this.reconnectAttempt = 0;
        this.disposed = false;
        this.ctx = ctx;
        this.config = config;
        this.enabled = (config.enabled ?? false) && Boolean(config.botId) && Boolean(config.secret);
        this.sessionFile = config.sessionFile || join(dshHome(), 'notify', 'wecom-aibot-session.json');
        this.state = this.enabled ? 'connecting' : 'disabled';
        this.createClient = internal?.createClient;
        this.reconnectDelayMs = internal?.reconnectDelayMs ?? RECONNECT_BASE_DELAY_MS;
        if (this.enabled) {
            this.chats = this.loadSession();
            if (internal?.client) {
                // Test seam: inject a pre-built client, skip the real connection.
                this.client = internal.client;
                this.wireEvents(internal.client);
                this.state = 'ready';
            }
            else {
                this.start();
            }
        }
    }
    /** Status payload for the settings page (RPC `notify.wecom-aibot.status`). */
    getStatus() {
        return {
            state: this.state,
            error: this.state === 'error' ? this.lastError : undefined,
            knownChats: Object.keys(this.chats),
        };
    }
    /**
     * Send a notification to every reachable chat as a proactive markdown
     * message (same rendering as the webhook bot).
     */
    async send(event) {
        if (!this.enabled) {
            return;
        }
        if (this.state !== 'ready' || !this.client) {
            throw new Error('企业微信智能机器人尚未连接（请检查 BotId/Secret 与网络）');
        }
        const targets = this.resolveTargets();
        if (targets.length === 0) {
            throw new Error('没有可推送的会话：请先在企业微信里给智能机器人发一条消息，或在配置中填写 toChatIds');
        }
        const content = truncateAtLine(formatWeComMarkdown(event), MAX_MARKDOWN_LENGTH);
        const failures = [];
        for (const chatId of targets) {
            try {
                await this.client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } });
                this.ctx.logger.info('[notify] WeCom AiBot notification sent to %s', chatId);
            }
            catch (error) {
                failures.push(`${chatId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (failures.length === targets.length) {
            throw new Error(`企业微信智能机器人推送全部失败: ${failures.join('; ')}`);
        }
    }
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
    async sendPrompt(entry) {
        if (!this.enabled || this.state !== 'ready' || !this.client)
            return false;
        let card = null;
        if (entry.kind === 'approval') {
            const lines = [`🔧 操作: ${entry.toolName}`];
            if (entry.reason)
                lines.push(`📝 原因: ${entry.reason}`);
            card = {
                card_type: 'button_interaction',
                main_title: { title: `🔐 ${this.cardHeader(entry)}需要授权` },
                sub_title_text: truncate(lines.join('\n'), 112),
                button_list: [
                    { text: '✅ 批准', key: CB_APPROVE },
                    { text: '❌ 拒绝', key: CB_REJECT },
                ],
            };
        }
        else {
            // Card layout clips both the quote area and the button labels, so the
            // complete question/option copy would be lost. Use the plain-text
            // prompt instead; replies remain routed as text.
            return false;
        }
        let served = false;
        for (const chatId of this.resolveTargets()) {
            try {
                const taskId = this.registerCard(chatId, card, entry);
                try {
                    await this.client.sendMessage(chatId, {
                        msgtype: 'template_card', template_card: { ...card, task_id: taskId },
                    });
                }
                catch (error) {
                    this.cardTasks.delete(taskId);
                    throw error;
                }
                served = true;
            }
            catch (error) {
                this.ctx.logger.warn('[notify] WeCom AiBot sendPrompt to %s failed:', chatId, error);
            }
        }
        return served;
    }
    /**
     * Push a selection menu (/sessions, /workspace) as a button card. Menus
     * with more than 6 entries cannot fit one card's button_list — returns
     * false and the bridge falls back to the numbered text (reply /sel …).
     */
    async sendMenu(menu) {
        if (!this.enabled || this.state !== 'ready' || !this.client)
            return false;
        const buttons = menu.buttons.flat();
        if (buttons.length === 0 || buttons.length > MAX_CARD_BUTTONS)
            return false;
        const title = menu.text.split('\n', 1)[0] ?? '请选择';
        let served = false;
        for (const chatId of this.resolveTargets()) {
            try {
                const card = {
                    card_type: 'button_interaction',
                    main_title: { title: truncate(title.replace(/（.*?）/, ''), 26) },
                    quote_area: { type: 0, quote_text: truncateAtLine(menu.text, MAX_QUOTE_LENGTH) },
                    button_list: buttons.map((b) => ({ text: truncate(b.text, MAX_BUTTON_LABEL_LENGTH), key: `${CB_COMMAND}${b.data}` })),
                };
                const taskId = this.registerCard(chatId, card);
                try {
                    await this.client.sendMessage(chatId, {
                        msgtype: 'template_card', template_card: { ...card, task_id: taskId },
                    });
                }
                catch (error) {
                    this.cardTasks.delete(taskId);
                    throw error;
                }
                served = true;
            }
            catch (error) {
                this.ctx.logger.warn('[notify] WeCom AiBot sendMenu to %s failed:', chatId, error);
            }
        }
        return served;
    }
    /**
     * Push a raw text message to every reachable interactive chat (used by the
     * InteractionBridge for prompts and receipts). Best-effort: skips silently
     * when disconnected or nobody is reachable.
     */
    async pushText(text) {
        if (!this.enabled || this.state !== 'ready' || !this.client)
            return;
        const content = truncateAtLine(text, MAX_MARKDOWN_LENGTH);
        for (const chatId of this.resolveTargets()) {
            try {
                await this.client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } });
            }
            catch (error) {
                this.ctx.logger.warn('[notify] WeCom AiBot pushText to %s failed:', chatId, error);
            }
        }
    }
    /**
     * Whether a chat may drive interactions: the toChatIds allowlist gates
     * replies when set; an empty allowlist allows every known chat.
     */
    canInteract(chatId) {
        const allowlist = (this.config.toChatIds ?? []).filter((id) => id.length > 0);
        if (allowlist.length === 0)
            return true;
        return allowlist.includes(chatId);
    }
    /** Disconnect the socket. Safe to call multiple times. */
    dispose() {
        this.disposed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.client?.disconnect();
        this.client = null;
        this.state = 'disabled';
        this.cardTasks.clear();
        this.onUserMessage = undefined;
        this.onPromptReply = undefined;
    }
    registerCard(chatId, card, entry) {
        for (const [id, task] of this.cardTasks) {
            if (Date.now() - task.createdAt > CARD_TASK_TTL_MS)
                this.cardTasks.delete(id);
        }
        if (this.cardTasks.size >= 500)
            this.cardTasks.delete(this.cardTasks.keys().next().value);
        const id = `dsh-${randomUUID()}`;
        this.cardTasks.set(id, {
            chatId, entry, createdAt: Date.now(),
            keys: new Set(card.button_list?.map(b => b.key) ?? [card.submit_button?.key ?? '']),
        });
        return id;
    }
    // ── lifecycle ────────────────────────────────────────────────────────────
    /**
     * Create the SDK client, wire events, and connect. The SDK owns reconnect
     * (exponential backoff) and heartbeat; failures surface through state/logs.
     */
    start() {
        const logger = this.ctx.logger;
        const client = this.createClient ? this.createClient() : new WSClient({
            botId: this.config.botId,
            secret: this.config.secret,
            wsUrl: this.config.wsUrl || undefined,
            maxReconnectAttempts: -1,
            logger: {
                debug: () => { },
                info: (msg, ...args) => logger.info('[notify][wecom-aibot] ' + msg, ...args),
                warn: (msg, ...args) => logger.warn('[notify][wecom-aibot] ' + msg, ...args),
                error: (msg, ...args) => logger.warn('[notify][wecom-aibot] ' + msg, ...args),
            },
        });
        this.client = client;
        this.wireEvents(client);
        client.connect();
    }
    /**
     * Recover from a server-side take-over (`disconnected_event`): WeCom kicks
     * the older connection when the same BotId authenticates elsewhere, and the
     * SDK deliberately does NOT reconnect after that kick (it treats it as a
     * manual close). Without this loop the channel would stay 'connecting'
     * forever and silently drop every notification, so build a fresh client with
     * exponential backoff, resetting the backoff once authenticated.
     */
    scheduleReconnect() {
        if (this.disposed || this.reconnectTimer)
            return;
        const delay = Math.min(this.reconnectDelayMs * 2 ** this.reconnectAttempt, RECONNECT_MAX_DELAY_MS);
        this.reconnectAttempt += 1;
        this.ctx.logger.warn('[notify] WeCom AiBot connection was taken over; reconnecting in %dms', delay);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (this.disposed)
                return;
            this.client?.disconnect();
            this.client = null;
            this.state = 'connecting';
            this.start();
        }, delay);
    }
    /** Attach message/event handlers to a client. */
    wireEvents(client) {
        client.on('authenticated', () => {
            this.state = 'ready';
            this.lastError = undefined;
            this.reconnectAttempt = 0;
            this.ctx.logger.info('[notify] WeCom AiBot adapter ready (bot authenticated)');
        });
        client.on('disconnected', (reason) => {
            if (this.state === 'ready')
                this.state = 'connecting';
            this.ctx.logger.warn('[notify] WeCom AiBot disconnected: %s', reason);
        });
        client.on('event.disconnected_event', () => {
            this.scheduleReconnect();
        });
        client.on('error', (error) => {
            this.lastError = error.message;
            // Auth rejected repeatedly → the credentials are wrong; surface a hard
            // error state (the settings page shows it) instead of retrying forever.
            // instanceof plus a name fallback (dual CJS/ESM builds can duplicate
            // the class identity).
            if (error instanceof WSAuthFailureError || error?.name === 'WSAuthFailureError') {
                this.state = 'error';
                this.lastError = '认证失败：BotId/Secret 无效，请重新扫码关联或检查配置';
            }
            this.ctx.logger.warn('[notify] WeCom AiBot error:', error);
        });
        client.on('message.text', (frame) => {
            this.handleInbound(frame, frame.body?.text?.content);
        });
        client.on('message.voice', (frame) => {
            const transcript = frame.body?.voice?.content;
            this.handleInbound(frame, transcript ? `[语音] ${transcript}` : '');
        });
        client.on('event.template_card_event', (frame) => {
            void this.handleCardEvent(frame).catch(error => this.ctx.logger.warn('[notify] Card callback failed:', error));
        });
    }
    /**
     * A tap on an interactive card: translate the button key back to the
     * bridge's text vocabulary and route it like a typed reply, then replace
     * the card with a static confirmation (must ack within 5s of the event;
     * the bridge's real outcome receipt follows as a separate message).
     */
    async handleCardEvent(frame) {
        const body = frame.body;
        const event = cardEventOf(body);
        const key = event?.event_key;
        const taskId = event?.task_id;
        if (!key) {
            this.ctx.logger.warn('[notify] WeCom AiBot card event without event_key: %s', JSON.stringify(body?.event));
            return;
        }
        const chatId = body?.chattype === 'group'
            ? body?.chatid
            : body?.from?.userid;
        if (!chatId) {
            this.ctx.logger.warn('[notify] WeCom AiBot card event without a chat id (key=%s task=%s)', key, taskId);
            return;
        }
        if (!this.canInteract(chatId)) {
            this.ctx.logger.warn('[notify] WeCom AiBot card tap from non-allowlisted chat %s ignored', chatId);
            return;
        }
        const task = taskId ? this.cardTasks.get(taskId) : undefined;
        if (!task || task.chatId !== chatId || !task.keys.has(key)) {
            this.ctx.logger.warn('[notify] WeCom AiBot card tap matches no live prompt (chat=%s key=%s task=%s)', chatId, key, taskId);
            return;
        }
        if (Date.now() - task.createdAt > CARD_TASK_TTL_MS) {
            this.cardTasks.delete(taskId);
            this.ctx.logger.warn('[notify] WeCom AiBot card tap on an expired prompt (chat=%s key=%s)', chatId, key);
            return;
        }
        const text = translateCardEvent(event);
        if (!text) {
            this.ctx.logger.warn('[notify] WeCom AiBot card tap with an unrecognized key %s ignored', key);
            return;
        }
        this.cardTasks.delete(taskId); // Claim before awaiting: duplicate taps cannot race.
        const routed = (task.entry
            ? Promise.resolve(this.onPromptReply?.(chatId, text, task.entry))
            : Promise.resolve(this.onUserMessage?.(chatId, text)).then(() => true)).then((ok) => ({ ok: ok === true })).catch((error) => {
            this.ctx.logger.warn('[notify] WeCom AiBot card routing failed:', error);
            return { ok: false };
        });
        // Ack inside WeCom's 5s window even when the receipt push is slow: replace
        // the card optimistically and report a rejection as its own message.
        let timer;
        const outcome = await Promise.race([
            routed,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve({ timeout: true }), CARD_ACK_DEADLINE_MS);
            }),
        ]);
        if (timer)
            clearTimeout(timer);
        if ('timeout' in outcome) {
            this.ackCard(frame, taskId, cardAckTitle(key));
            void routed.then((result) => {
                if (!result.ok)
                    this.sendChatText(chatId, '⚠️ 该请求已失效或已在其他端处理');
            });
            return;
        }
        this.ackCard(frame, taskId, outcome.ok ? cardAckTitle(key) : '请求已失效或已在其他端处理');
    }
    /** Replace a tapped card with a static title (WeCom expires the reply after 5s). */
    ackCard(frame, taskId, title) {
        if (!this.client || !taskId)
            return;
        this.client.updateTemplateCard(frame, {
            card_type: 'text_notice',
            main_title: { title },
            task_id: taskId,
        }).catch((error) => {
            this.ctx.logger.warn('[notify] WeCom AiBot updateTemplateCard failed:', error);
        });
    }
    /** Best-effort markdown note to one chat (after the card itself was acknowledged). */
    sendChatText(chatId, text) {
        if (!this.client)
            return;
        this.client.sendMessage(chatId, {
            msgtype: 'markdown',
            markdown: { content: truncateAtLine(text, MAX_MARKDOWN_LENGTH) },
        }).catch((error) => {
            this.ctx.logger.warn('[notify] WeCom AiBot sendMessage to %s failed:', chatId, error);
        });
    }
    /**
     * Capture the chat id of an inbound frame and surface its text to the
     * interaction bridge. Single chat pushes go to the sender's userid, group
     * chat pushes to the group chatid.
     */
    handleInbound(frame, text) {
        const body = frame.body;
        const chatId = body?.chattype === 'group'
            ? body?.chatid
            : body?.from?.userid;
        if (chatId && !this.chats[chatId]) {
            this.chats[chatId] = { updatedAt: Date.now() };
            this.saveSession();
            this.ctx.logger.info('[notify] WeCom AiBot 会话 %s 已可接收推送', chatId);
        }
        else if (chatId) {
            this.chats[chatId].updatedAt = Date.now();
        }
        if (text && this.onUserMessage && chatId && this.canInteract(chatId)) {
            Promise.resolve(this.onUserMessage(chatId, text)).catch((error) => {
                this.ctx.logger.warn('[notify] WeCom AiBot onUserMessage handler failed:', error);
            });
        }
    }
    /** `[workspace] ` prefix for prompt card titles, when the bridge knows it. */
    cardHeader(entry) {
        return entry.workspace ? `[${entry.workspace}] ` : '';
    }
    /**
     * Resolve push targets: the configured allowlist when set, otherwise every
     * chat learned from inbound messages.
     */
    resolveTargets() {
        const allowlist = (this.config.toChatIds ?? []).filter((id) => id.length > 0);
        if (allowlist.length > 0)
            return allowlist;
        return Object.keys(this.chats);
    }
    // ── session persistence ──────────────────────────────────────────────────
    loadSession() {
        if (!existsSync(this.sessionFile))
            return {};
        try {
            const parsed = JSON.parse(readFileSync(this.sessionFile, 'utf8'));
            const chats = parsed?.chats;
            return chats && typeof chats === 'object' ? chats : {};
        }
        catch (error) {
            this.ctx.logger.warn('[notify] Failed to read WeCom AiBot session file %s:', this.sessionFile, error);
            return {};
        }
    }
    saveSession() {
        try {
            mkdirSync(dirname(this.sessionFile), { recursive: true });
            const session = { chats: this.chats };
            writeFileSync(this.sessionFile, JSON.stringify(session, null, 2) + '\n', 'utf8');
            chmodSync(this.sessionFile, 0o600);
        }
        catch (error) {
            this.ctx.logger.warn('[notify] Failed to persist WeCom AiBot session file:', error);
        }
    }
}
//# sourceMappingURL=wecom-aibot.js.map