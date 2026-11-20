import { Context } from '@deepseek-ai/cordis';
import { NotificationAdapter } from './base.js';
import { NotifyEvent, WebhookNotifyConfig } from '../types.js';
/**
 * Webhook notification adapter using HTTP POST requests
 */
export declare class WebhookNotificationAdapter implements NotificationAdapter {
    readonly name = "webhook";
    readonly enabled: boolean;
    private config;
    private ctx;
    private client;
    constructor(ctx: Context, config: WebhookNotifyConfig);
    send(event: NotifyEvent): Promise<void>;
}
//# sourceMappingURL=webhook.d.ts.map