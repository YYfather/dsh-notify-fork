/** Reply vocabulary for approvals (case-insensitive). */
const APPROVE_WORDS = new Set(['y', 'yes', 'ok', 'approve', '允许', '批准', '同意', '好', '好的', '是', '确认']);
const REJECT_WORDS = new Set(['n', 'no', 'reject', 'deny', '拒绝', '不', '不用', '否', '取消']);
/** Pending interactions older than this are dropped defensively (the host
 *  normally resolves or cancels them long before). */
const PENDING_TTL_MS = 60 * 60000;
/** How many entries the /sessions and /workspace menus list at most. */
const MENU_PAGE_SIZE = 8;
export class InteractionBridge {
    constructor(ctx, host, hooks) {
        /** Pending answerable interactions in arrival order (newest last). */
        this.pending = [];
        /** Human labels per session (workspace basename), learned from pushes. */
        this.sessionLabels = new Map();
        /** Latest menu alias tables: kind → ordered ids (1-based for the user). */
        this.menuAliases = new Map();
        /** Continuation target per bot ('' / 'main' = the general bot). */
        this.sessionsByBot = new Map();
        /** Bot that owns the message currently being handled. */
        this.activeBot = 'main';
        /** Host listener disposer while attached. */
        this.detach = null;
        this.running = false;
        this.ctx = ctx;
        this.host = host;
        this.hooks = hooks;
    }
    /** Subscribe to the host's answerer waterfalls. Idempotent. */
    start() {
        if (this.running)
            return;
        this.running = true;
        this.detach = this.host.attach({
            approval: (view) => this.onApprovalRequest(view),
            question: (view) => this.onQuestionRequest(view),
            drop: (kind, sessionId, callId) => this.dropPending(kind, sessionId, callId),
        });
    }
    /** Detach from the host and release every pending prompt unanswered. */
    dispose() {
        this.running = false;
        this.detach?.();
        this.detach = null;
        for (const entry of this.pending)
            entry.settle(null);
        this.pending = [];
    }
    /**
     * Remember that a notification went out for a session, so a later free-text
     * WeChat reply continues THAT conversation.
     */
    /** Continuation target of the bot currently handling the message. */
    get lastSessionId() {
        return this.sessionsByBot.get(this.activeBot) ?? null;
    }

    set lastSessionId(sessionId) {
        if (sessionId)
            this.sessionsByBot.set(this.activeBot, sessionId);
        else
            this.sessionsByBot.delete(this.activeBot);
    }

