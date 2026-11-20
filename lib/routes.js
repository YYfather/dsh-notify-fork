/**
 * Workspace routing for layered notifications (fork addition).
 *
 * Optional file `<DSH_HOME>/notify/routes.json` decides, per workspace, whether
 * notifications go out at all, through which channels, and how much detail they
 * carry:
 *
 *   {
 *     "workspaceRoutes": {
 *       "*":                  { "mode": "status", "channels": ["wecom"] },
 *       "D:\\paper":          { "enabled": true, "mode": "brief", "channels": ["serverchan"] },
 *       "E:\\code\\api":       { "enabled": false }
 *     },
 *     "aibots":  [ { "id": "main", "botId": "…", "secret": "…" } ],
 *     "serverchan": { "enabled": true, "sendKey": "SCT…", "detail": "brief" }
 *   }
 *
 * Entry fields:
 *   enabled   false mutes the workspace entirely (default true)
 *   mode      off | status | brief | full (default from '*')
 *   channels  ['wecom'] | ['serverchan'] | ['all'] (default ['all'])
 *   bot       which aibots entry carries this workspace (default 'main')
 *
 * Legacy entries (`via: 'serverchan'|'wecom'`) are still understood.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dshHome } from './persist.js';

/** Relative path of the routing file under DSH_HOME. */
const ROUTE_REL = join('notify', 'routes.json');
/** mtime cache for the send path (see loadRoutesCached). */
const cache = { path: '', mtime: -1, routes: null };
/** Title cap for Server酱 cards. */
const TITLE_MAX = 100;

/** Absolute path of the routing file. */
export function routesFilePath() {
    return join(dshHome(), ROUTE_REL);
}

