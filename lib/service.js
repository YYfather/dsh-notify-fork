import { Service } from '@deepseek-ai/cordis';
import { appendFileSync } from 'fs';
import { SystemNotificationAdapter } from './adapters/system.js';
import { ServerChanAdapter } from './adapters/serverchan.js';
import { WebhookNotificationAdapter } from './adapters/webhook.js';
import { WeComNotificationAdapter } from './adapters/wecom.js';
import { WeComAiBotAdapter } from './adapters/wecom-aibot.js';
import { QR_LOGIN_TIMEOUT_MS, QR_POLL_INTERVAL_MS, generateQrCode, queryQrResult } from './adapters/wecom-aibot-qr.js';
import { WeChatClawBotAdapter } from './adapters/wechat.js';
import { InteractionBridge } from './interaction.js';
import { DshInteractionHost } from './host-interaction.js';
import { TelegramNotificationAdapter } from './adapters/telegram.js';
import { basenameOf, bindingList, channelConfig, EVENT_KEY_LIST, EVENT_LABELS, loadRoutes, loadRoutesCached, replaceAibots, replaceBindings, replaceChannels, replaceServerchan, resolveAdapterPayload as adapterPayloadFor } from './routes.js';
/** Truncate chat text with an ellipsis marker (fork helper). */
function truncateChat(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
    enabled: true,
    channels: {
        system: { enabled: true, sound: true, icon: undefined },
        webhook: { enabled: false, url: '', method: 'POST', timeout: 5000, headers: {} },
        wecom: { enabled: false, webhookUrl: '', mentions: [], msgType: 'markdown' },
        wecomAibot: { enabled: false, botId: '', secret: '', toChatIds: [], interactive: true },
        wechat: { enabled: false, toUserIds: [], interactive: true, sessionFile: '', channelVersion: '1.0.2' },
        telegram: { enabled: false, botToken: '', chatId: '', parseMode: 'HTML', disableNotification: false, timeout: 5000, interactive: true },
    },
    events: {
        conversationCompleted: true,
        conversationPaused: true,
        conversationFailed: true,
        authorizationRequired: true,
        confirmationRequired: true,
        todoProgress: true,
    },
    // Empty by default: no title prefix is added. Set e.g. "[DSH]" in config
    // to prepend a product label to every notification title.
    titlePrefix: '',
    // Subagent completion noise is opt-out: by default only the MAIN agent's
    // turn endings and TODO progress notify. Flip to false to also hear every
    // delegated child agent finishing.
    mainAgentOnly: true,
};
/**
 * Main notification service for DSH
 *
 * Manages multiple notification adapters and dispatches events to enabled channels.
 */
