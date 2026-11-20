import { Context } from '@deepseek-ai/cordis';
import { NotifyService } from './service.js';
import { NotifyPluginConfig } from './types.js';
/**
 * DSH Notify Plugin
 *
 * Provides notification capabilities for DeepSeek Harness, supporting:
 * - System notifications (desktop)
 * - Webhook notifications (HTTP POST)
 * - WeCom bot notifications (Enterprise WeChat group webhook bot)
 * - WeCom AI Bot notifications (企业微信智能机器人, WebSocket long connection)
 * - WeChat ClawBot notifications (personal WeChat, Tencent iLink protocol)
 * - Telegram bot notifications
 *
 * Triggers on:
 * - Conversation completion
 * - Conversation pause
 * - Conversation failure
 * - Authorization requests
 * - Confirmation requests
 */
/**
 * Host services this plugin REQUIRES before activation — none.
 *
 * Everything the plugin touches is either optional or soft-injected:
 * `connection` + `webServer` (the `/dsh-notify` settings channel) through
 * `ctx.inject(...)` inside `installNotifyRpc`, and `sessionController` /
 * `workspaceRegistry` / `sessionQuery` / `agents` / `sessions` through
 * `ctx.get()` inside `DshInteractionHost`. Cordis `inject` declarations are
 * all-required, so listing any of them here would block activation on a
 * composition that lacks it (headless has no `webServer`), while the plugin's
 * core — notifications on `session/event` — works everywhere. Missing services
 * degrade to a warning or a clear chat message for the one feature that needs
 * them.
 */
export declare const inject: string[];
export default function notifyPlugin(ctx: Context, config?: NotifyPluginConfig): NotifyService;
export { NotifyService } from './service.js';
export type { WeComAiBotStatus } from './service.js';
export * from './types.js';
export * from './adapters/base.js';
export { SystemNotificationAdapter } from './adapters/system.js';
export { WebhookNotificationAdapter } from './adapters/webhook.js';
export { WeComNotificationAdapter, formatWeComMarkdown } from './adapters/wecom.js';
export { WeComAiBotAdapter } from './adapters/wecom-aibot.js';
export type { WeComAiBotState } from './adapters/wecom-aibot.js';
export { generateQrCode, queryQrResult } from './adapters/wecom-aibot-qr.js';
export type { QrGenerateResult, QrPollResult } from './adapters/wecom-aibot-qr.js';
export { WeChatClawBotAdapter } from './adapters/wechat.js';
export type { WeChatAdapterState, WeChatAdapterStatus } from './adapters/wechat.js';
export { InteractionBridge } from './interaction.js';
export { DshInteractionHost } from './host-interaction.js';
export type { ApprovalOutcome, ApprovalRequestView, CreateSessionResult, InteractionBridgeHooks, InteractionHost, InteractionSink, PromptInteraction, PromptResult, QuestionAnswer, QuestionAnswerItem, QuestionItem, QuestionOption, QuestionRequestView, SessionSummaryLike, WorkspaceViewLike, } from './interaction.js';
export { TelegramNotificationAdapter } from './adapters/telegram.js';
export { NOTIFY_SETTINGS_NAMESPACE, NOTIFY_SETTINGS_SCHEMA, settingsToConfig, configToSettings } from './settings.js';
export type { NotifySettings } from './settings.js';
export { NOTIFY_RPC_CHANNEL, NOTIFY_ENDPOINTS } from './notify-rpc.js';
//# sourceMappingURL=index.d.ts.map