/** Whole file, including keys this module does not interpret. */
export function readRoutesRaw() {
    const path = routesFilePath();
    try {
        if (!existsSync(path))
            return {};
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}

/** Write the routing file atomically (tmp + rename). */
export function writeRoutesRaw(raw) {
    const path = routesFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
    cache.mtime = -1;
}

/**
 * Parse the routing file into the shapes the service consumes.
 * @returns {{aibots: object[], workspaceRoutes: object, serverchan: object, source: string, error?: string}}
 */
export function loadRoutes() {
    const path = routesFilePath();
    if (!existsSync(path))
        return { aibots: [], workspaceRoutes: {}, serverchan: {}, source: 'none' };
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        const aibots = Array.isArray(raw?.aibots)
            ? raw.aibots.filter((bot) => bot && typeof bot.botId === 'string' && typeof bot.secret === 'string')
            : [];
        const workspaceRoutes = raw?.workspaceRoutes && typeof raw.workspaceRoutes === 'object'
            ? raw.workspaceRoutes
            : {};
        const serverchan = raw?.serverchan && typeof raw.serverchan === 'object' ? raw.serverchan : {};
        return { aibots, workspaceRoutes, serverchan, source: path };
    }
    catch (error) {
        return {
            aibots: [],
            workspaceRoutes: {},
            serverchan: {},
            source: 'error',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Cheap re-read for the send path: the file is re-parsed only when its mtime
 * changed, so edits apply to the very next notification without a restart.
 */
export function loadRoutesCached() {
    const path = routesFilePath();
    try {
        const mtime = statSync(path).mtimeMs;
        if (cache.path === path && cache.mtime === mtime && cache.routes)
            return cache.routes;
        const routes = loadRoutes();
        cache.path = path;
        cache.mtime = mtime;
        cache.routes = routes;
        return routes;
    }
    catch {
        if (cache.path === path && cache.routes)
            return cache.routes;
        return { aibots: [], workspaceRoutes: {}, serverchan: {}, source: 'none' };
    }
}

/** Lower-case, forward-slash, no trailing separator — for path comparison. */
export function normalizePath(path) {
    const text = String(path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return text.toLowerCase();
}

/** Last path segment of a Windows or POSIX path. */
export function basenameOf(path) {
    const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : String(path ?? '');
}

/** Channels an entry targets: 'all' when unset (every configured channel). */
export function routeChannels(route) {
    const raw = route?.channels;
    if (Array.isArray(raw)) {
        const list = raw.filter((value) => typeof value === 'string');
        return list.length > 0 ? list : ['all'];
    }
    // Legacy `via` mapping.
    if (route?.via === 'serverchan')
        return ['serverchan'];
    if (route?.via === 'wecom')
        return ['wecom'];
    return ['all'];
}

/** Whether one channel id is enabled for this route. */
export function channelAllowed(route, channel) {
    const channels = routeChannels(route);
    return channels.includes('all') || channels.includes(channel);
}

/** Normalised detail level: off | status | brief | full. */
export function routeMode(route) {
    if (route?.enabled === false)
        return 'off';
    const mode = route?.mode;
    if (mode === 'off')
        return 'off';
    if (mode === 'status' || mode === 'brief' || mode === 'full')
        return mode;
    return 'full';
}

/**
 * Workspaces one bot forwards. Dedicated bots are pinned to their own workspace;
 * the general bot may be limited to an explicit list (['*'] = every workspace).
 */
export function botScope(rules, botKey) {
    const bots = Array.isArray(rules?.aibots) ? rules.aibots : [];
    const key = botKey || 'main';
    const bot = bots.find((entry) => (entry.id ?? 'main') === key) ?? (key === 'main' ? bots[0] : undefined);
    if (!bot)
        return ['*'];
    if (typeof bot.workspace === 'string' && bot.workspace.length > 0)
        return [bot.workspace];
    return Array.isArray(bot.workspaces) && bot.workspaces.length > 0 ? bot.workspaces : ['*'];
}

/** Bot instance that owns this route (defaults to the main bot). */
export function routeBotId(route) {
    const bot = route?.bot;
    return typeof bot === 'string' && bot.length > 0 ? bot : 'main';
}

/**
 * Pick the route for one workspace: exact path, then directory basename, then
 * the `*` default.
 */
export function resolveWorkspaceRoute(table, cwd, workspaceName) {
    const routes = table && typeof table === 'object' ? table : {};
    const keys = Object.keys(routes);
    const target = normalizePath(cwd);
    if (target) {
        for (const key of keys) {
            if (key === '*')
                continue;
            if (normalizePath(key) === target)
                return { key, ...routes[key] };
        }
    }
    const name = String(workspaceName || basenameOf(cwd) || '').toLowerCase();
    if (name) {
        for (const key of keys) {
            if (key === '*')
                continue;
            if (basenameOf(key).toLowerCase() === name)
                return { key, ...routes[key] };
        }
    }
    if (routes['*'])
        return { key: '*', ...routes['*'] };
    return { key: '', mode: 'full', channels: ['all'] };
}

/** Compact "1 分 20 秒" rendering. */
export function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/**
 * Status body: counts (and optionally the workspace) — never prompt or reply.
 */
export function buildStatusMessage(metadata, options = {}) {
    const meta = metadata || {};
    const bits = [];
    if (typeof meta.steps === 'number' && meta.steps > 0)
        bits.push(`${meta.steps} 步`);
    if (Array.isArray(meta.tools) && meta.tools.length > 0)
        bits.push(`${meta.tools.length} 类工具`);
    if (typeof meta.durationMs === 'number')
        bits.push(formatDuration(meta.durationMs));
    const lines = [bits.length > 0 ? `📊 ${bits.join(' / ')}` : '📊 已完成'];
    if (options.workspace && typeof meta.workspace === 'string' && meta.workspace.length > 0)
        lines.push(`📁 ${meta.workspace}`);
    if (typeof meta.title === 'string' && meta.title.length > 0)
        lines.push(`💬 会话：${meta.title}`);
    return lines.join('\n');
}

/**
 * Brief body. With `ordered` it is one fact per line — workspace, conversation,
 * content — for channels whose card title omits the workspace (Server酱).
 */
export function buildBriefMessage(metadata, max = 120, options = {}) {
    const meta = metadata || {};
    const gist = String(meta.reply ?? meta.userPrompt ?? '').replace(/\s+/g, ' ').trim();
    const clipped = gist.length > max ? `${gist.slice(0, max)}…` : gist;
    if (options.ordered) {
        const lines = [];
        const workspace = String(meta.workspace ?? '').trim();
        const title = String(meta.title ?? '').trim();
        if (workspace.length > 0)
            lines.push(`- 📁 ${workspace}`);
        if (title.length > 0)
            lines.push(`- 💬 ${title}`);
        if (clipped.length > 0)
            lines.push(`- 🗒 ${clipped}`);
        return lines.length > 0 ? lines.join('\n') : '- 📊 已完成';
    }
    const lines = [buildStatusMessage(meta, options)];
    if (clipped.length > 0)
        lines.push(`🗒 ${clipped}`);
    return lines.join('\n');
}

/**
 * The event one adapter should receive, or null when it must be skipped.
 *
 * Only WeCom AI Bot and Server酱 adapters obey routing; system/webhook/wechat/
 * telegram keep the original behaviour (they are separately switched on).
 */
export function adapterPayloadFor(adapter, event, route) {
    if (!adapter)
        return event;
    // One switch decides whether this workspace notifies at all.
    if (routeMode(route) === 'off')
        return null;
    // 企业微信 keeps the upstream behaviour verbatim: title already carries
    // `[workspace]`, body keeps prompt + reply. Routing only picks the bot.
    if (adapter.name === 'wecom-aibot') {
        if (!channelAllowed(route, 'wecom'))
            return null;
        const isMain = !adapter.botKey || adapter.botKey === 'main';
        const target = routeBotId(route);
        if (!isMain)
            return adapter.botKey === target ? event : null;
        if (target !== 'main')
            return { ...event, message: `↗ 已完成，详情见「${target}」机器人` };
        return event;
    }
    // Server酱 is deliberately short: workspace / conversation / gist, one per line.
    if (adapter.name === 'serverchan') {
        if (!channelAllowed(route, 'serverchan'))
            return null;
        // Full detail and the default path both go through unchanged: the
        // adapter composes the body (header list + the reply's own layout).
        return event;
    }
    return event;
}

/** Existing table key for a workspace path (case/separator insensitive), else the path itself. */
function pickKey(table, cwd) {
    const target = normalizePath(cwd);
    for (const key of Object.keys(table)) {
        if (key !== '*' && normalizePath(key) === target)
            return key;
    }
    return cwd;
}

/**
 * Turn one workspace's notifications on/off, or set its detail level, or set its
 * channels. `patch.mode = 'default'` restores inheritance; `patch.enabled` and
 * `patch.channels` replace the corresponding fields.
 *
 * @param {string} cwd - workspace path as registered with DSH.
 * @param {{mode?: string, enabled?: boolean, channels?: string[], bot?: string}} patch
 */
export function setWorkspaceRoute(cwd, patch) {
    const path = String(cwd ?? '').trim();
    if (!path)
        throw new Error('工作区路径为空');
    const raw = readRoutesRaw();
    const table = { ...(raw.workspaceRoutes || {}) };
    const key = pickKey(table, path);
    const entry = { ...(table[key] || {}) };
    if (patch?.mode === 'default') {
        delete entry.mode;
        delete entry.via;
    }
    else if (typeof patch?.mode === 'string') {
        entry.mode = patch.mode;
        delete entry.via;
    }
    if (typeof patch?.enabled === 'boolean')
        entry.enabled = patch.enabled;
    if (Array.isArray(patch?.channels)) {
        entry.channels = patch.channels.filter((value) => typeof value === 'string');
        delete entry.via;
    }
    if (typeof patch?.bot === 'string' && patch.bot.length > 0)
        entry.bot = patch.bot;
    if (Object.keys(entry).length === 0)
        delete table[key];
    else
        table[key] = entry;
    raw.workspaceRoutes = table;
    writeRoutesRaw(raw);
    return { key, entry };
}

/** Replace the whole workspaceRoutes table (settings page save). */
export function replaceWorkspaceRoutes(table) {
    const raw = readRoutesRaw();
    raw.workspaceRoutes = table && typeof table === 'object' ? table : {};
    writeRoutesRaw(raw);
    return raw.workspaceRoutes;
}

/** Replace the Server酱 block (settings page save). */
export function replaceServerchan(config) {
    const raw = readRoutesRaw();
    raw.serverchan = config && typeof config === 'object' ? config : {};
    writeRoutesRaw(raw);
    return raw.serverchan;
}

/** Replace the aibots list (settings page save). */
export function replaceAibots(bots) {
    const raw = readRoutesRaw();
    raw.aibots = Array.isArray(bots) ? bots : [];
    writeRoutesRaw(raw);
    return raw.aibots;
}

/**
 * Workspace list rendered for /push and the settings page: every registered
 * workspace plus its effective settings.
 */
export function describeWorkspaces(table, workspaces) {
    return (workspaces || [])
        .filter((workspace) => typeof workspace?.path === 'string' && workspace.path.length > 0)
        .map((workspace) => {
            const route = resolveWorkspaceRoute(table || {}, workspace.path, workspace.title);
            return {
                title: workspace.title || basenameOf(workspace.path),
                path: workspace.path,
                enabled: routeMode(route) !== 'off' && route.enabled !== false,
                mode: routeMode(route),
                channels: routeChannels(route),
                bot: routeBotId(route),
                explicit: route.key !== '' && route.key !== '*',
            };
        });
}

/** Emoji-free label used by /push. */
export function modeLabel(mode) {
    if (mode === 'off')
        return '🔇 off';
    if (mode === 'status')
        return '✅ status';
    if (mode === 'brief')
        return '📝 brief';
    return '📄 full';
}

/** Compact channel label. */
export function channelsLabel(channels) {
    const list = Array.isArray(channels) ? channels : ['all'];
    if (list.includes('all'))
        return '全部';
    return list.map((value) => (value === 'serverchan' ? '微信' : value === 'wecom' ? '企微' : value)).join('+');
}
// ─────────────────────────────────────────────────────────────────────────────
// v3: channel-level routing (企业微信 / Server酱 各一组开关，工作区可单独绑定机器人)
// ─────────────────────────────────────────────────────────────────────────────

/** Event type → filter key. */
const EVENT_KEYS = {
    conversationCompleted: 'completed',
    conversationPaused: 'paused',
    conversationFailed: 'failed',
    authorizationRequired: 'authorization',
    confirmationRequired: 'question',
    todoProgress: 'todo',
};

/** Filterable keys, in display order. */
export const EVENT_KEY_LIST = ['completed', 'failed', 'paused', 'authorization', 'question', 'todo'];

/** Chinese labels for the settings page. */
export const EVENT_LABELS = {
    completed: '对话完成',
    failed: '对话失败',
    paused: '对话暂停',
    authorization: '需要授权',
    question: '需要提问',
    todo: 'TODO 进度',
};

/** Event object → filter key ('' when unmapped). */
export function eventKeyOf(type) {
    return EVENT_KEYS[type] ?? '';
}

/** Default channel blocks. */
export function defaultChannels() {
    const allScopes = {};
    for (const key of EVENT_KEY_LIST)
        allScopes[key] = ['*'];
    return {
        wecom: { enabled: true, events: [...EVENT_KEY_LIST], workspaces: ['*'], scopes: { ...allScopes } },
        serverchan: { enabled: false, events: ['completed'], workspaces: ['*'], scopes: { ...allScopes } },
    };
}

/** Channel blocks with defaults filled in. */
export function channelConfig(rules) {
    const raw = rules?.channels;
    const fallback = defaultChannels();
    if (!raw || typeof raw !== 'object')
        return fallback;
    const pick = (key) => {
        const value = raw[key];
        if (!value || typeof value !== 'object')
            return fallback[key];
        const scopes = {};
        for (const eventKey of EVENT_KEY_LIST) {
            const scope = value.scopes?.[eventKey];
            scopes[eventKey] = Array.isArray(scope) && scope.length > 0 ? scope : ['*'];
        }
        return {
            enabled: value.enabled !== false,
            events: Array.isArray(value.events)
                ? value.events.filter((entry) => EVENT_KEY_LIST.includes(entry))
                : fallback[key].events,
            workspaces: Array.isArray(value.workspaces) && value.workspaces.length > 0 ? value.workspaces : ['*'],
            scopes,
        };
    };
    return { wecom: pick('wecom'), serverchan: pick('serverchan') };
}

/** Bots assigned to a workspace, projected into binding rows. */
export function botsAsBindings(rules) {
    const bots = Array.isArray(rules?.aibots) ? rules.aibots : [];
    return bots
        .filter((bot) => bot && typeof bot.workspace === 'string' && bot.workspace.length > 0)
        .map((bot) => ({
            workspace: bot.workspace,
            bot: typeof bot.id === 'string' && bot.id.length > 0 ? bot.id : 'main',
            events: Array.isArray(bot.events) && bot.events.length > 0 ? bot.events : [...EVENT_KEY_LIST],
        }));
}

/**
 * Per-workspace dedicated bindings.
 *
 * The bot list is the source of truth: a bot whose `workspace` is set owns that
 * workspace. The legacy `bindings` array is only read when no bot is assigned.
 */
export function bindingList(rules) {
    const derived = botsAsBindings(rules);
    if (derived.length > 0)
        return derived;
    const raw = rules?.bindings;
    if (!Array.isArray(raw))
        return [];
    return raw.filter((entry) => entry && typeof entry.workspace === 'string' && entry.workspace.length > 0);
}

/** Binding for one workspace path. */
export function bindingFor(rules, cwd) {
    const target = normalizePath(cwd);
    if (!target)
        return null;
    return bindingList(rules).find((entry) => normalizePath(entry.workspace) === target) ?? null;
}

/** Whether a workspace is inside a channel scope ('*' = all). */
export function inScope(workspaces, cwd, workspaceName) {
    const list = Array.isArray(workspaces) && workspaces.length > 0 ? workspaces : ['*'];
    if (list.includes('*'))
        return true;
    const target = normalizePath(cwd);
    const name = String(workspaceName || basenameOf(cwd) || '').toLowerCase();
    return list.some((entry) => (target && normalizePath(entry) === target) || (name.length > 0 && basenameOf(entry).toLowerCase() === name));
}

/** Replace channel blocks. */
export function replaceChannels(channels) {
    const raw = readRoutesRaw();
    raw.channels = channels && typeof channels === 'object' ? channels : {};
    writeRoutesRaw(raw);
    return channelConfig(raw);
}

/** Replace bindings. */
export function replaceBindings(bindings) {
    const raw = readRoutesRaw();
    raw.bindings = Array.isArray(bindings) ? bindings : [];
    writeRoutesRaw(raw);
    return raw.bindings;
}

/**
 * v3 dispatch: what one adapter should receive, or null to skip.
 *
 *  - a bound workspace is managed on its own (own bot, own event filter) and
 *    bypasses the channel blocks;
 *  - otherwise each channel block decides by enabled + event filter + scope;
 *  - 企业微信 keeps the upstream body, Server酱 always sends the brief body.
 */
export function resolveAdapterPayload(adapter, event, rules = {}) {
    if (!adapter)
        return event;
    const metadata = event.metadata || {};
    const key = eventKeyOf(event.type);
    const bound = bindingFor(rules, metadata.cwd);
    const channels = channelConfig(rules);
    if (adapter.name === 'wecom-aibot') {
        const isMain = !adapter.botKey || adapter.botKey === 'main';
        if (bound) {
            const bot = typeof bound.bot === 'string' && bound.bot.length > 0 ? bound.bot : 'main';
            // A dedicated bot mirrors the upstream plugin: every event, full body,
            // no per-type filtering. The general bot then only sends a short
            // status line so the same event is not delivered twice in full.
            if (!isMain)
                return adapter.botKey === bot ? event : null;
            return bot === 'main' ? event : { ...event, message: buildStatusMessage(metadata, { workspace: true }) };
        }
        if (!channels.wecom.enabled || (key && !channels.wecom.events.includes(key)))
            return null;
        if (!inScope(channels.wecom.workspaces, metadata.cwd, metadata.workspace))
            return null;
        if (!isMain)
            return null;
        // The general bot may be limited to an explicit workspace list.
        if (!inScope(botScope(rules, adapter.botKey), metadata.cwd, metadata.workspace))
            return null;
        return event;
    }
    if (adapter.name === 'serverchan') {
        // Server酱 has a single credential: it only cares about which workspaces
        // and which message types, never about per-workspace bot bindings.
        if (!channels.serverchan.enabled || (key && !channels.serverchan.events.includes(key)))
            return null;
        if (!inScope(channels.serverchan.workspaces, metadata.cwd, metadata.workspace))
            return null;

        return { ...event, message: buildBriefMessage(metadata, 120, { ordered: true }) };
    }
    return event;
}