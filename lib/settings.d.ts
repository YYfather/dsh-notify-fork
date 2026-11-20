import z from '@deepseek-ai/schemastery';
import { NotifyPluginConfig } from './types.js';
/**
 * Key of the notify configuration section, kept for consumers that read
 * notify configuration under this name.
 *
 * Historical note: this was `settingsNamespace('notify')` from
 * `@deepseek-ai/dsh-settings` until 1.4.2. That runtime helper (and the whole
 * namespace-registration API) was removed from dsh-settings in 0.1.2-alpha.2,
 * and importing the missing export is an ESM link error that stops the plugin
 * from loading at all on any harness since. A namespace is a plain string now;
 * nothing in this plugin needs the `settings` service — the Web page reads and
 * writes configuration through the `/dsh-notify` RPC channel
 * (see `notify-rpc.ts`).
 */
export declare const NOTIFY_SETTINGS_NAMESPACE = "notify";
/**
 * The notify fields a user owns through the Web settings page.
 * A strict subset of {@link NotifyPluginConfig}: only the values that make
 * sense to edit from the browser UI.
 */
export interface NotifySettings {
    /** Enable/disable the entire plugin. */
    enabled: boolean;
    /** Enable desktop system notifications. */
    systemEnabled: boolean;
    /** Play sound with system notifications. */
    systemSound: boolean;
    /** macOS system sound name (e.g. Glass, Ping, Sosumi, Basso). */
    systemSoundName: string;
    /** Enable webhook notifications. */
    webhookEnabled: boolean;
    /** Webhook URL. */
    webhookUrl: string;
    /** Enable WeCom (Enterprise WeChat) bot notifications. */
    wecomEnabled: boolean;
    /** WeCom webhook URL. */
    wecomWebhookUrl: string;
    /** WeCom message type: markdown or text. */
    wecomMsgType: 'markdown' | 'text';
    /** Enable WeCom AI Bot (智能机器人) notifications. */
    wecomAibotEnabled: boolean;
    /** WeCom AI Bot BotId (扫码关联自动填入). */
    wecomAibotBotId: string;
    /** WeCom AI Bot Secret (扫码关联自动填入). */
    wecomAibotSecret: string;
    /** Comma-separated chat IDs to push to; empty pushes to every chat that messaged the bot. */
    wecomAibotChatIds: string;
    /** Two-way interaction: answer approvals/questions and continue conversations from 企业微信. */
    wecomAibotInteractive: boolean;
    /** Enable WeChat ClawBot (personal WeChat) notifications. */
    wechatEnabled: boolean;
    /** Comma-separated iLink user IDs to push to; empty pushes to every user who messaged the bot. */
    wechatUserIds: string;
    /** Two-way interaction: answer approvals/questions and continue conversations from WeChat. */
    wechatInteractive: boolean;
    /** Enable Telegram bot notifications. */
    telegramEnabled: boolean;
    /** Telegram bot token. */
    telegramBotToken: string;
    /** Telegram target chat ID. */
    telegramChatId: string;
    /** Telegram message parse mode. */
    telegramParseMode: 'HTML' | 'MarkdownV2' | 'text';
    /** Telegram two-way interaction (buttons / replies drive DSH). */
    telegramInteractive: boolean;
    /** Event filters. */
    notifyOnCompleted: boolean;
    notifyOnPaused: boolean;
    notifyOnFailed: boolean;
    notifyOnAuthorization: boolean;
    notifyOnConfirmation: boolean;
    /** Push the agent's TODO list and progress (todo_write tool calls). */
    notifyOnTodo: boolean;
    /** Title prefix. */
    titlePrefix: string;
    /** Suppress subagent completion/TODO notifications; only the main agent notifies. */
    mainAgentOnly: boolean;
}
/**
 * Schema of the notify settings section (schemastery).
 * The Web settings page renders a form from this schema.
 */
export declare const NOTIFY_SETTINGS_SCHEMA: z<NotifySettings>;
/**
 * Map a stored notify settings section onto a {@link NotifyPluginConfig}.
 * @param settings - resolved settings section (defaults applied).
 * @returns a plugin config the NotifyService can consume.
 */
export declare function settingsToConfig(settings: NotifySettings): NotifyPluginConfig;
/**
 * Map a plugin composition config onto a notify settings section.
 * @param config - the plugin's composition entry config.
 * @returns the section used as the settings `base` layer.
 */
export declare function configToSettings(config: NotifyPluginConfig): NotifySettings;
//# sourceMappingURL=settings.d.ts.map