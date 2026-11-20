import { randomUUID } from 'node:crypto';
/** Fixed client time zone stamped onto chat-originated prompts. */
const CLIENT_TIME_ZONE = 'Asia/Shanghai';
/** Human-readable message from an unknown thrown value. */
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    return String(error);
}
/**
 * One promise that settles when a request signal aborts.
 *
 * `release` resolves with the chat-side `null`, which makes the adapter
 * delegate downstream — correct for approvals, whose service races the signal
 * itself and answers `cancelled`. `throw` rejects with the signal's own reason,
 * which is what the question seam needs: `ask()` awaits the outermost answerer
 * with no timeout of its own, so a listener that never settles hangs the tool.
 *
 * @param signal - the request's cancellation lifetime, when it has one.
 * @param mode - how an abort should settle the gate.
 * @returns the gate promise plus its listener disposer.
 */
function abortGate(signal, mode) {
    if (signal === undefined)
        return { promise: new Promise(() => { }), dispose: () => { } };
    let fire = null;
    const promise = new Promise((resolve, reject) => {
        fire = () => {
            if (mode === 'release')
                resolve({ side: 'chat', value: null });
            else
                reject(signal.reason ?? new Error('user question request aborted'));
        };
        if (signal.aborted)
            fire();
        else
            signal.addEventListener('abort', fire, { once: true });
    });
    return {
        promise,
        dispose: () => {
            if (fire !== null)
                signal.removeEventListener('abort', fire);
        },
    };
}
/**
 * Seat a chat-controllable lifetime on a request the downstream chain will see.
 *
 * The Remote answerer forwards `request.signal` all the way to the API gateway,
 * which turns that signal's abort into the `cancel` frame a connected Web
 * client uses to drop its approval/question card and free the composer. When
 * the chat answers first the waterfall settles without that signal ever
 * aborting, so the browser would keep offering a decision already made
 * elsewhere. Composing a private branch over the original lets the adapter
 * abort only the browser delivery: the original signal still aborts the
 * composed one (turn cancel, timed wait), so cancellation semantics and the
 * asking service — which captured the original before the waterfall — are
 * untouched.
 *
 * @param request - the host's request object, shared by every downstream listener.
 * @returns the composed signal plus the browser-side abort, or null when the
 *   request cannot carry one (the chat answer still wins; the Web card merely
 *   stays until the request's own lifetime ends).
 *
 * ponytail: this leans on the Remote-event contract that the client honors a
 * gateway `cancel` frame for a still-pending prompt; if a future harness adds
 * a first-class "dismiss this interaction" seam, target that instead.
 */
