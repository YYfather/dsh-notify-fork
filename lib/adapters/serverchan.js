/**
 * Server酱 (Turbo) adapter — one HTTP POST turns a notification into a WeChat
 * message delivered by the 方糖 service account (fork addition).
 *
 *   POST https://sctapi.ftqq.com/<SendKey>.send
 *        title=<single line, no newlines>&desp=<markdown>&channel=<optional id>
 *
 * Free accounts only render the title, so the caller is expected to have already
 * compressed the notification (see the 'status' route mode).
 */
import axios from 'axios';
import { hostname } from 'node:os';

/** Base URL of the push service. */
const ENDPOINT = 'https://sctapi.ftqq.com';
/** Server酱 caps the title at one line; anything longer is clamped client-side. */
const TITLE_MAX = 100;
/** Server酱 tolerates long bodies; keep well inside the service limit. */
const BODY_MAX = 8000;
/** Event type → short Chinese state word, available to the title template. */
const STATE_LABELS = {
    conversationCompleted: '完成',
    conversationPaused: '暂停',
    conversationFailed: '失败',
    authorizationRequired: '需要授权',
    confirmationRequired: '需要回答',
    todoProgress: 'TODO 进度',
};
/** Default card line: device · workspace · conversation. */
const DEFAULT_TITLE_TEMPLATE = 'DSH状态更新 · {device}';

/**
 * Render the one-line card title.
 *
 * Supported placeholders: {device} {workspace} {title} {status} {time}.
 * Whitespace is collapsed (Server酱 rejects newlines in a title) and the result
 * is clamped to TITLE_MAX.
 *
 * @param {object} event - notification event.
 * @param {{device?: string, titleTemplate?: string}} [options] - adapter config
 *   (device overrides the machine hostname; titleTemplate overrides the layout).
 * @returns {string} single-line title.
 */
export function formatServerChanTitle(event, options = {}) {
    const metadata = event?.metadata ?? {};
    const device = String(options.device ?? '').trim() || hostname();
    const template = String(options.titleTemplate ?? '').trim() || DEFAULT_TITLE_TEMPLATE;
    const status = STATE_LABELS[event?.type] ?? '';
    const values = {
        device,
        workspace: String(metadata.workspace ?? '').trim() || '未命名工作区',
        title: String(metadata.title ?? '').trim() || '新对话',
        status,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    };
    const rendered = template.replace(/\{(device|workspace|title|status|time)\}/g, (_, key) => String(values[key] ?? ''));
    const cleaned = rendered.replace(/[ \t\r\n]+/g, ' ').replace(/\s+·\s+·\s+/g, ' · ').trim();
    const fallback = String(event?.title ?? 'DSH 通知').replace(/\s+/g, ' ').trim();
    return (cleaned.length > 0 ? cleaned : fallback || 'DSH 通知').slice(0, TITLE_MAX);
}

/**
 * Build the form payload for one event.
 * @param {object} event - notification event (title/message/metadata).
 * @param {{channel?: string|number}} [config] - adapter config.
 * @returns {{title: string, desp: string, channel?: string}}
 */
/**
 * Body for one event: a short bullet header (workspace / conversation) plus the
 * reply's own text with its line breaks preserved as markdown hard breaks.
 */
export function buildServerChanBody(event) {
    const meta = event?.metadata ?? {};
    const reply = String(meta.reply ?? meta.userPrompt ?? '').trim();
    const head = [];
    if (typeof meta.workspace === 'string' && meta.workspace.trim().length > 0)
        head.push(`- 📁 ${meta.workspace.trim()}`);
    if (typeof meta.title === 'string' && meta.title.trim().length > 0)
        head.push(`- 💬 ${meta.title.trim()}`);
    if (reply.length === 0)
        return String(event?.message ?? '').slice(0, BODY_MAX);
    const body = reply
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n/g, '  \n'); // markdown hard break, keeps the author's layout
    const parts = [];
    if (head.length > 0)
        parts.push(head.join('\n'));
    parts.push(body);
    return parts.join('\n\n').slice(0, BODY_MAX);
}

export function buildServerChanPayload(event, config = {}) {
    const title = formatServerChanTitle(event, config);
    // Server酱 renders markdown: a single newline is a soft break and gets
    // collapsed. One blank line between segments is what actually shows up.
    const raw = buildServerChanBody(event);
    // A markdown list renders one bullet per line, so its newlines must survive;
    // plain prose needs a blank line between segments or the soft breaks collapse.
    const desp = raw.slice(0, BODY_MAX);
    const payload = { title, desp };
    const channel = config?.channel;
    if (channel !== undefined && channel !== null && String(channel).length > 0)
        payload.channel = String(channel);
    return payload;
}

/** Notification adapter that POSTs to Server酱. */
export class ServerChanAdapter {
    constructor(ctx, config) {
        this.name = 'serverchan';
        this.ctx = ctx;
        this.config = config || {};
        this.enabled = Boolean(this.config.enabled && this.config.sendKey);
        this.timeout = this.config.timeout ?? 8000;
    }
    /** Body Server酱 receives for one event. */
    payloadOf(event) {
        return buildServerChanPayload(event, this.config);
    }
    async send(event) {
        if (!this.enabled)
            return;
        const payload = this.payloadOf(event);
        const url = `${ENDPOINT}/${encodeURIComponent(this.config.sendKey)}.send`;
        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(payload))
            form.append(key, String(value));
        try {
            const response = await axios.post(url, form, {
                timeout: this.timeout,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });
            const body = response.data ?? {};
            const code = typeof body.code === 'number' ? body.code : 0;
            if (code !== 0)
                throw new Error(`Server酱 返回 code=${code}: ${body.message ?? 'unknown'}`);
            this.ctx.logger.info('[notify] Server酱 push sent');
        }
        catch (error) {
            this.ctx.logger.error('[notify] Server酱 push failed:', error);
            throw error;
        }
    }
}
