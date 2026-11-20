import { Context } from '@deepseek-ai/cordis';
import { NotificationAdapter } from './base.js';
import { NotifyEvent, WeComNotifyConfig } from '../types.js';
/**
 * Markdown rendering of a notification, shared by the WeCom webhook bot and
 * the WeCom AI Bot (智能机器人) adapter — both render the same WeCom markdown.
 *
 * Slim by design: no type/time footer (the title carries the state, the chat
 * client timestamps the message). Only custom metadata outside the standard
 * turn-summary set is appended.
 */
export declare function formatWeComMarkdown(event: NotifyEvent): string;
/**
 * WeCom (Enterprise WeChat) bot notification adapter
 */
export declare class WeComNotificationAdapter implements NotificationAdapter {
    readonly name = "wecom";
    readonly enabled: boolean;
    private config;
    private ctx;
    constructor(ctx: Context, config: WeComNotifyConfig);
    send(event: NotifyEvent): Promise<void>;
}
//# sourceMappingURL=wecom.d.ts.map