function detachBrowser(request) {
    if (request === null || typeof request !== 'object')
        return null;
    const original = request.signal;
    if (original !== undefined && !(original instanceof AbortSignal))
        return null;
    const branch = new AbortController();
    const signal = original === undefined ? branch.signal : AbortSignal.any([original, branch.signal]);
    try {
        ;
        request.signal = signal;
    }
    catch {
        return null;
    }
    return { signal, cancel: () => branch.abort(new Error('已在其他端处理')) };
}
/** A string field of an unknown record, or undefined. */
function text(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/** The session id behind a request's Agent, or undefined when unknown. */
function sessionIdOf(agent) {
    const view = agent;
    return text(view?.id) ?? text(view?.session?.id) ?? text(view?.session?.header?.id);
}
/**
 * The bridge's host side: answerer waterfalls in, session/workspace calls out.
 */
export class DshInteractionHost {
    /** @param ctx - the plugin's host cordis context. */
    constructor(ctx) {
        this.ctx = ctx;
    }
    /**
     * Register the inbound answerer listeners.
     *
     * Both are prepended: the browser/Remote answerer is terminal (it holds the
     * decision slot until a Web client answers), so a listener registered after
     * it is never consulted while a Web UI is connected.
     *
     * @param sink - bridge callbacks that own the chat side of each prompt.
     * @returns a disposer removing both listeners.
     */
    attach(sink) {
        const listeners = [];
        try {
            listeners.push(this.ctx.on('approval/request', (request, next) => this.handleApproval(sink, request, next), { prepend: true }));
        }
        catch (error) {
            this.ctx.logger.warn('[notify] Cannot listen for approval requests:', error);
        }
        try {
            listeners.push(this.ctx.on('user-questions/request', (request, next) => this.handleQuestion(sink, request, next), { prepend: true }));
        }
        catch (error) {
            this.ctx.logger.warn('[notify] Cannot listen for user questions:', error);
        }
        return () => {
            for (const dispose of listeners) {
                try {
                    dispose();
                }
                catch (error) {
                    this.ctx.logger.warn('[notify] Interaction listener disposal failed:', error);
                }
            }
        };
    }
    // ── answerer waterfalls ──────────────────────────────────────────────────
    /**
     * Offer one approval to the chat and race it against the downstream chain.
     * A `null` chat answer (aborted request, or another answerer already won)
     * delegates by returning the downstream promise.
     */
    async handleApproval(sink, request, next) {
        const sessionId = sessionIdOf(request?.agent);
        if (!sessionId)
            return next();
        const browser = detachBrowser(request);
        const lifetime = browser?.signal ?? request?.signal;
        const view = {
            sessionId,
            toolName: text(request?.toolName) ?? '未知操作',
            ...(text(request?.callId) === undefined ? {} : { callId: text(request?.callId) }),
            ...(text(request?.reason) === undefined ? {} : { reason: text(request?.reason) }),
            ...(lifetime === undefined ? {} : { signal: lifetime }),
        };
        const mine = sink.approval(view);
        const downstream = this.downstream(next);
        const onLose = () => sink.drop('approval', sessionId, view.callId);
        const gate = abortGate(view.signal, 'release');
        try {
            const winner = await this.race([
                mine.then((value) => ({ side: 'chat', value })),
                downstream.then((value) => ({ side: 'down', value })),
                gate.promise,
            ], downstream, onLose);
            if (winner.side === 'chat')
                browser?.cancel();
            return winner.value;
        }
        finally {
            gate.dispose();
        }
    }
    /**
     * Offer one `ask_user_question` batch to the chat and race it against the
     * downstream chain. An aborted request signal rejects with that signal's own
     * reason: `ask()` awaits the outermost listener with no timeout of its own,
     * so an unsettled (or silently delegated) listener would hang the tool call.
     */
    async handleQuestion(sink, request, next) {
        const sessionId = sessionIdOf(request?.agent) ?? '';
        const questions = Array.isArray(request?.questions) ? request.questions : [];
        if (questions.length === 0)
            return next();
        const browser = detachBrowser(request);
        const lifetime = browser?.signal ?? request?.signal;
        const view = {
            sessionId,
            questions,
            ...(text(request?.wait?.callId) === undefined ? {} : { callId: text(request?.wait?.callId) }),
            ...(lifetime === undefined ? {} : { signal: lifetime }),
        };
        const mine = sink.question(view);
        const downstream = this.downstream(next);
        const onLose = () => sink.drop('question', sessionId, view.callId);
        // A question listener MUST settle: `ask()` awaits the outermost answerer
        // with no timeout of its own, so an abort rejects with the wait's own
        // reason (a timed wait turns that into `{ pending: true }`, a turn abort
        // into ASK_ABORTED) instead of hanging the tool call.
        const gate = abortGate(view.signal, 'throw');
        try {
            const winner = await this.race([
                mine.then((value) => ({ side: 'chat', value })),
                downstream.then((value) => ({ side: 'down', value })),
                gate.promise,
            ], downstream, onLose);
            if (winner.side === 'chat')
                browser?.cancel();
            return winner.value;
        }
        catch (error) {
            onLose();
            throw error;
        }
        finally {
            gate.dispose();
        }
    }
    /** Start the downstream answerer chain without letting a sync throw escape. */
    downstream(next) {
        return Promise.resolve().then(() => next());
    }
    /**
     * Resolve the first winner of the chat answer, the downstream chain, or an
     * abort gate, and say which side won. A chat `null` means the chat did not
     * claim, so the downstream promise is returned as-is (it may still settle
     * later) and is reported as a downstream win.
     */
    async race(racers, downstream, onLose) {
        const winner = await Promise.race(racers);
        if (winner.side === 'down') {
            onLose();
            return winner;
        }
        if (winner.value === null) {
            onLose();
            return { side: 'down', value: await downstream };
        }
        return winner;
    }
    // ── outbound host calls ──────────────────────────────────────────────────
    /** {@inheritDoc InteractionHost.prompt} */
    async prompt(sessionId, text_) {
        const controller = this.ctx.get('sessionController');
        if (controller?.prompt) {
            try {
                await controller.prompt({
                    requestId: randomUUID(),
                    sessionId,
                    mode: 'queue',
                    content: [{ type: 'text', text: text_ }],
                    clientTimeZone: CLIENT_TIME_ZONE,
                }, new AbortController().signal);
                return { ok: true };
            }
            catch (error) {
                return { ok: false, error: errorMessage(error) };
            }
        }
        // Fallback for compositions without the session controller: append to a
        // LIVE agent only. A cold session cannot be resumed here without the
        // controller's preset/ownership handling, so say so instead of guessing.
        const agents = this.ctx.get('agents');
        const agent = agents?.get?.(sessionId);
        if (!agent) {
            return { ok: false, error: '该会话当前不在运行，请先在 DSH Web 端打开它再重试' };
        }
        if (typeof agent.followup !== 'function') {
            return { ok: false, error: '当前宿主不支持向会话追加消息' };
        }
        try {
            agent.followup(makeUserMessage(text_));
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: errorMessage(error) };
        }
    }
    /** {@inheritDoc InteractionHost.listSessions} */
    async listSessions() {
        const controller = this.ctx.get('sessionController');
        if (controller?.list) {
            try {
                const result = await controller.list({}, new AbortController().signal);
                const items = Array.isArray(result?.items) ? result.items : [];
                return items.map((row) => this.summaryOf(row));
            }
            catch (error) {
                this.ctx.logger.warn('[notify] session list failed:', error);
                return null;
            }
        }
        // Controller-free fallback: the corpus reader knows headers only, so rows
        // carry no title and "blank" is approximated by the live session's log.
        const query = this.ctx.get('sessionQuery');
        if (!query?.listSessions)
            return null;
        try {
            const records = await query.listSessions();
            const sessions = this.ctx.get('sessions');
            const agents = this.ctx.get('agents');
            return records.flatMap((record) => {
                const header = record?.header ?? {};
                const sessionId = text(header.id);
                if (!sessionId)
                    return [];
                const live = sessions?.get?.(sessionId);
                const agent = agents?.get?.(sessionId);
                return [{
                        sessionId,
                        updatedAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
                        running: agent?.status === 'running',
                        blank: live?.seq === 0,
                        ...(text(header.cwd) === undefined ? {} : { cwd: text(header.cwd) }),
                        ...(header.origin === 'subagent' ? { origin: 'subagent' } : {}),
                        ...(live === undefined ? {} : { projections: { values: { title: this.titleOfLive(live) } } }),
                    }];
            });
        }
        catch (error) {
            this.ctx.logger.warn('[notify] session list failed:', error);
            return null;
        }
    }
    /** {@inheritDoc InteractionHost.listWorkspaces} */
    async listWorkspaces() {
        const registry = this.ctx.get('workspaceRegistry');
        if (!registry?.list)
            return null;
        try {
            return registry.list().flatMap((workspace) => {
                const workspaceId = workspace?.id === undefined ? undefined : String(workspace.id);
                if (workspaceId === undefined || workspace?.path === undefined)
                    return [];
                return [{
                        workspaceId,
                        path: workspace.path,
                        title: workspace.title ?? workspace.path,
                        sessionIds: [...(workspace.sessionIds ?? [])].map(String),
                    }];
            });
        }
        catch (error) {
            this.ctx.logger.warn('[notify] workspace list failed:', error);
            return null;
        }
    }
    /** {@inheritDoc InteractionHost.createSession} */
    async createSession(workspaceId) {
        const controller = this.ctx.get('sessionController');
        if (controller?.create) {
            try {
                const created = await controller.create({ workspaceId });
                const sessionId = text(created?.sessionId);
                return sessionId === undefined
                    ? { ok: false, error: '宿主未返回新的会话 id' }
                    : { ok: true, sessionId };
            }
            catch (error) {
                return { ok: false, error: errorMessage(error) };
            }
        }
        return { ok: false, error: '当前宿主不支持新建会话，请先在 DSH Web 端打开该工作区' };
    }
    // ── helpers ──────────────────────────────────────────────────────────────
    /** Project one controller summary row onto the menu's structural shape. */
    summaryOf(row) {
        const sessionId = String(row.sessionId ?? '');
        const summary = {
            sessionId,
            updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
            running: row.running === true,
            blank: row.blank === true,
        };
        const cwd = text(row.cwd);
        if (cwd !== undefined)
            summary.cwd = cwd;
        if (row.origin === 'subagent')
            summary.origin = 'subagent';
        const title = row.projections?.values?.title;
        if (typeof title === 'string' || title === null) {
            summary.projections = { values: { title: title ?? null } };
        }
        return summary;
    }
    /** Latest `session/title` recorded in a live session's log. */
    titleOfLive(session) {
        const events = typeof session.snapshotEvents === 'function'
            ? session.snapshotEvents()
            : Array.isArray(session.log) ? session.log : undefined;
        if (!Array.isArray(events))
            return undefined;
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (event?.type === 'session/title') {
                const title = text(event.data?.title);
                if (title !== undefined)
                    return title;
            }
        }
        return undefined;
    }
}
/**
 * Build the ordinary follow-up user message the Agent accepts.
 *
 * Mirrors the harness's `createUserMessage()` exactly (a detached, deep-frozen
 * `{ id, role, content, source }` with a fresh uuid id) so the plugin needs no
 * runtime import of `@deepseek-ai/dsh-llm`.
 */
function makeUserMessage(text_) {
    return deepFreeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: text_ }],
        source: { kind: 'user', rpcId: randomUUID() },
    });
}
/** Recursively freeze a plain JSON value (message snapshots are immutable). */
function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=host-interaction.js.map