export class NotifyService extends Service {
    constructor(ctx, config) {
        super(ctx, 'notify');
        this.adapters = [];
        /** Whether session event listeners have been registered (at most once). */
        this.listenersRegistered = false;
        /** Chat two-way interaction bridge; null until attachHost() runs. */
        this.bridge = null;
        /** In-flight WeCom AI Bot QR-association attempt, if any. */
        this.qrAssociation = null;
        this.qrDisposed = false;
        /**
         * Last pushed TODO-list signature per session, for dedupe. todo_write fires
         * on every task status flip; we only push when the PROGRESS actually moves
         * (completed count, total, or item contents change), not on pure
         * pending↔in_progress churn.
         */
        this.lastTodoSignature = new Map();
        // Merge user config with defaults
        this.config = this.mergeConfig(config || {});
        // Workspace routing (fork addition): read once here, re-read on every
        // adapter rebuild so a routes.json edit takes effect without a restart.
        this.routes = loadRoutes();
        // Initialize adapters if plugin is enabled
        if (this.config.enabled) {
            this.initializeAdapters();
            this.registerEventListeners();
        }
        // Mixin methods to context (using type assertion to bypass strict typing)
        ctx.mixin('notify', ['send', 'isEnabled']);
    }
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
    attachHost() {
        if (this.bridge)
            return;
        const bridge = new InteractionBridge(this.ctx, new DshInteractionHost(this.ctx), {
            // Fan receipts out to every interactive channel; each push is
            // best-effort so one channel's failure never blocks the others.
            pushText: async (text) => {
                // Reply on the channel that received the message: a dedicated bot
                // answers in its own chat instead of borrowing the general bot.
                const botKey = this.bridge?.activeBot ?? 'main';
                if (botKey !== 'main') {
                    const own = this.getAiBotAdapter(botKey);
                    if (own) {
                        await own.pushText(text);
                        return;
                    }
                }
                await Promise.all([
                    this.getWechatAdapter()?.pushText(text),
                    this.getTelegramAdapter()?.pushText(text),
                    this.getWecomAibotAdapter()?.pushText(text),
                ]);
            },
            // Approval/question prompts: Telegram and WeCom AiBot get button
            // cards, WeChat gets the plain-text rendering; a button channel that
            // cannot button-ize a prompt falls back to the text rendering. All
            // happen here so the bridge's pushText fallback is not needed when any
            // channel was served.
            sendPrompt: async (entry) => {
                let claimed = false;
                const tg = this.getTelegramAdapter();
                if (tg?.isInteractive()) {
                    claimed = (await tg.sendPrompt(entry)) || claimed;
                }
                const aibot = this.botForSession(entry.sessionId);
                let aibotServed = false;
                if (aibot && this.wecomAibotInteractiveEnabled()) {
                    aibotServed = await aibot.sendPrompt(entry);
                    claimed = aibotServed || claimed;
                }
                const wx = this.getWechatAdapter();
                const text = entry.kind === 'approval'
                    ? bridge.formatApprovalPush(entry)
                    : bridge.formatQuestionPush(entry);
                if (wx) {
                    await wx.pushText(text);
                    claimed = true;
                }
                if (aibot && !aibotServed) {
                    await aibot.pushText(text);
                    claimed = true;
                }
                return claimed;
            },
            // Selection menus (/sessions, /workspace): Telegram and WeCom AiBot get
            // button cards (AiBot falls back to text for menus over 6 entries),
            // WeChat gets the numbered text (its users reply /sel …).
            sendMenu: async (menu) => {
                let claimed = false;
                const tg = this.getTelegramAdapter();
                if (tg?.isInteractive()) {
                    claimed = (await tg.sendMenu(menu)) || claimed;
                }
                const aibot = this.getAiBotAdapter(this.bridge?.activeBot ?? 'main');
                let aibotServed = false;
                if (aibot && this.wecomAibotInteractiveEnabled()) {
                    aibotServed = await aibot.sendMenu(menu);
                    claimed = aibotServed || claimed;
                }
                const wx = this.getWechatAdapter();
                if (wx) {
                    await wx.pushText(menu.text);
                    claimed = true;
                }
                if (aibot && !aibotServed) {
                    await aibot.pushText(menu.text);
                    claimed = true;
                }
                return claimed;
            },
            // /detail — pull the last finished turn of a conversation on request.
            readDetail: async (sessionId) => this.readSessionDetail(sessionId),
            // /push — read and rewrite per-workspace notification modes.
            readRules: async () => this.rules(),
            workspaceOfBot: (botKey) => {
                const bots = loadRoutesCached().aibots || [];
                const bot = bots.find((entry) => (entry.id ?? 'main') === (botKey || 'main'));
                return typeof bot?.workspace === 'string' && bot.workspace.length > 0 ? bot.workspace : '';
            },
            applyRules: async (payload) => this.applyRules(payload),
            canInteract: (userId) => {
                // Each bot has its own allowlist; the reply must be checked
                // against the bot that received it.
                const activeBot = this.bridge?.activeBot ?? 'main';
                const activeBotAdapter = this.getAiBotAdapter(activeBot);
                if (userId.startsWith('aibot:')) {
                    const id = userId.slice('aibot:'.length);
                    const interactive = activeBot === 'main' ? this.wecomAibotInteractiveEnabled() : true;
                    return interactive && (activeBotAdapter?.canInteract(id) ?? false);
                }
                return this.legacyCanInteract(userId);
            },
            legacyCanInteract: (userId) => {
                const separator = userId.indexOf(':');
                const channel = userId.slice(0, separator);
                const id = userId.slice(separator + 1);
                if (channel === 'wechat')
                    return this.wechatInteractiveEnabled() && (this.getWechatAdapter()?.canInteract(id) ?? false);
                if (channel === 'telegram')
                    return this.telegramInteractiveEnabled() && (this.getTelegramAdapter()?.canInteract(id) ?? false);
                if (channel === 'aibot')
                    return this.wecomAibotInteractiveEnabled() && (this.getWecomAibotAdapter()?.canInteract(id) ?? false);
                return false;
            },
        });
        this.bridge = bridge;
        this.syncAiBots();
        this.syncInteraction();
        this.ctx.logger.info('[notify] Interaction bridge attached');
    }
    /** The current WeChat adapter, if the channel is initialized. */
    getWechatAdapter() {
        return this.adapters.find((a) => a.name === 'wechat' && a instanceof WeChatClawBotAdapter);
    }
    /** The current Telegram adapter, if the channel is initialized. */
    getTelegramAdapter() {
        return this.adapters.find((a) => a.name === 'telegram' && a instanceof TelegramNotificationAdapter);
    }
    /** Bot that owns the workspace of one session (falls back to the general bot). */
    botForSession(sessionId) {
        try {
            const sessions = this.ctx.get('sessions');
            const cwd = sessions?.get?.(sessionId)?.header?.cwd;
            const bots = loadRoutesCached().aibots || [];
            const owner = bots.find((bot) => typeof bot.workspace === 'string' && bot.workspace.length > 0 && cwd && bot.workspace.replace(/\\/g, '/').toLowerCase() === String(cwd).replace(/\\/g, '/').toLowerCase());
            if (owner)
                return this.getAiBotAdapter(owner.id);
        }
        catch { /* fall through */ }
        return this.getWecomAibotAdapter();
    }
    /** AI Bot adapter by routing key (falls back to the general bot). */
    getAiBotAdapter(botKey) {
        const key = botKey || 'main';
        const bots = this.adapters.filter((entry) => entry.name === 'wecom-aibot');
        return bots.find((entry) => entry.botKey === key) ?? (key === 'main' ? bots.find((entry) => !entry.botKey || entry.botKey === 'main') : undefined);
    }
    /**
     * The general ("main") WeCom AI Bot adapter.
     *
     * With routes.json the plugin can hold several AI Bot instances; interaction
     * (commands, receipts, menus) always talks to the main one, never to a
     * workspace-dedicated bot.
     */
    getWecomAibotAdapter() {
        const bots = this.adapters.filter((a) => a.name === 'wecom-aibot' && a instanceof WeComAiBotAdapter);
        return bots.find((a) => !a.botKey || a.botKey === 'main') ?? bots[0];
    }
    /** Whether the WeChat channel is configured for two-way interaction. */
    wechatInteractiveEnabled() {
        return this.config.enabled
            && this.config.channels.wechat?.enabled === true
            && this.config.channels.wechat?.interactive !== false;
    }
    /** Whether the Telegram channel is configured for two-way interaction. */
    telegramInteractiveEnabled() {
        return this.config.enabled
            && this.config.channels.telegram?.enabled === true
            && this.config.channels.telegram?.interactive !== false;
    }
    /** Whether the WeCom AI Bot channel is configured for two-way interaction. */
    wecomAibotInteractiveEnabled() {
        // The bot table wins: the settings page edits `aibots[].interactive`, and
        // the legacy channels.wecomAibot flag is only the fallback.
        const bots = loadRoutesCached().aibots || [];
        const main = bots.find((bot) => (bot.id ?? 'main') === 'main') ?? bots[0];
        if (main)
            return main.interactive !== false;
        return this.config.enabled
            && this.config.channels.wecomAibot?.enabled === true
            && this.config.channels.wecomAibot?.interactive !== false;
    }
    /** Whether an adapter participates in interaction (its plain push of an answerable event would duplicate the bridge's prompt). */
    isInteractiveAdapter(adapter) {
        if (adapter.name === 'wechat')
            return this.wechatInteractiveEnabled();
        if (adapter.name === 'telegram')
            return this.telegramInteractiveEnabled();
        if (adapter.name === 'wecom-aibot')
            return this.wecomAibotInteractiveEnabled();
        return false;
    }
    /**
     * Start/stop the interaction bridge and (de)wire the adapters' inbound
     * message hooks according to the live config. Called after every adapter
     * (re)build and config update.
     */
    syncInteraction() {
        const wechat = this.getWechatAdapter();
        const telegram = this.getTelegramAdapter();
        const aibot = this.getWecomAibotAdapter();
        const wechatInteractive = this.wechatInteractiveEnabled();
        const telegramInteractive = this.telegramInteractiveEnabled();
        const aibotInteractive = this.wecomAibotInteractiveEnabled();
        if (wechat) {
            wechat.onUserMessage = wechatInteractive && this.bridge
                ? (userId, text) => this.bridge.handleReply(`wechat:${userId}`, text)
                : undefined;
        }
        if (telegram) {
            telegram.onUserMessage = telegramInteractive && this.bridge
                ? (userId, text) => this.bridge.handleReply(`telegram:${userId}`, text)
                : undefined;
        }
        // Every AI Bot adapter answers its own conversations. The general bot
        // honours the interactive switch; a dedicated bot is always two-way.
        for (const adapter of this.adapters.filter((entry) => entry.name === 'wecom-aibot')) {
            const interactive = adapter.botKey === 'main' ? aibotInteractive : true;
            adapter.onUserMessage = interactive && this.bridge
                ? (chatId, text) => this.bridge.handleReply(`aibot:${chatId}`, text, adapter.botKey)
                : undefined;
            adapter.onPromptReply = interactive && this.bridge
                ? (chatId, text, entry) => this.bridge.handlePromptReply(`aibot:${chatId}`, text, entry, adapter.botKey)
                : undefined;
        }
        if (this.bridge) {
            const anyInteractive = (wechatInteractive && wechat) || (telegramInteractive && telegram) || (aibotInteractive && aibot);
            if (anyInteractive) {
                this.bridge.start();
            }
            else {
                this.bridge.dispose();
            }
        }
    }
    /**
     * Check if the plugin is enabled
     */
    isEnabled() {
        return this.config.enabled;
    }
    /**
     * Send a notification through all enabled channels
     */
    async send(event) {
        if (!this.config.enabled) {
            this.ctx.logger.debug('[notify] Plugin is disabled, skipping notification');
            return;
        }
        // Check if this event type should trigger notifications
        if (!this.shouldNotify(event.type)) {
            this.ctx.logger.debug('[notify] Event type %s is filtered out', event.type);
            return;
        }
        // Ensure timestamp
        if (!event.timestamp) {
            event.timestamp = Date.now();
        }
        // Add title prefix
        if (this.config.titlePrefix && !event.title.startsWith(this.config.titlePrefix)) {
            event.title = `${this.config.titlePrefix} ${event.title}`;
        }
        // Workspace routing (fork addition): which AI Bot owns this event and how
        // much detail it carries. 'off' mutes the workspace entirely.
        const rules = loadRoutesCached();
        // Server酱 and the AI Bot list are edited at runtime from the settings
        // page, so their adapters are re-synced on every send.
        this.syncServerChan();
        this.syncAiBots();
        this.syncInteraction();
        // Emit internal event
        this.ctx.emit(`notify/send`, event);
        this.ctx.emit(`notify/${event.type}`, event);
        // Track the notified session per channel: a free-text reply on a bot
        // continues whichever conversation THAT bot last pushed.
        this.bridge?.noteNotification(event.metadata?.sessionId, event.metadata?.workspace, 'main');
        // Answerable events (approvals / questions) are pushed by the interaction
        // bridge WITH reply affordances; sending the plain notification to the
        // same interactive channels would duplicate it. Non-interactive channels
        // (system / webhook / wecom) still receive the plain notification.
        const bridgedEvent = this.bridge?.isActive === true
            && (event.type === 'authorizationRequired' || event.type === 'confirmationRequired');
        // Send to all enabled adapters
        const results = await Promise.allSettled(this.adapters.map((adapter) => {
            if (!adapter.enabled) {
                this.ctx.logger.debug('[notify] Skipping disabled adapter %s for %s', adapter.name, event.type);
                return Promise.resolve();
            }
            if (bridgedEvent && this.isInteractiveAdapter(adapter)) {
                this.ctx.logger.debug('[notify] Skipping plain %s push to %s (interaction bridge owns it)', event.type, adapter.name);
                return Promise.resolve();
            }
            const payload = this.payloadFor(adapter, event, rules);
            if (payload === null) {
                this.ctx.logger.debug('[notify] Adapter %s is skipped for this event', adapter.name);
                return Promise.resolve();
            }
            if (adapter.name === 'wecom-aibot') {
                this.bridge?.noteNotification(event.metadata?.sessionId, event.metadata?.workspace, adapter.botKey);
            }
            this.ctx.logger.info('[notify] Sending %s via %s adapter', event.type, adapter.name);
            return adapter.send(payload).then(() => {
                this.ctx.logger.info('[notify] Sent %s via %s adapter', event.type, adapter.name);
            });
        }));
        if (this.adapters.length === 0) {
            this.ctx.logger.warn('[notify] No notification adapters available for %s', event.type);
        }
        else if (!this.adapters.some((adapter) => adapter.enabled)) {
            this.ctx.logger.warn('[notify] No enabled notification adapters available for %s', event.type);
        }
        // Log any failures
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                const adapterName = this.adapters[index]?.name || 'unknown';
                this.ctx.logger.error('[notify] Adapter %s failed:', adapterName, result.reason);
            }
        });
    }
    /** Registered workspace rows (title + path). */
    workspaceRows() {
        const registry = this.ctx.get('workspaceRegistry');
        const rows = typeof registry?.list === 'function' ? registry.list() : [];
        return (rows || [])
            .filter((workspace) => typeof workspace?.path === 'string' && workspace.path.length > 0)
            .map((workspace) => ({ title: workspace.title ?? basenameOf(workspace.path), path: workspace.path }));
    }
    /** Channel blocks + bindings + credential flags for the settings page. */
    rules() {
        const loaded = loadRoutesCached();
        return {
            channels: channelConfig(loaded),
            bindings: bindingList(loaded).map((binding) => ({
                workspace: binding.workspace,
                bot: typeof binding.bot === 'string' && binding.bot.length > 0 ? binding.bot : 'main',
                events: Array.isArray(binding.events) && binding.events.length > 0 ? binding.events : [...EVENT_KEY_LIST],
            })),
            workspaces: this.workspaceRows(),
            events: EVENT_KEY_LIST.map((key) => ({ key, label: EVENT_LABELS[key] })),
            aibots: this.botRows(loaded),
            mainInteractive: this.mainBotInteractive(loaded),
            serverchan: {
                enabled: loaded.serverchan?.enabled !== false,
                hasKey: typeof loaded.serverchan?.sendKey === 'string' && loaded.serverchan.sendKey.length > 0,
                device: typeof loaded.serverchan?.device === 'string' ? loaded.serverchan.device : '',
                titleTemplate: typeof loaded.serverchan?.titleTemplate === 'string' ? loaded.serverchan.titleTemplate : '',
            },
        };
    }
    /** Live connection state of one bot adapter ('missing' when not created). */
    adapterStateOf(botKey) {
        const adapter = this.adapters.find((entry) => entry.name === 'wecom-aibot' && entry.botKey === (botKey || 'main'));
        if (!adapter)
            return 'missing';
        return adapter.state ?? 'unknown';
    }
    /** Last connection error of one bot adapter, when it failed. */
    adapterErrorOf(botKey) {
        const adapter = this.adapters.find((entry) => entry.name === 'wecom-aibot' && entry.botKey === (botKey || 'main'));
        if (!adapter || adapter.state !== 'error')
            return '';
        return String(adapter.lastError ?? '').slice(0, 200);
    }
    /** Whether the general bot may answer commands/approvals (default true). */
    mainBotInteractive(loaded) {
        const rows = loaded?.aibots || [];
        const main = rows.find((bot) => (bot.id ?? 'main') === 'main') ?? rows[0];
        if (main)
            return main.interactive !== false;
        const legacy = this.config?.channels?.wecomAibot;
        return legacy ? legacy.interactive !== false : true;
    }
    /**
     * Bot rows for the settings page. When routes.json has no bot list yet, the
     * legacy `channels.wecomAibot` credentials are surfaced as the `main` row so
     * there is exactly one place to edit them.
     */
    botRows(loaded) {
        const flags = [...EVENT_KEY_LIST];
        const rows = (loaded.aibots || []).map((bot) => ({
            label: typeof bot.label === 'string' && bot.label.length > 0 ? bot.label : (bot.id ?? ''),
            id: bot.id ?? '',
            state: this.adapterStateOf(bot.id ?? 'main'),
            stateError: this.adapterErrorOf(bot.id ?? 'main'),
            botId: bot.botId,
            hasSecret: typeof bot.secret === 'string' && bot.secret.length > 0,
            interactive: bot.interactive !== false,
            workspace: typeof bot.workspace === 'string' ? bot.workspace : '',
            workspaces: Array.isArray(bot.workspaces) && bot.workspaces.length > 0 ? bot.workspaces : ['*'],
            events: Array.isArray(bot.events) && bot.events.length > 0 ? bot.events : flags,
        }));
        if (rows.length > 0)
            return rows;
        const legacy = this.config?.channels?.wecomAibot;
        if (!legacy?.botId || !legacy?.secret)
            return [];
        return [{
            label: 'main',
            id: 'main',
            botId: legacy.botId,
            hasSecret: true,
            interactive: legacy.interactive !== false,
            workspace: '',
            events: flags,
        }];
    }
    /** Apply a settings-page patch (channels / bindings / Server酱 / bots). */
    applyRules(payload) {
        const body = payload && typeof payload === 'object' ? payload : {};
        if (body.channels && typeof body.channels === 'object') {
            const current = channelConfig(loadRoutesCached());
            const merge = (key) => {
                const patch = body.channels[key];
                if (!patch || typeof patch !== 'object')
                    return current[key];
                const scopes = {};
                for (const eventKey of EVENT_KEY_LIST) {
                    const next = patch.scopes?.[eventKey];
                    scopes[eventKey] = Array.isArray(next) && next.length > 0
                        ? next
                        : (current[key].scopes?.[eventKey] ?? ['*']);
                }
                return {
                    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current[key].enabled,
                    events: Array.isArray(patch.events) ? patch.events.filter((entry) => EVENT_KEY_LIST.includes(entry)) : current[key].events,
                    workspaces: Array.isArray(patch.workspaces) && patch.workspaces.length > 0 ? patch.workspaces : current[key].workspaces,
                    scopes,
                };
            };
            replaceChannels({ wecom: merge('wecom'), serverchan: merge('serverchan') });
        }
        if (Array.isArray(body.bindings)) {
            replaceBindings(body.bindings
                .filter((binding) => binding && typeof binding.workspace === 'string' && binding.workspace.length > 0)
                .map((binding) => ({
                    workspace: binding.workspace,
                    bot: typeof binding.bot === 'string' && binding.bot.length > 0 ? binding.bot : 'main',
                    events: Array.isArray(binding.events) ? binding.events.filter((entry) => EVENT_KEY_LIST.includes(entry)) : [...EVENT_KEY_LIST],
                })));
        }
        if (body.serverchan && typeof body.serverchan === 'object') {
            const current = loadRoutesCached().serverchan || {};
            const next = { ...current };
            if (typeof body.serverchan.enabled === 'boolean')
                next.enabled = body.serverchan.enabled;
            if (typeof body.serverchan.sendKey === 'string' && body.serverchan.sendKey.length > 0)
                next.sendKey = body.serverchan.sendKey;
            for (const key of ['device', 'titleTemplate', 'channel']) {
                if (typeof body.serverchan[key] === 'string')
                    next[key] = body.serverchan[key];
            }
            replaceServerchan(next);
        }
        if (Array.isArray(body.aibots)) {
            const current = loadRoutesCached().aibots || [];
            const byId = new Map(current.map((bot) => [bot.id, bot]));
            replaceAibots(body.aibots
                .filter((bot) => bot && typeof bot.botId === 'string' && bot.botId.length > 0)
                .map((bot, index) => {
                    const id = typeof bot.id === 'string' && bot.id.length > 0 ? bot.id : index === 0 ? 'main' : `bot-${index + 1}`;
                    // Preserve the stored secret across an id rename: match the
                    // previous row position first, then fall back to the id.
                    const stored = current[index] ?? byId.get(id);
                    const secret = typeof bot.secret === 'string' && bot.secret.length > 0 ? bot.secret : (stored?.secret ?? '');
                    const workspace = typeof bot.workspace === 'string' && bot.workspace.length > 0 ? bot.workspace : '';
                    const workspaces = Array.isArray(bot.workspaces) && bot.workspaces.length > 0 ? bot.workspaces : (stored?.workspaces ?? ['*']);
                    const events = Array.isArray(bot.events)
                        ? bot.events.filter((entry) => EVENT_KEY_LIST.includes(entry))
                        : (stored?.events ?? [...EVENT_KEY_LIST]);
                    // A dedicated bot is always two-way; only the general bot is toggleable.
                    const interactive = workspace.length > 0 ? true : bot.interactive !== false;
                    const label = typeof bot.label === 'string' && bot.label.length > 0 ? bot.label : id;
                    return { label, id, botId: bot.botId, secret, interactive, workspace, workspaces, events };
                }));
        }
        this.syncAiBots();
        this.syncServerChan();
        return this.rules();
    }
    /**
     * Keep the AI Bot adapters in step with the bot table: a bot added, renamed
     * or re-credentialed from the settings page connects without a restart.
     */
    syncAiBots() {
        const loaded = loadRoutesCached();
        const defs = Array.isArray(loaded.aibots) ? loaded.aibots : [];
        const wanted = defs.length > 0
            ? defs.map((bot, index) => ({
                id: typeof bot.id === 'string' && bot.id.length > 0 ? bot.id : index === 0 ? 'main' : `bot-${index + 1}`,
                botId: bot.botId,
                secret: bot.secret,
                toChatIds: Array.isArray(bot.toChatIds) ? bot.toChatIds : [],
                interactive: bot.interactive !== false,
            }))
            : (() => {
                const legacy = this.config?.channels?.wecomAibot;
                if (!legacy?.enabled || !legacy?.botId || !legacy?.secret)
                    return [];
                return [{ id: 'main', botId: legacy.botId, secret: legacy.secret, toChatIds: legacy.toChatIds ?? [], interactive: legacy.interactive !== false }];
            })();
        const wantedIds = new Set(wanted.map((bot) => bot.id));
        for (const adapter of [...this.adapters]) {
            if (adapter.name !== 'wecom-aibot')
                continue;
            if (!wantedIds.has(adapter.botKey)) {
                try { adapter.dispose(); } catch { /* ignore */ }
                this.adapters = this.adapters.filter((entry) => entry !== adapter);
            }
        }
        for (const bot of wanted) {
            const existing = this.adapters.find((adapter) => adapter.name === 'wecom-aibot' && adapter.botKey === bot.id);
            if (existing && existing.config?.botId === bot.botId && existing.config?.secret === bot.secret)
                continue;
            if (existing) {
                try { existing.dispose(); } catch { /* ignore */ }
                this.adapters = this.adapters.filter((entry) => entry !== existing);
            }
            try {
                this.adapters.push(new WeComAiBotAdapter(this.ctx, {
                    enabled: true,
                    botId: bot.botId,
                    secret: bot.secret,
                    toChatIds: bot.toChatIds,
                    interactive: bot.interactive,
                    botKey: bot.id,
                }));
                this.ctx.logger.info('[notify] AI Bot adapter attached at runtime: %s', bot.id);
            }
            catch (error) {
                this.ctx.logger.warn('[notify] Failed to attach AI Bot adapter %s:', bot.id, error);
            }
        }
    }
    /**
     * Keep the Server酱 adapter in step with routes.json: the key can be filled,
     * the switch flipped or the template edited while the host is running.
     */
    syncServerChan() {
        const config = loadRoutesCached().serverchan || {};
        const sendKey = typeof config.sendKey === 'string' ? config.sendKey : '';
        const enabled = config.enabled !== false && sendKey.length > 0;
        const existing = this.adapters.find((adapter) => adapter.name === 'serverchan');
        if (!existing) {
            if (!enabled)
                return;
            try {
                this.adapters.push(new ServerChanAdapter(this.ctx, { enabled, sendKey, device: config.device, titleTemplate: config.titleTemplate, channel: config.channel }));
                this.ctx.logger.info('[notify] Server酱 adapter attached at runtime');
            }
            catch (error) {
                this.ctx.logger.warn('[notify] Failed to attach Server酱 adapter:', error);
            }
            return;
        }
        existing.config = {
            enabled,
            sendKey,
            device: config.device,
            titleTemplate: config.titleTemplate,
            channel: config.channel,
        };
        existing.enabled = enabled;
    }
    /** Route for one event's workspace (exact path, basename, then '*'). */
    resolveRoute() {
        // Diagnostics only: the routing file is re-read on demand.
        return loadRoutesCached();
    }
    /**
     * The event as one adapter should receive it, or null when the adapter must
     * be skipped.
     *
     * Only the WeCom AI Bot adapters obey routing; every other channel keeps the
     * original full-detail behaviour (a local desktop toast is cheap).
     *  - a dedicated bot receives only its own workspace, at its configured mode;
     *  - the main bot always receives something, but collapses to a one-line
     *    pointer when a dedicated bot owns the workspace;
     *  - 'status' mode strips prompt and reply, keeping counts plus the title.
     */
    payloadFor(adapter, event, rules) {
        return adapterPayloadFor(adapter, event, rules);
    }
    /**
     * /detail — render the last finished turn of one session.
     * @param {string} sessionId - target conversation.
     */
    async readSessionDetail(sessionId) {
        if (!sessionId)
            return 'ℹ️ 当前没有选中的对话（/sessions 选择，/workspace 切换工作区）';
        const sessions = this.ctx.get('sessions');
        const session = sessions?.get?.(sessionId);
        if (!session || !Array.isArray(session.log))
            return '⚠️ 该会话当前不在运行，先在 DSH Web 端打开它再试';
        const summary = this.extractTurnSummary(session, this.lastTurnOf(session));
        const details = summary.details || {};
        const lines = [];
        if (details.title)
            lines.push(`📄 ${details.title}`);
        if (details.userPrompt)
            lines.push(`💬 ${truncateChat(details.userPrompt, 300)}`);
        if (details.reply)
            lines.push(`🤖 ${truncateChat(details.reply, 700)}`);
        return lines.length > 0 ? lines.join('\n\n') : 'ℹ️ 该会话还没有可展示的完整轮次';
    }
    /** Highest turn number recorded in a session log. */
    lastTurnOf(session) {
        let turn = 0;
        for (const entry of session?.log ?? []) {
            const value = entry?.data?.turn;
            if (typeof value === 'number' && value > turn)
                turn = value;
        }
        return turn;
    }
    /**
     * Convenience method: notify when conversation completes
     */
    async notifyConversationCompleted(title, message, metadata) {
        await this.send({
            type: 'conversationCompleted',
            title,
            message,
            metadata,
        });
    }
    /**
     * Convenience method: notify when conversation pauses
     */
    async notifyConversationPaused(title, message, metadata) {
        await this.send({
            type: 'conversationPaused',
            title,
            message,
            metadata,
        });
    }
    /**
     * Convenience method: notify when conversation fails
     */
    async notifyConversationFailed(title, message, metadata) {
        await this.send({
            type: 'conversationFailed',
            title,
            message,
            metadata,
        });
    }
    /**
     * Convenience method: notify when authorization is required
     */
    async notifyAuthorizationRequired(title, message, metadata) {
        await this.send({
            type: 'authorizationRequired',
            title,
            message,
            metadata,
        });
    }
    /**
     * Convenience method: notify when confirmation is required
     */
    async notifyConfirmationRequired(title, message, metadata) {
        await this.send({
            type: 'confirmationRequired',
            title,
            message,
            metadata,
        });
    }
    /**
     * Convenience method: notify the agent's TODO list and its progress
     */
    async notifyTodoProgress(title, message, metadata) {
        await this.send({
            type: 'todoProgress',
            title,
            message,
            metadata,
        });
    }
    /**
     * Current configuration
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * Status of the WeChat ClawBot adapter (login state, QR payload, reachable
     * users) for the settings page. Returns `{ state: 'disabled', knownUsers: [] }`
     * when the channel is off or the adapter failed to initialize.
     */
    getWechatStatus() {
        const adapter = this.getWechatAdapter();
        if (!adapter) {
            return { state: 'disabled', knownUsers: [] };
        }
        return adapter.getStatus();
    }
    /**
     * Forget the persisted WeChat session and restart the QR login flow.
     * No-op when the channel is not enabled.
     */
    async reloginWechat() {
        const adapter = this.getWechatAdapter();
        if (!adapter) {
            return { state: 'disabled', knownUsers: [] };
        }
        await adapter.relogin();
        return adapter.getStatus();
    }
    /**
     * Status of the WeCom AI Bot channel for the settings page: adapter state,
     * reachable chats, and the in-flight QR-association attempt.
     */
    getWecomAibotStatus() {
        const adapter = this.getWecomAibotAdapter();
        return {
            state: adapter?.getStatus().state ?? 'disabled',
            error: adapter?.getStatus().error,
            knownChats: adapter?.getStatus().knownChats ?? [],
            qr: this.qrAssociation
                ? { phase: 'pending', authUrl: this.qrAssociation.authUrl }
                : this.qrError
                    ? { phase: 'error', error: this.qrError }
                    : { phase: 'idle' },
        };
    }
    /**
     * Start (or restart) a WeCom AI Bot QR association: fetch a QR payload,
     * then poll in the background until the user scans and confirms in 企业微信.
     * On success the issued BotId/Secret are written into the live config (the
     * channel is enabled), adapters rebuild, and `onConfigChanged` fires so the
     * host persists the credentials. Returns the QR payload to render.
     */
    async startWecomAibotQr() {
        if (this.qrDisposed)
            throw new Error('Notification service is disposed');
        this.stopQrAssociation();
        this.qrError = undefined;
        const association = {
            scode: '', authUrl: '', deadline: 0,
            controller: new AbortController(), polling: false,
        };
        this.qrAssociation = association;
        try {
            const { scode, authUrl } = await generateQrCode('dsh-notify', undefined, association.controller.signal);
            if (this.qrAssociation !== association)
                throw new Error('QR association cancelled');
            association.scode = scode;
            association.authUrl = authUrl;
            association.deadline = Date.now() + QR_LOGIN_TIMEOUT_MS;
            association.deadlineTimer = setTimeout(() => {
                if (this.qrAssociation !== association)
                    return;
                this.qrError = '扫码关联超时（5 分钟内未扫码确认），请重试';
                this.stopQrAssociation();
            }, QR_LOGIN_TIMEOUT_MS);
            association.timer = setTimeout(() => {
                if (this.qrAssociation === association)
                    void this.pollQrAssociation();
            }, QR_POLL_INTERVAL_MS);
            this.ctx.logger.info('[notify] WeCom AiBot 扫码关联：请用企业微信扫描二维码（二维码内容已推送到设置页）');
            return { authUrl };
        }
        catch (error) {
            if (this.qrAssociation === association) {
                this.qrError = error instanceof Error ? error.message : String(error);
                this.stopQrAssociation();
            }
            throw error;
        }
    }
    /** One poll tick; schedule the next only after this request settles. */
    async pollQrAssociation() {
        const association = this.qrAssociation;
        if (!association || !association.scode || association.polling)
            return;
        clearTimeout(association.timer);
        association.timer = undefined;
        association.polling = true;
        try {
            const result = await queryQrResult(association.scode, undefined, association.controller.signal);
            if (this.qrAssociation !== association)
                return;
            if (Date.now() >= association.deadline) {
                throw new Error('扫码关联超时（5 分钟内未扫码确认），请重试');
            }
            if (result.status === 'pending') {
                association.timer = setTimeout(() => {
                    if (this.qrAssociation === association)
                        void this.pollQrAssociation();
                }, QR_POLL_INTERVAL_MS);
                return;
            }
            if (result.status === 'expired')
                throw new Error('二维码已过期，请重新发起扫码关联');
            clearTimeout(association.deadlineTimer);
            association.deadlineTimer = undefined;
            this.ctx.logger.info('[notify] WeCom AiBot 扫码关联成功 (botId: %s)', result.botId);
            this.updateConfig({
                channels: { wecomAibot: { enabled: true, botId: result.botId, secret: result.secret } },
            });
            await this.onConfigChanged?.();
            if (this.qrAssociation === association)
                this.stopQrAssociation();
        }
        catch (error) {
            if (this.qrAssociation !== association)
                return;
            this.qrError = error instanceof Error ? error.message : String(error);
            this.ctx.logger.error('[notify] WeCom AiBot QR association failed:', error);
            this.stopQrAssociation();
        }
        finally {
            association.polling = false;
        }
    }
    /** Cancel generation, polling, and both scheduled timers together. */
    stopQrAssociation() {
        const association = this.qrAssociation;
        this.qrAssociation = null;
        if (!association)
            return;
        clearTimeout(association.timer);
        clearTimeout(association.deadlineTimer);
        association.controller.abort();
    }
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
    updateConfig(newConfig) {
        this.config = this.mergeConfig(this.deepMerge(this.config, newConfig));
        if (this.config.enabled) {
            this.rebuildAdapters();
            // The plugin may have started disabled (no listeners registered); once
            // it becomes enabled at runtime the session listeners must be attached.
            if (!this.listenersRegistered) {
                this.registerEventListeners();
            }
        }
        else {
            // Plugin disabled at runtime: tear down all adapters so nothing sends.
            this.teardownAdapters();
        }
        this.syncInteraction();
        this.ctx.logger.info('[notify] Configuration updated');
    }
    /**
     * Field-wise deep merge of the `channels` and `events` groups so a partial
     * update (e.g. only `channels.wecom`) does not reset sibling channels to
     * defaults. Top-level scalars from the patch win.
     */
    deepMerge(base, patch) {
        const patchChannels = patch.channels || {};
        return {
            ...base,
            ...patch,
            channels: {
                system: { ...base.channels.system, ...patchChannels.system },
                webhook: { ...base.channels.webhook, ...patchChannels.webhook },
                wecom: { ...base.channels.wecom, ...patchChannels.wecom },
                wecomAibot: { ...base.channels.wecomAibot, ...patchChannels.wecomAibot },
                wechat: { ...base.channels.wechat, ...patchChannels.wechat },
                telegram: { ...base.channels.telegram, ...patchChannels.telegram },
            },
            events: { ...base.events, ...(patch.events || {}) },
        };
    }
    /**
     * Dispose current adapters and rebuild them from the live config.
     */
    rebuildAdapters() {
        this.teardownAdapters();
        this.initializeAdapters();
    }
    /**
     * Dispose and drop all current adapters (best-effort, errors are logged).
     */
    teardownAdapters() {
        const previous = this.adapters;
        this.adapters = [];
        for (const adapter of previous) {
            if (!adapter.dispose)
                continue;
            try {
                const result = adapter.dispose();
                if (result instanceof Promise) {
                    result.catch((error) => {
                        this.ctx.logger.error('[notify] Error disposing adapter %s:', adapter.name, error);
                    });
                }
            }
            catch (error) {
                this.ctx.logger.error('[notify] Error disposing adapter %s:', adapter.name, error);
            }
        }
    }
    /**
     * Dispose all adapters
     */
    async dispose() {
        this.ctx.logger.info('[notify] Disposing notification service');
        this.qrDisposed = true;
        this.stopQrAssociation();
        this.bridge?.dispose();
        this.teardownAdapters();
    }
    /**
     * Merge user configuration with defaults
     */
    mergeConfig(userConfig) {
        const defChannels = DEFAULT_CONFIG.channels;
        // Use type assertions to simplify merging logic
        const userChannels = userConfig.channels || {};
        return {
            enabled: userConfig.enabled ?? DEFAULT_CONFIG.enabled,
            channels: {
                system: {
                    enabled: userChannels.system?.enabled ?? defChannels.system.enabled,
                    sound: userChannels.system?.sound ?? defChannels.system.sound,
                    icon: userChannels.system?.icon ?? defChannels.system.icon,
                },
                webhook: {
                    enabled: userChannels.webhook?.enabled ?? defChannels.webhook.enabled,
                    url: userChannels.webhook?.url ?? defChannels.webhook.url,
                    method: userChannels.webhook?.method ?? defChannels.webhook.method,
                    timeout: userChannels.webhook?.timeout ?? defChannels.webhook.timeout,
                    headers: userChannels.webhook?.headers ?? defChannels.webhook.headers,
                },
                wecom: {
                    enabled: userChannels.wecom?.enabled ?? defChannels.wecom.enabled,
                    webhookUrl: userChannels.wecom?.webhookUrl ?? defChannels.wecom.webhookUrl,
                    mentions: userChannels.wecom?.mentions ?? defChannels.wecom.mentions,
                    msgType: userChannels.wecom?.msgType ?? defChannels.wecom.msgType,
                },
                wecomAibot: {
                    enabled: userChannels.wecomAibot?.enabled ?? defChannels.wecomAibot.enabled,
                    botId: userChannels.wecomAibot?.botId ?? defChannels.wecomAibot.botId,
                    secret: userChannels.wecomAibot?.secret ?? defChannels.wecomAibot.secret,
                    toChatIds: userChannels.wecomAibot?.toChatIds ?? defChannels.wecomAibot.toChatIds,
                    interactive: userChannels.wecomAibot?.interactive ?? defChannels.wecomAibot.interactive,
                    wsUrl: userChannels.wecomAibot?.wsUrl ?? defChannels.wecomAibot.wsUrl,
                    sessionFile: userChannels.wecomAibot?.sessionFile ?? defChannels.wecomAibot.sessionFile,
                },
                telegram: {
                    enabled: userChannels.telegram?.enabled ?? defChannels.telegram.enabled,
                    botToken: userChannels.telegram?.botToken ?? defChannels.telegram.botToken,
                    chatId: userChannels.telegram?.chatId ?? defChannels.telegram.chatId,
                    parseMode: userChannels.telegram?.parseMode ?? defChannels.telegram.parseMode,
                    disableNotification: userChannels.telegram?.disableNotification ?? defChannels.telegram.disableNotification,
                    timeout: userChannels.telegram?.timeout ?? defChannels.telegram.timeout,
                    interactive: userChannels.telegram?.interactive ?? defChannels.telegram.interactive,
                },
                wechat: {
                    enabled: userChannels.wechat?.enabled ?? defChannels.wechat.enabled,
                    toUserIds: userChannels.wechat?.toUserIds ?? defChannels.wechat.toUserIds,
                    interactive: userChannels.wechat?.interactive ?? defChannels.wechat.interactive,
                    sessionFile: userChannels.wechat?.sessionFile ?? defChannels.wechat.sessionFile,
                    channelVersion: userChannels.wechat?.channelVersion ?? defChannels.wechat.channelVersion,
                },
            },
            events: {
                ...DEFAULT_CONFIG.events,
                ...(userConfig.events || {}),
            },
            titlePrefix: userConfig.titlePrefix ?? DEFAULT_CONFIG.titlePrefix,
            mainAgentOnly: userConfig.mainAgentOnly ?? DEFAULT_CONFIG.mainAgentOnly,
        };
    }
    /**
     * Initialize notification adapters based on configuration
     */
    initializeAdapters() {
        // Re-read routes.json so a routing edit applies on the next config apply.
        this.routes = loadRoutes();
        const { channels } = this.config;
        // System notification adapter
        if (channels.system?.enabled) {
            try {
                const adapter = new SystemNotificationAdapter(this.ctx, channels.system);
                this.adapters.push(adapter);
                this.ctx.logger.info('[notify] System notification adapter initialized');
            }
            catch (error) {
                this.ctx.logger.warn('[notify] Failed to initialize system adapter:', error);
            }
        }
        // Webhook notification adapter
        if (channels.webhook?.enabled && channels.webhook.url) {
            try {
                const adapter = new WebhookNotificationAdapter(this.ctx, channels.webhook);
                this.adapters.push(adapter);
                this.ctx.logger.info('[notify] Webhook notification adapter initialized');
            }
            catch (error) {
                this.ctx.logger.warn('[notify] Failed to initialize webhook adapter:', error);
            }
        }
        // Server酱 (微信服务号) — configured in routes.json rather than the
        // settings page, because the credential belongs with the routing table.
        const serverchan = this.routes?.serverchan;
        const sendKey = typeof serverchan?.sendKey === 'string' && serverchan.sendKey.length > 0
            ? serverchan.sendKey
            : (typeof process.env.DSH_SERVERCHAN_SENDKEY === 'string' ? process.env.DSH_SERVERCHAN_SENDKEY : '');
        if (sendKey.length > 0) {
            try {
                const adapter = new ServerChanAdapter(this.ctx, {
                    enabled: serverchan?.enabled !== false,
                    sendKey,
                    channel: serverchan?.channel,
                });
                this.adapters.push(adapter);
                this.ctx.logger.info('[notify] Server酱 notification adapter initialized');
            }
            catch (error) {
                this.ctx.logger.warn('[notify] Failed to initialize Server酱 adapter:', error);
            }
        }
        // WeCom notification adapter
        if (channels.wecom?.enabled && channels.wecom.webhookUrl) {
            try {
                const adapter = new WeComNotificationAdapter(this.ctx, channels.wecom);
                this.adapters.push(adapter);
                this.ctx.logger.info('[notify] WeCom notification adapter initialized');
            }
            catch (error) {
                this.ctx.logger.warn('[notify] Failed to initialize WeCom adapter:', error);
            }
        }
        // WeCom AI Bot (智能机器人) adapters. When routes.json declares `aibots`,
        // one adapter is created per entry and tagged with `botKey`, so the
        // dispatcher can address each workspace's own bot. Otherwise the legacy
        // single adapter from channels.wecomAibot is kept unchanged.
        const botDefs = Array.isArray(this.routes?.aibots) ? this.routes.aibots : [];
        if (botDefs.length > 0) {
            for (const [index, bot] of botDefs.entries()) {
                try {
                    const adapter = new WeComAiBotAdapter(this.ctx, {
                        enabled: true,
                        botId: bot.botId,
                        secret: bot.secret,
                        toChatIds: Array.isArray(bot.toChatIds) ? bot.toChatIds : [],
                        interactive: bot.interactive !== false,
                        botKey: typeof bot.id === 'string' && bot.id.length > 0
                            ? bot.id
                            : index === 0 ? 'main' : `bot-${index + 1}`,
                    });
                    this.adapters.push(adapter);
                    this.ctx.logger.info('[notify] WeCom AiBot adapter initialized: %s', adapter.botKey);
                }
                catch (error) {
                    this.ctx.logger.warn('[notify] Failed to initialize WeCom AiBot adapter %s:', bot?.id, error);
                }
            }
        }
        else if (channels.wecomAibot?.enabled && channels.wecomAibot.botId && channels.wecomAibot.secret) {
            try {
                const adapter = new WeComAiBotAdapter(this.ctx, channels.wecomAibot);
                this.adapters.push(adapter);
                this.ctx.logger.info('[notify] WeCom AiBot notification adapter initialized');
            }
            catch (error) {
                this.ctx.logger.warn('[notify] Failed to initialize WeCom AiBot adapter:', error);
            }
        }
        // WeChat (ClawBot / iLink) notification adapter. Initialized whenever
        // enabled: a missing session is normal — the adapter runs the QR login
        // flow and reports progress through getWechatStatus().
        if (channels.wechat?.enabled) {
            try {
                const adapter = new WeChatClawBotAdapter(this.ctx, channels.wechat);
                this.adapters.push(adapter);
                this.ctx.logger.info('[notify] WeChat ClawBot notification adapter initialized');
            }
            catch (error) {
                this.ctx.logger.warn('[notify] Failed to initialize WeChat adapter:', error);
            }
        }
        // Telegram notification adapter
        if (channels.telegram?.enabled && channels.telegram.botToken && channels.telegram.chatId) {
            try {
                const adapter = new TelegramNotificationAdapter(this.ctx, channels.telegram);
                this.adapters.push(adapter);
                this.ctx.logger.info('[notify] Telegram notification adapter initialized');
            }
            catch (error) {
                this.ctx.logger.warn('[notify] Failed to initialize Telegram adapter:', error);
            }
        }
        if (this.adapters.length === 0) {
            this.ctx.logger.warn('[notify] No notification adapters enabled');
        }
        else {
            this.ctx.logger.info('[notify] Initialized %d notification adapter(s)', this.adapters.length);
        }
    }
    /**
     * Register event listeners for DSH lifecycle events
     */
    registerEventListeners() {
        // Guard against double registration (constructor + runtime re-enable).
        if (this.listenersRegistered)
            return;
        this.listenersRegistered = true;
        // Debug file for diagnosing event delivery in a running DSH
        const DEBUG_LOG = '/tmp/dsh-notify-debug.log';
        const debug = (msg, ...rest) => {
            try {
                appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg} ${rest.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join(' ')}\n`);
            }
            catch { /* ignore */ }
        };
        debug('registerEventListeners called, enabled=', this.config.enabled);
        // Listen for DSH session events
        // DSH uses session/event to dispatch all session lifecycle events
        // Listener signature: (session, event)
        this.ctx.on('session/event', async (session, event) => {
            debug('session/event received, type=', event?.type);
            this.ctx.logger.debug('[notify] Session event received:', event?.type);
            // Subagent noise gate: with mainAgentOnly on, a delegated child agent's
            // turn endings and TODO progress stay silent — only the MAIN agent's
            // completion/failure/pause and task progress notify. Prompts that need a
            // human answer (approval/asked, ask_user_question) are NOT gated: a
            // subagent waiting on authorization must still reach the user.
            const suppressSubagent = this.config.mainAgentOnly && this.isSubagentSession(session);
            // Handle tool/call events — the model pausing to ask the user, request
            // confirmation, or request authorization surfaces as a tool call.
            if (event?.type === 'tool/call') {
                const name = event.data?.name || '';
                // "ask_user_question" requires the human to answer before continuing.
                if (name === 'ask_user_question') {
                    await this.handleUserQuestion(session, event);
                }
                // "todo_write" publishes the agent's task list — push TODO progress.
                // (Legacy path: older hosts surface todo_write as a plain tool call;
                // current hosts ALSO emit a dedicated 'todo/write' snapshot event —
                // handled below. Keep both so either host generation notifies.)
                if (name === 'todo_write') {
                    if (suppressSubagent) {
                        debug('subagent todo_write suppressed (mainAgentOnly)');
                        return;
                    }
                    await this.handleTodoUpdate(session, event);
                }
                return;
            }
            // Handle todo/write snapshot events — dsh-tool-todo appends a
            // { todos } snapshot to the session log on every list replacement.
            // This is the ONLY todo signal on current hosts (the tool call itself
            // rides run_code dispatch and never surfaces as a tool/call with
            // name === 'todo_write'), so without this branch TODO pushes never fire.
            if (event?.type === 'todo/write') {
                if (suppressSubagent) {
                    debug('subagent todo/write suppressed (mainAgentOnly)');
                    return;
                }
                await this.handleTodoWrite(session, event);
                return;
            }
            // Handle approval/asked events — the model is requesting authorization
            // to perform a sensitive operation.
            if (event?.type === 'approval/asked') {
                await this.handleApprovalRequest(session, event);
                return;
            }
            // Handle turn/end events
            if (event?.type === 'turn/end') {
                if (suppressSubagent) {
                    debug('subagent turn/end suppressed (mainAgentOnly)');
                    this.ctx.logger.debug('[notify] Subagent turn/end suppressed (mainAgentOnly)');
                    return;
                }
                const reason = event.data?.reason?.kind || 'unknown';
                const turn = event.data?.turn || 0;
                this.ctx.logger.info('[notify] Turn ended:', { turn, reason });
                // Extract a rich summary of this turn from the session log
                const summary = this.extractTurnSummary(session, turn);
                // Title: "✅ [workspace] 对话完成" — icon first, workspace when known,
                // then the state label; without a workspace it becomes "✅ 对话完成".
                const ws = summary.details.workspace;
                const title = (icon, label) => ws
                    ? `${icon} [${ws}] ${label}`
                    : `${icon} ${label}`;
                if (reason === 'completed' || reason === 'max-tokens') {
                    debug('notifying conversation completed');
                    this.ctx.logger.info('[notify] Dispatching conversation completion', { turn, reason, summaryLength: summary.message.length });
                    await this.notifyConversationCompleted(title('✅', '对话完成'), summary.message, { turn, reason, ...summary.details });
                }
                else if (reason === 'error') {
                    debug('notifying conversation failed');
                    await this.notifyConversationFailed(title('❌', '对话失败'), `${summary.message}\n错误: ${this.extractErrorMessage(event.data?.reason?.error)}`, { turn, reason, ...summary.details, error: event.data?.reason?.error });
                }
                else {
                    // aborted / blocked / interrupted
                    debug('notifying conversation paused');
                    await this.notifyConversationPaused(title('⏸️', '对话暂停'), `${summary.message}\n原因: ${reason}`, { turn, reason, ...summary.details });
                }
            }
        });
        // NOTE: there is no host `confirm/request` event to listen to. Until 1.4.4
        // this file subscribed to `confirm/request` with an `as any` cast; no such
        // event exists on current harnesses (nor in the harness repository's event
        // history), so it never fired. A human-facing confirmation reaches this
        // plugin through the two paths above: `approval/asked` (authorization) and
        // the `ask_user_question` tool call (confirmationRequired).
        debug('event listeners registered');
    }
    /**
     * Handle an `ask_user_question` tool call: the model paused the turn and is
     * waiting for the human to answer a question. Emits a "需要确认" notification
     * with the question text, options, and workspace context.
     * @param session - the Session instance.
     * @param event - the tool/call event.
     */
    async handleUserQuestion(session, event) {
        this.ctx.logger.debug('[notify] ask_user_question tool call received');
        // Parse the question payload from tool arguments.
        const args = this.parseToolArguments(event.data?.arguments);
        const questions = Array.isArray(args?.questions) ? args.questions : [];
        const first = questions[0];
        const questionText = first?.question || '请回答以下问题';
        const header = first?.header;
        const options = (first?.options || []).map((o) => o.label).filter(Boolean).join(' / ');
        // Build a rich message with workspace context.
        const lines = [];
        if (header)
            lines.push(`📌 ${header}`);
        lines.push(`❓ ${questionText}`);
        if (options)
            lines.push(`🔘 选项: ${options}`);
        // Workspace context for the title.
        const cwd = session?.header?.cwd;
        const workspace = cwd ? basenameOf(cwd) : undefined;
        await this.notifyConfirmationRequired(workspace ? `❓ [${workspace}] 需要回答` : '❓ 需要回答', lines.join('\n'), { questions: args?.questions, sessionId: session?.id, workspace });
        this.ctx.logger.debug('[notify] user question notification sent');
    }
    /**
     * Best-effort parse of a tool call's `arguments` JSON string.
     */
    parseToolArguments(raw) {
        if (typeof raw !== 'string' || !raw)
            return {};
        try {
            return JSON.parse(raw);
        }
        catch {
            return {};
        }
    }
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
    async handleTodoUpdate(session, event) {
        this.ctx.logger.debug('[notify] todo_write tool call received');
        const args = this.parseToolArguments(event.data?.arguments);
        const todos = Array.isArray(args?.todos) ? args.todos : [];
        await this.pushTodoProgress(session, todos);
    }
    /**
     * Handle a `todo/write` session event: dsh-tool-todo appended a whole-list
     * snapshot (`event.data.todos`, already validated by the tool's invariant).
     * Shares the dedupe + push logic with the legacy tool/call path.
     * @param session - the Session instance.
     * @param event - the todo/write event.
     */
    async handleTodoWrite(session, event) {
        this.ctx.logger.debug('[notify] todo/write event received');
        const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
        await this.pushTodoProgress(session, todos);
    }
    /**
     * Push a TODO progress notification for a task-list snapshot, with
     * per-session signature dedupe (see handleTodoUpdate's noise-control note).
     * @param session - the Session instance.
     * @param todos - the task list snapshot.
     */
    async pushTodoProgress(session, todos) {
        if (todos.length === 0)
            return;
        const total = todos.length;
        const completed = todos.filter((t) => t?.status === 'completed').length;
        const inProgress = todos.filter((t) => t?.status === 'in_progress').length;
        const pending = total - completed - inProgress;
        // Dedupe: skip when progress-relevant state is unchanged since the last
        // push for this session. The signature deliberately excludes which item
        // is in_progress so pure working-status churn stays silent.
        const sessionKey = typeof session?.id === 'string' ? session.id : '';
        const signature = JSON.stringify([
            total,
            completed,
            todos.map((t) => `${t?.status === 'completed' ? 'c' : 'o'}:${t?.content ?? ''}`),
        ]);
        if (this.lastTodoSignature.get(sessionKey) === signature) {
            this.ctx.logger.debug('[notify] todo progress unchanged, skipping push');
            return;
        }
        this.lastTodoSignature.set(sessionKey, signature);
        // Bound the map so long-running hosts do not accumulate dead sessions.
        if (this.lastTodoSignature.size > 200) {
            const oldest = this.lastTodoSignature.keys().next().value;
            if (oldest !== undefined)
                this.lastTodoSignature.delete(oldest);
        }
        // Workspace context for the title.
        const cwd = session?.header?.cwd;
        const workspace = cwd ? basenameOf(cwd) : undefined;
        // Checklist body: ✅ completed / 🔄 in progress / ⬜ pending. Each item is
        // truncated and the list capped so a huge plan stays one compact push.
        const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
        const ICON = { completed: '✅', in_progress: '🔄', pending: '⬜' };
        const MAX_ITEMS = 10;
        const lines = [];
        lines.push(`📊 进度: ${completed}/${total} 已完成`);
        for (const todo of todos.slice(0, MAX_ITEMS)) {
            const icon = ICON[todo?.status ?? ''] ?? '⬜';
            lines.push(`${icon} ${truncate(String(todo?.content ?? ''), 60)}`);
        }
        if (total > MAX_ITEMS) {
            lines.push(`… 还有 ${total - MAX_ITEMS} 项`);
        }
        await this.notifyTodoProgress(workspace ? `📋 [${workspace}] TODO 进度 ${completed}/${total}` : `📋 TODO 进度 ${completed}/${total}`, lines.join('\n'), { total, completed, inProgress, pending, todos, sessionId: session?.id, workspace });
        this.ctx.logger.debug('[notify] todo progress notification sent (%d/%d)', completed, total);
    }
    /**
     * Handle an `approval/asked` session event: the model is requesting
     * authorization to perform a sensitive operation. Emits a "需要授权"
     * notification with the tool name, reason, and workspace context.
     * @param session - the Session instance.
     * @param event - the approval/asked event.
     */
    async handleApprovalRequest(session, event) {
        this.ctx.logger.debug('[notify] approval/asked event received');
        const toolName = event.data?.toolName || '未知操作';
        const reason = event.data?.reason || '需要您的授权才能继续';
        const callId = event.data?.callId;
        // Workspace context for the title.
        const cwd = session?.header?.cwd;
        const workspace = cwd ? basenameOf(cwd) : undefined;
        // Build a rich message.
        const lines = [];
        lines.push(`🔐 操作: ${toolName}`);
        if (reason)
            lines.push(`📝 原因: ${reason}`);
        if (callId)
            lines.push(`🆔 ${callId}`);
        await this.notifyAuthorizationRequired(workspace ? `🔐 [${workspace}] 需要授权` : '🔐 需要授权', lines.join('\n'), { toolName, reason, callId, sessionId: session?.id, workspace });
        this.ctx.logger.debug('[notify] approval request notification sent');
    }
    /**
     * Whether a session is a delegated SUBAGENT child. DSH stamps subagent
     * sessions with `header.origin === 'subagent'` and a `delegationDepth`
     * greater than zero (top-level sessions have neither); accept either signal
     * so older hosts without `origin` are still recognized.
     */
    isSubagentSession(session) {
        const header = session?.header;
        if (!header)
            return false;
        if (header.origin === 'subagent')
            return true;
        return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
    }
    /**
     * Check if a given event type should trigger notifications
     */
    shouldNotify(eventType) {
        return this.config.events[eventType] ?? false;
    }
    /**
     * Build a rich human-readable summary of a turn from the session log:
     * the user's last question, the assistant's reply excerpt, the tools used,
     * the conversation title, and the workspace.
     * @param session - the Session instance passed to the session/event listener.
     * @param turn - the turn number that just ended.
     * @returns a display message plus structured details for metadata.
     */
    extractTurnSummary(session, turn) {
        const details = {};
        const allEvents = Array.isArray(session?.log) ? session.log : [];
        // A subagent/forked session is SEEDED with its parent's event log: the
        // inherited events carry the PARENT's user prompts and assistant replies,
        // and most of them have no `data.turn` — so they pass the turn filter
        // below and the child's turn summary would repeat the MAIN agent's last
        // exchange verbatim. `firstLiveSeq` marks where this session's own
        // appends begin (the constructor-seed boundary); only events at or after
        // it describe this session's work. Plain top-level sessions have
        // firstLiveSeq 0 and are unaffected.
        const firstLive = typeof session?.firstLiveSeq === 'number' ? session.firstLiveSeq : 0;
        const log = firstLive > 0
            ? allEvents.filter((e) => typeof e?.seq === 'number' && e.seq >= firstLive)
            : allEvents;
        // Filter events belonging to this turn (and tolerate turn-less logs)
        const turnEvents = log.filter(e => e?.type === 'turn/start' || e?.data?.turn === turn || e?.data?.turn === undefined);
        // Last user message (the user's actual words). Host-injected context rides
        // user/message events too — <system-reminder>/<skill_catalog> XML blocks,
        // "Current runtime context" snapshots, and dsh-time-context's
        // "Time sampled while preparing turn N, step M" reading (appended as its
        // own message before EVERY step, so without this filter it becomes the
        // last user/message and hides the human's real prompt). Only
        // source.kind === 'user' is the human typing; every other kind is host
        // plumbing. No length heuristic: short real messages ("好的") are valid and
        // must win over stale longer ones.
        let userPrompt = '';
        for (const e of turnEvents) {
            if (e?.type !== 'user/message')
                continue;
            const sourceKind = e.data?.source?.kind;
            if (typeof sourceKind === 'string' && sourceKind !== 'user')
                continue;
            const text = this.extractText(e.data?.content);
            if (text && !this.isInjectedContext(text)) {
                userPrompt = text;
            }
        }
        // Last assistant message
        let reply = '';
        for (const e of turnEvents) {
            if (e?.type !== 'assistant/message')
                continue;
            const text = this.extractText(e.data?.message?.content);
            if (text)
                reply = text;
        }
        // Tools used (unique names, with counts)
        const toolCounts = new Map();
        let steps = 0;
        let turnStartTime;
        for (const e of turnEvents) {
            if (e?.type === 'tool/call' && e.data?.name) {
                toolCounts.set(e.data.name, (toolCounts.get(e.data.name) ?? 0) + 1);
            }
            if (e?.type === 'step/start')
                steps++;
            if (e?.type === 'turn/start' && typeof e.time === 'number')
                turnStartTime = e.time;
        }
        const tools = [...toolCounts.entries()]
            .map(([name, count]) => count > 1 ? `${name}×${count}` : name);
        // Conversation title: from the latest session/title event. Scans the FULL
        // log (not the live-only cut above) so a resumed session keeps the title
        // recorded before the restart.
        let title = '';
        for (const e of allEvents) {
            if (e?.type === 'session/title' && e.data?.title)
                title = e.data.title;
        }
        // Workspace: basename of the session's cwd
        const cwd = session?.header?.cwd;
        const workspace = cwd ? basenameOf(cwd) : undefined;
        // Truncate while preserving paragraph breaks: collapse whitespace runs
        // within a line but keep single newlines (3+ newlines fold into a blank
        // line). Chat pushes read far better with the reply's structure intact.
        const tidy = (s) => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        // Truncate at a line boundary near the limit: a hard slice can cut a
        // markdown table row in half, and the dangling partial row dissolves the
        // whole table into literal pipe text on renderers like WeChat ClawBot.
        // Falls back to a hard slice for a single giant line with no break nearby.
        const truncate = (s, n) => {
            if (s.length <= n)
                return s;
            const newline = s.lastIndexOf('\n', n);
            const at = newline >= Math.floor(n * 0.6) ? newline : n;
            return `${s.slice(0, at).trimEnd()}…`;
        };
        // Build the message
        const lines = [];
        if (userPrompt) {
            lines.push(`💬 ${truncate(tidy(userPrompt), 200)}`);
        }
        if (reply) {
            lines.push(`🤖 ${truncate(tidy(reply), 500)}`);
        }
        // Tools / turn / duration / workspace stay in `details` (metadata) for
        // programmatic consumers; the human-facing message body is deliberately
        // slim — just 💬 user prompt and 🤖 AI reply.
        // Details for metadata
        const durationFromLog = (() => {
            if (typeof turnStartTime !== 'number')
                return undefined;
            const lastEvent = turnEvents[turnEvents.length - 1];
            return lastEvent && typeof lastEvent.time === 'number' ? lastEvent.time - turnStartTime : undefined;
        })();
        if (durationFromLog !== undefined)
            details.durationMs = durationFromLog;
        if (userPrompt)
            details.userPrompt = userPrompt;
        if (reply)
            details.reply = reply;
        if (tools.length > 0)
            details.tools = tools;
        if (steps > 0)
            details.steps = steps;
        if (title)
            details.title = title;
        if (workspace)
            details.workspace = workspace;
        // Full cwd so routes.json can key on the real path (basename alone is
        // ambiguous when two projects share a folder name).
        if (cwd)
            details.cwd = cwd;
        if (session?.id)
            details.sessionId = session.id;
        return { message: lines.join('\n'), details };
    }
    /**
     * Whether a user/message text is host-injected context rather than the
     * user's own words: XML-ish injection blocks (`<system-reminder>`,
     * `<hindsight_knowledge>`, …) or the runtime-context snapshot header.
     */
    isInjectedContext(text) {
        const trimmed = text.trimStart();
        return trimmed.startsWith('<') || trimmed.startsWith('Current runtime context');
    }
    /**
     * Flatten message content blocks (text / reasoning / tool-call) into plain text.
     */
    /**
     * Flatten message content blocks into plain text. Only `text` blocks count —
     * `reasoning`/thinking blocks are the model's internal reasoning and must
     * never leak into notifications.
     */
    extractText(content) {
        if (typeof content === 'string')
            return content;
        if (!Array.isArray(content))
            return '';
        return content
            .filter((block) => block?.type === 'text')
            .map((block) => block.text ?? '')
            .join(' ')
            .trim();
    }
    /**
     * Extract a readable error message from a turn/end error reason.
     */
    extractErrorMessage(error) {
        if (typeof error === 'string')
            return error;
        if (error?.message)
            return String(error.message);
        if (error?.code)
            return String(error.code);
        try {
            return JSON.stringify(error);
        }
        catch {
            return '未知错误';
        }
    }
}
export default NotifyService;
//# sourceMappingURL=service.js.map