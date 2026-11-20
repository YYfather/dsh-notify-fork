import axios from 'axios';
import { extraMetadataEntries } from './base.js';
/**
 * Markdown rendering of a notification, shared by the WeCom webhook bot and
 * the WeCom AI Bot (智能机器人) adapter — both render the same WeCom markdown.
 *
 * Slim by design: no type/time footer (the title carries the state, the chat
 * client timestamps the message). Only custom metadata outside the standard
 * turn-summary set is appended.
 */
export function formatWeComMarkdown(event) {
    const lines = [];
    lines.push(`## ${event.title}`);
    lines.push('');
    lines.push(event.message);
    const extra = extraMetadataEntries(event);
    if (extra.length > 0) {
        lines.push('');
        for (const [key, value] of extra) {
            lines.push(`- ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
        }
    }
    return lines.join('\n');
}
/**
 * WeCom (Enterprise WeChat) bot notification adapter
 */
export class WeComNotificationAdapter {
    constructor(ctx, config) {
        this.name = 'wecom';
        this.ctx = ctx;
        this.config = config;
        this.enabled = config.enabled ?? false;
    }
    async send(event) {
        if (!this.enabled) {
            return;
        }
        try {
            const msgType = this.config.msgType || 'markdown';
            let content;
            if (msgType === 'markdown') {
                content = formatWeComMarkdown(event);
            }
            else {
                content = `${event.title}\n\n${event.message}`;
            }
            const payload = {
                msgtype: msgType,
            };
            if (msgType === 'markdown') {
                payload.markdown = {
                    content,
                };
            }
            else {
                payload.text = {
                    content,
                    mentioned_list: this.config.mentions || [],
                };
            }
            // Add mentions for markdown type as well
            if (this.config.mentions && this.config.mentions.length > 0) {
                if (msgType === 'markdown') {
                    payload.markdown.mentioned_list = this.config.mentions;
                }
            }
            await axios.post(this.config.webhookUrl, payload, {
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 5000,
            });
            this.ctx.logger.info('[notify] WeCom notification sent');
        }
        catch (error) {
            this.ctx.logger.error('[notify] Failed to send WeCom notification:', error);
            throw error;
        }
    }
}
//# sourceMappingURL=wecom.js.map