    /**
     * Remember which conversation a bot last pushed, so a free-text reply on THAT
     * bot continues THAT conversation (each bot keeps its own pointer).
     */
    noteNotification(sessionId, workspace, botKey = this.activeBot) {
        if (!sessionId)
            return;
        this.sessionsByBot.set(botKey || 'main', sessionId);
        if (workspace)
            this.sessionLabels.set(sessionId, workspace);
    }
    /** Whether the bridge is attached to the host answerer seams. */
    get isActive() {
        return this.running;
    }
    /** Number of pending interactions (diagnostics/tests). */
    get pendingCount() {
        return this.pending.length;
    }
    // ── inbound prompts (host → chat) ─────────────────────────────────────────
    /**
     * Surface one approval and hold the seam open until the chat answers. The
     * host adapter races this against the downstream answerer chain, so the Web
     * UI can still claim the request first; a `null` resolution means the chat
     * lost (or the bridge was disposed) and the host falls back to the chain.
     */
    async onApprovalRequest(view) {
        let settle;
        const answered = new Promise((resolve) => { settle = resolve; });
        const entry = {
            kind: 'approval',
            sessionId: view.sessionId,
            callId: view.callId,
            toolName: view.toolName,
            reason: view.reason,
            createdAt: Date.now(),
            settle,
        };
        this.track(entry);
        this.noteNotification(view.sessionId);
        await this.pushPromptSafely(entry, this.formatApprovalPush(entry));
        return answered;
    }
    /** Surface one question batch and hold the seam open until the chat answers. */
    async onQuestionRequest(view) {
        let settle;
        const answered = new Promise((resolve) => { settle = resolve; });
        const entry = {
            kind: 'question',
            sessionId: view.sessionId,
            questions: view.questions,
            createdAt: Date.now(),
            settle,
        };
        this.track(entry);
        if (view.sessionId)
            this.noteNotification(view.sessionId);
        await this.pushPromptSafely(entry, this.formatQuestionPush(entry));
        return answered;
    }
    /**
     * Another answerer settled a prompt first (the host reports the downstream
     * winner). Resolve it with `null` so the waiting seam delegates, and drop it
     * so a later chat reply reports "已在其他端处理" instead of re-answering.
     */
    dropPending(kind, sessionId, callId) {
        const dropped = this.pending.filter((entry) => {
            if (entry.kind !== kind)
                return false;
            if (entry.sessionId !== sessionId)
                return false;
            if (kind === 'approval' && callId !== undefined) {
                const approval = entry;
                if (approval.callId !== undefined && approval.callId !== callId)
                    return false;
            }
            return true;
        });
        if (dropped.length === 0)
            return;
        this.pending = this.pending.filter((entry) => !dropped.includes(entry));
        for (const entry of dropped)
            entry.settle(null);
    }
    track(entry) {
        const cutoff = Date.now() - PENDING_TTL_MS;
        this.pending = this.pending.filter((p) => p.createdAt >= cutoff);
        this.pending.push(entry);
    }
    // ── reply routing ──────────────────────────────────────────────────────────
    /**
     * Route one inbound WeChat text message: answer the newest pending
     * interaction when one exists, otherwise continue the most recently
     * notified conversation. Sends a WeChat receipt for every outcome.
     */
    async handleReply(userId, text, botKey = 'main') {
        this.activeBot = botKey || 'main';
        if (!this.hooks.canInteract(userId)) {
            this.ctx.logger.warn('[notify] Ignoring WeChat reply from non-allowlisted user %s', userId);
            return;
        }
        const reply = text.trim();
        if (!reply)
            return;
        // Slash commands (menu/selection) take priority over pending-answer
        // routing so the user can always navigate away mid-approval.
        if (reply.startsWith('/')) {
            await this.handleCommand(reply);
            return;
        }
        const pending = this.pending[this.pending.length - 1];
        if (pending?.kind === 'approval') {
            await this.answerApproval(pending, reply);
            return;
        }
        if (pending?.kind === 'question') {
            await this.answerQuestion(pending, reply);
            return;
        }
        await this.continueConversation(reply);
    }
    /** Card replies must target the exact live prompt, never the latest one. */
    async handlePromptReply(userId, text, entry, botKey = 'main') {
        this.activeBot = botKey || 'main';
        if (!this.running || !this.hooks.canInteract(userId)
            || !this.pending.includes(entry) || Date.now() - entry.createdAt > PENDING_TTL_MS)
            return false;
        if (entry.kind === 'approval')
            await this.answerApproval(entry, text.trim());
        else
            await this.answerQuestion(entry, text.trim());
        return !this.pending.includes(entry);
    }
    async answerApproval(pending, reply) {
        const word = reply.toLowerCase();
        const outcome = APPROVE_WORDS.has(word) ? 'allowed-once' : REJECT_WORDS.has(word) ? 'rejected' : null;
        if (!outcome) {
            await this.hooks.pushText(`❓ 无法识别「${reply}」。当前有待处理的授权请求（${pending.toolName}），请回复 Y 批准 / N 拒绝`);
            return;
        }
        // Claim the waterfall slot. The bridge returns from its answerer seam the
        // moment this resolves, and the racing downstream chain (Web UI) loses.
        this.pending = this.pending.filter((p) => p !== pending);
        pending.settle(outcome);
        const label = this.labelOf(pending.sessionId);
        await this.hooks.pushText(outcome === 'allowed-once'
            ? `✅ 已批准${label}的 ${pending.toolName} 操作`
            : `🚫 已拒绝${label}的 ${pending.toolName} 操作`);
    }
    async answerQuestion(pending, reply) {
        const answers = this.parseQuestionAnswers(pending.questions, reply);
        if (!answers) {
            await this.hooks.pushText(`❓ 无法识别「${reply}」。\n\n${this.formatQuestionPush(pending)}`);
            return;
        }
        // Claim the waterfall slot: the answerer that resolves first wins, so a
        // browser that answered a moment ago has already dropped this entry.
        this.pending = this.pending.filter((p) => p !== pending);
        pending.settle({ answers });
        const summary = answers
            .map((a) => a.selected.join('、') || a.custom || '')
            .filter(Boolean)
            .join('；');
        await this.hooks.pushText(`✅ 已提交回答: ${summary}`);
    }
    /**
     * Parse a WeChat reply into per-question answers.
     *
     * - Multiple questions: split the reply on newlines / ，；; and assign one
     *   segment per question in order; questions without a segment are answered
     *   with their first option... no — left with an empty selection and the
     *   full reply as custom text is wrong too. They are simply OMITTED from
     *   the answers array (the host passes answers through verbatim; the model
     *   sees which questions got answered).
     * - Optioned question, numeric segment → that option's label (multi-select
     *   accepts several numbers); a segment equal to an option label selects it;
     *   anything else becomes a custom free-text answer.
     * - Question without options → the segment is the custom answer.
     *
     * Returns null when the reply cannot be mapped at all.
     */
    parseQuestionAnswers(questions, reply) {
        const segments = questions.length > 1
            ? reply.split(/[\n，；;,]/).map((s) => s.trim()).filter(Boolean)
            : [reply];
        if (segments.length === 0)
            return null;
        const answers = [];
        for (let i = 0; i < Math.min(segments.length, questions.length); i++) {
            const question = questions[i];
            const segment = segments[i];
            const options = question.options ?? [];
            if (options.length > 0) {
                // Numeric selection (multi-select allows several numbers).
                const nums = segment.split(/[\s、]+/).filter(Boolean);
                const numeric = nums.every((n) => /^\d+$/.test(n));
                if (numeric && nums.length > 0) {
                    const picked = nums
                        .map((n) => options[Number(n) - 1]?.label)
                        .filter((label) => typeof label === 'string');
                    if (picked.length === 0)
                        return null;
                    if (!question.multiSelect && picked.length > 1)
                        return null;
                    answers.push({ id: question.id, selected: question.multiSelect ? picked : [picked[0]] });
                    continue;
                }
                // Exact option label match.
                const byLabel = options.find((o) => o.label === segment || o.label.toLowerCase() === segment.toLowerCase());
                if (byLabel) {
                    answers.push({ id: question.id, selected: [byLabel.label] });
                    continue;
                }
                // Free text on an optioned question = the "Other" custom answer.
                answers.push({ id: question.id, selected: [], custom: segment });
            }
            else {
                answers.push({ id: question.id, selected: [], custom: segment });
            }
        }
        return answers.length > 0 ? answers : null;
    }
    /**
     * Free-text continuation: inject the reply into the most recently notified
     * session as an ordinary follow-up message (queue mode — it runs as the
     * next turn, or after the in-flight one settles).
     */
    async continueConversation(text) {
        const sessionId = this.lastSessionId;
        if (!sessionId) {
            await this.hooks.pushText('ℹ️ 还没有可续接的会话（先让 DSH 推送一条通知）');
            return;
        }
        const result = await this.host.prompt(sessionId, text);
        if (result.ok) {
            await this.hooks.pushText(`📨 已发送到${this.labelOf(sessionId)}会话，排队等待执行`);
        }
        else {
            const message = result.error ?? 'unknown error';
            this.ctx.logger.warn('[notify] continuation failed: %s', message);
            await this.hooks.pushText(`⚠️ 发送失败: ${message}`);
        }
    }
    // ── slash commands (session/workspace menus) ─────────────────────────────
    /**
     * Route a `/`-prefixed message. Grammar:
     *
     *   /sessions          — list recent conversations, tap/reply to switch
     *   /workspace         — list workspaces, tap/reply to switch (reuses the
     *                        workspace's latest conversation, else creates one)
     *   /current           — show the current continuation target
     *   /sel s|w <n|id>    — pick entry n (latest menu) or a raw id
     *   /help, /start      — command help
     *
     * Telegram delivers these as typed commands (registered via setMyCommands)
     * or as button callbacks translated back into `/sel …`; WeChat users type
     * them. A trailing `@botname` (Telegram group syntax) is stripped.
     */
    async handleCommand(reply) {
        const [rawToken, ...rest] = reply.slice(1).split(/\s+/);
        const token = (rawToken ?? '').split('@')[0].toLowerCase();
        switch (token) {
            case 'sessions':
            case 'session':
                await this.cmdSessions();
                return;
            case 'workspace':
            case 'workspaces':
                await this.cmdWorkspaces();
                return;
            case 'current':
                await this.cmdCurrent();
                return;
            case 'sel':
            case 'select':
                await this.cmdSelect(rest);
                return;
            case 'detail':
                await this.cmdDetail();
                return;
            case 'push':
            case 'pushes':
                await this.cmdPush(rest);
                return;
            case 'help':
            case 'start':
            default:
                await this.hooks.pushText([
                    '📱 可用命令：',
                    '  /sessions — 选择要续接的对话',
                    '  /workspace — 切换工作区（沿用其最新对话，没有则新建）',
                    '  /current — 查看当前对话',
                    '  /detail — 拉取当前对话最近一轮的详情',
                    '  /push — 查看/设置各工作区是否推送（/push 2 off）',
                    '',
                    '直接发送文字即续接当前对话；有待处理的审批/问题时，回复 Y/N 或选项序号。',
                ].join('\n'));
        }
    }
    /** /sessions — menu of recent conversations. */
    async cmdSessions() {
        const sessions = await this.listRecentSessions();
        if (!sessions)
            return; // failure receipt already pushed
        if (sessions.length === 0) {
            await this.hooks.pushText('ℹ️ 还没有可选择的对话（可先用 /workspace 切换工作区新建一个）');
            return;
        }
        this.menuAliases.set('s', sessions.map((s) => s.sessionId));
        const lines = sessions.map((s, i) => {
            const running = s.running ? ' ⏳' : '';
            const current = s.sessionId === this.lastSessionId ? ' 👈当前' : '';
            return `${i + 1}. [${this.workspaceLabel(s.cwd)}] ${this.titleOf(s)}${running}${current}`;
        });
        await this.pushMenu({
            text: ['💬 选择要续接的对话（回复 /sel s 序号）：', '', ...lines].join('\n'),
            buttons: sessions.map((s, i) => [{
                    text: `${i + 1}. ${this.titleOf(s)}${s.sessionId === this.lastSessionId ? ' 👈' : ''}`,
                    data: `/sel s ${i + 1}`,
                }]),
        });
    }
    /** /workspace — menu of workspaces. */
    async cmdWorkspaces() {
        const all = await this.host.listWorkspaces();
        // A dedicated bot is locked to its own workspace.
        const own = this.hooks.workspaceOfBot?.(this.activeBot);
        const items = own ? (all ?? []).filter((workspace) => workspace.path === own) : all;
        if (!items) {
            await this.hooks.pushText('⚠️ 获取工作区列表失败：当前宿主未提供工作区注册表');
            return;
        }
        if (items.length === 0) {
            await this.hooks.pushText('ℹ️ 还没有注册任何工作区（先在 Web 界面创建一个）');
            return;
        }
        this.menuAliases.set('w', items.map((w) => w.workspaceId));
        const lines = items.map((w, i) => `${i + 1}. ${w.title} — ${w.path}`);
        await this.pushMenu({
            text: ['📁 选择工作区（回复 /sel w 序号）：', '', ...lines].join('\n'),
            buttons: items.map((w, i) => [{ text: `📁 ${w.title}`, data: `/sel w ${i + 1}` }]),
        });
    }
    /** /current — report the continuation target. */
    async cmdCurrent() {
        if (!this.lastSessionId) {
            await this.hooks.pushText('ℹ️ 当前没有选中的对话（/sessions 选择，/workspace 切换工作区）');
            return;
        }
        await this.hooks.pushText(`📍 当前对话：${this.labelOf(this.lastSessionId)}${this.lastSessionId.slice(0, 8)}…`);
    }
    /**
     * /push — per-workspace notification switches.
     *
     *   /push                      list every registered workspace + its mode
     *   /push <n|*> <mode>         set one (or all) to off | status | full | default
     */
    async cmdPush(args) {
        const readRules = this.hooks.readRules;
        const applyRules = this.hooks.applyRules;
        if (typeof readRules !== 'function' || typeof applyRules !== 'function') {
            await this.hooks.pushText('⚠️ 当前宿主不支持推送开关');
            return;
        }
        const rules = await readRules();
        const [target, action] = args;
        if (!target || !action) {
            const label = (cfg) => `${cfg.enabled ? '✅' : '🔇'} ${cfg.events.length} 类消息`;
            await this.hooks.pushText([
                '📡 推送通道',
                '',
                `企业微信：${label(rules.channels.wecom)}`,
                `微信(Server酱)：${label(rules.channels.serverchan)}`,
                `单独绑定：${rules.bindings.length} 个工作区`,
                '',
                '开关：/push wecom on|off，/push serverchan on|off',
                '单工作区开关请在 DSH 设置 → 通知 → 推送规则 里改',
            ].join('\n'));
            return;
        }
        const name = String(target).toLowerCase();
        if (name !== 'wecom' && name !== 'serverchan') {
            await this.hooks.pushText('❓ 用法：/push wecom on|off 或 /push serverchan on|off');
            return;
        }
        const enabled = String(action).toLowerCase() === 'on' || String(action).toLowerCase() === 'enable';
        await applyRules({ channels: { [name]: { ...rules.channels[name], enabled } } });
        await this.hooks.pushText(`✅ ${name === 'wecom' ? '企业微信' : '微信(Server酱)'} 已${enabled ? '开启' : '关闭'}`);
    }
    /** /detail — pull the last finished turn of the current conversation. */
    async cmdDetail() {
        if (!this.lastSessionId) {
            await this.hooks.pushText('ℹ️ 当前没有选中的对话（/sessions 选择，/workspace 切换工作区）');
            return;
        }
        const readDetail = this.hooks.readDetail;
        if (typeof readDetail !== 'function') {
            await this.hooks.pushText('⚠️ 当前宿主不支持拉取详情');
            return;
        }
        let receipt = '';
        try {
            receipt = await readDetail(this.lastSessionId);
        }
        catch (error) {
            receipt = `⚠️ 读取详情失败：${error instanceof Error ? error.message : String(error)}`;
        }
        await this.hooks.pushText(receipt || 'ℹ️ 暂无详情');
    }
    /** /sel s|w <n|id> — apply a menu pick (button callback or typed). */
    async cmdSelect(args) {
        const kind = (args[0] ?? '').toLowerCase();
        const ref = args[1] ?? '';
        if ((kind !== 's' && kind !== 'w') || !ref) {
            await this.hooks.pushText('❓ 用法: /sel s <序号> 选择对话，/sel w <序号> 选择工作区');
            return;
        }
        const id = this.resolveAlias(kind, ref);
        if (!id) {
            await this.hooks.pushText('❓ 无效的序号，请先用 /sessions 或 /workspace 调出菜单');
            return;
        }
        if (kind === 's')
            await this.selectSession(id);
        else
            await this.selectWorkspace(id);
    }
    /** Switch the continuation target to a conversation. */
    async selectSession(sessionId) {
        this.lastSessionId = sessionId;
        await this.hooks.pushText(`✅ 已切换到对话 ${this.labelOf(sessionId)}${sessionId.slice(0, 8)}…，直接发消息即可续接`);
    }
    /**
     * Switch the default workspace: reuse the workspace's most recent
     * conversation when one exists, otherwise create a fresh session there.
     */
    async selectWorkspace(workspaceId) {
        const items = await this.host.listWorkspaces();
        const workspace = items?.find((w) => w.workspaceId === workspaceId);
        if (!workspace) {
            await this.hooks.pushText('⚠️ 该工作区不存在或已删除，请重新 /workspace 调出菜单');
            return;
        }
        const sessions = await this.listRecentSessions();
        const existing = sessions?.find((s) => s.cwd === workspace.path);
        if (existing) {
            this.lastSessionId = existing.sessionId;
            this.sessionLabels.set(existing.sessionId, workspace.title);
            await this.hooks.pushText(`✅ 已切换到工作区「${workspace.title}」的对话：${this.titleOf(existing)}`);
            return;
        }
        const created = await this.host.createSession(workspaceId);
        if (created.ok && created.sessionId) {
            this.lastSessionId = created.sessionId;
            this.sessionLabels.set(created.sessionId, workspace.title);
            await this.hooks.pushText(`✅ 工作区「${workspace.title}」暂无对话，已新建一个，直接发消息即可开始`);
        }
        else {
            await this.hooks.pushText(`⚠️ 在工作区「${workspace.title}」新建对话失败: ${created.error ?? 'unknown error'}`);
        }
    }
    /** Recent continuable conversations (non-blank, non-subagent), or null on failure. */
    async listRecentSessions() {
        const own = this.hooks.workspaceOfBot?.(this.activeBot);
        const items = await this.host.listSessions();
        if (!items) {
            await this.hooks.pushText('⚠️ 获取会话列表失败：当前宿主未提供会话查询服务');
            return null;
        }
        const recent = items
            .filter((s) => !s.blank && s.origin !== 'subagent')
            .filter((s) => !own || s.cwd === own)
            .slice(0, MENU_PAGE_SIZE);
        // Learn labels/titles so receipts can name sessions later.
        for (const s of recent)
            this.sessionLabels.set(s.sessionId, this.workspaceLabel(s.cwd));
        return recent;
    }
    /** Resolve a menu pick: an all-digit ref indexes the latest menu of that
     *  kind; anything else is treated as a raw id. */
    resolveAlias(kind, ref) {
        if (/^\d+$/.test(ref)) {
            const aliases = this.menuAliases.get(kind);
            const id = aliases?.[Number(ref) - 1];
            return id ?? null;
        }
        return ref;
    }
    /** Push a selection menu: channels with buttons get the structured form,
     *  others the numbered text (whose /sel commands the bridge parses back). */
    async pushMenu(menu) {
        const handled = (await this.hooks.sendMenu?.(menu)) === true;
        if (!handled)
            await this.hooks.pushText(menu.text);
    }
    /** Display title of a session row: projection title, else a short id. */
    titleOf(session) {
        const title = session.projections?.values?.title;
        return title && title.trim() ? title.trim() : `会话 ${session.sessionId.slice(0, 8)}…`;
    }
    /** Basename of a cwd, for labeling sessions. */
    workspaceLabel(cwd) {
        if (!cwd)
            return '?';
        return cwd.split('/').filter(Boolean).pop() || cwd;
    }
    // ── push formatting ────────────────────────────────────────────────────────
    /**
     * Push an answerable prompt: channels with native affordances get the
     * structured entry via hooks.sendPrompt; when no channel claims it the
     * plain-text rendering goes to hooks.pushText.
     */
    async pushPrompt(entry, plainText) {
        // Attach the workspace label when known so button-ized channels can head
        // their cards with `[workspace] 需要授权` like the plain-text rendering.
        const workspace = this.sessionLabels.get(entry.sessionId);
        if (workspace)
            entry.workspace = workspace;
        const handled = (await this.hooks.sendPrompt?.(entry)) === true;
        if (!handled)
            await this.hooks.pushText(plainText);
    }
    /**
     * Push an answerable prompt without letting a channel failure escape into the
     * host's answerer waterfall: a throw there fails the approval closed
     * ('unavailable') and denies the operation, even though the browser could
     * still have answered. The seam stays open either way.
     */
    async pushPromptSafely(entry, plainText) {
        try {
            await this.pushPrompt(entry, plainText);
        }
        catch (error) {
            this.ctx.logger.warn('[notify] Failed to push an interaction prompt:', error);
        }
    }
    /** Public plain-text rendering of an approval prompt (channels without buttons). */
    formatApprovalPush(entry) {
        const lines = [];
        lines.push(`🔐 ${this.labelOf(entry.sessionId)}需要授权`);
        lines.push('');
        lines.push(`🔧 操作: ${entry.toolName}`);
        if (entry.reason)
            lines.push(`📝 原因: ${entry.reason}`);
        lines.push('');
        lines.push('回复 Y 批准 / N 拒绝');
        return lines.join('\n');
    }
    /** Public plain-text rendering of a question prompt (channels without buttons). */
    formatQuestionPush(entry) {
        const lines = [];
        lines.push(`❓ ${this.labelOf(entry.sessionId)}需要回答`);
        lines.push('');
        entry.questions.forEach((q, qi) => {
            if (entry.questions.length > 1)
                lines.push(`【问题 ${qi + 1}】`);
            if (q.header)
                lines.push(`📌 ${q.header}`);
            lines.push(q.question);
            if (q.options && q.options.length > 0) {
                q.options.forEach((o, oi) => {
                    lines.push(`  ${oi + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`);
                });
                lines.push(q.multiSelect ? '回复选项序号（可多选，空格分隔）或自定义文字' : '回复选项序号或自定义文字');
            }
            else {
                lines.push('直接回复文字作答');
            }
        });
        if (entry.questions.length > 1) {
            lines.push('');
            lines.push('多个问题请按顺序用「，」或换行分隔回答');
        }
        return lines.join('\n');
    }
    labelOf(sessionId) {
        const workspace = this.sessionLabels.get(sessionId);
        return workspace ? `[${workspace}] ` : '';
    }
}
//# sourceMappingURL=interaction.js.map