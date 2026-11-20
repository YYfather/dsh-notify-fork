import axios from 'axios';
/**
 * Webhook notification adapter using HTTP POST requests
 */
export class WebhookNotificationAdapter {
    constructor(ctx, config) {
        this.name = 'webhook';
        this.ctx = ctx;
        this.config = config;
        this.enabled = config.enabled ?? false;
        this.client = axios.create({
            baseURL: config.url,
            timeout: config.timeout ?? 5000,
            headers: {
                'Content-Type': 'application/json',
                ...config.headers,
            },
        });
    }
    async send(event) {
        if (!this.enabled) {
            return;
        }
        try {
            const payload = {
                type: event.type,
                title: event.title,
                message: event.message,
                metadata: event.metadata || {},
                timestamp: event.timestamp || Date.now(),
            };
            await this.client.request({
                method: this.config.method || 'POST',
                url: '',
                data: payload,
            });
            this.ctx.logger.info('[notify] Webhook notification sent to %s', this.config.url);
        }
        catch (error) {
            this.ctx.logger.error('[notify] Failed to send webhook notification:', error);
            throw error;
        }
    }
}
//# sourceMappingURL=webhook.js.map