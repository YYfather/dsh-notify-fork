import { Context } from '@deepseek-ai/cordis';
/**
 * Chat-channel two-way interaction bridge.
 *
 * Upgrades the WeChat/Telegram channels from one-way pushes to a remote-control
 * surface for DSH. It no longer talks to any API gateway: until 1.4.3 it drove
 * everything through `ctx.apiProxy` (`@deepseek-ai/dsh-host-apiproxy`), a
 * package the harness removed. It now composes with the current HOST seams:
 *
 *   - `approval/request`       — the Agent-scoped answerer waterfall. The
 *                                bridge registers with `prepend: true` (the
 *                                Remote/browser answerer is terminal once it
 *                                registers first), pushes the card, starts the
 *                                downstream chain itself and returns
 *                                `Promise.race([chatAnswer, downstream])` — so
 *                                whichever side answers first still wins.
 *   - `user-questions/request` — the same shape for `ask_user_question`.
 *   - `ctx.agents` / `agent.followup()`  — free-text continuation.
 *   - `ctx.sessionQuery` / `ctx.workspaceRegistry` — the /sessions and
 *                                /workspace menus.
 *
 * Every host service is soft-resolved through {@link InteractionHost}; a
 * deployment without one degrades to a clear chat message instead of failing.
 * All host shapes below are structural, so this file never imports a harness
 * package (that coupling is what broke the plugin on dsh-settings 0.1.2+).
 */
/** One selectable option of a question. */
export interface QuestionOption {
    label: string;
    description?: string;
}
/** One question in an ask_user_question batch. */
export interface QuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: QuestionOption[];
    multiSelect?: boolean;
}
/** One answer item, matching the host's `AskUserQuestionAnswerItem`. */
export interface QuestionAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}
/** The host's `AskUserQuestionAnswer`, structurally. */
export interface QuestionAnswer {
    answers: QuestionAnswerItem[];
}
/** Outcome vocabulary the approval seam accepts from a claiming answerer. */
export type ApprovalOutcome = 'allowed-once' | 'rejected';
/** One approval awaiting a human decision, as a chat channel sees it. */
export interface ApprovalRequestView {
    /** Session the request belongs to. */
    sessionId: string;
    /** Tool whose operation needs the decision. */
    toolName: string;
    /** Exact tool call, when the asker had one. */
    callId?: string;
    /** Human-readable reason supplied by the asker. */
    reason?: string;
    /** Cancellation lifetime of the pending request. */
    signal?: AbortSignal;
}
/** One `ask_user_question` batch awaiting a human answer. */
export interface QuestionRequestView {
    /** Session the request belongs to ('' when the host supplied no agent). */
    sessionId: string;
    /** Questions to display. */
    questions: QuestionItem[];
    /** Tool call the card is keyed by, when the host supplied one. */
    callId?: string;
    /** Cancellation lifetime of the pending request. */
    signal?: AbortSignal;
}
/**
 * Inbound prompts the host hands to the bridge. Each resolves with the chat's
 * answer, or `null` when the chat declined to claim (aborted / another
 * answerer already settled it) so the host can fall back to `next()`.
 */
export interface InteractionSink {
    /** Surface an approval and resolve with the decision the chat user made. */
    approval(view: ApprovalRequestView): Promise<ApprovalOutcome | null>;
    /** Surface a question batch and resolve with the chat user's answer. */
    question(view: QuestionRequestView): Promise<QuestionAnswer | null>;
    /** Forget a prompt another answerer settled, so a late chat reply reports it. */
    drop(kind: 'approval' | 'question', sessionId: string, callId?: string): void;
}
/** Structural session row the /sessions menu consumes. */
export interface SessionSummaryLike {
    sessionId: string;
    updatedAt: number;
    running: boolean;
    blank: boolean;
    cwd?: string;
    origin?: 'subagent';
    projections?: {
        values?: {
            title?: string | null;
        };
    };
}
/** Structural workspace row the /workspace menu consumes. */
export interface WorkspaceViewLike {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
}
/** Outcome of injecting a chat reply as a follow-up user message. */
export interface PromptResult {
    ok: boolean;
    error?: string;
}
/** Outcome of creating a session inside a workspace. */
export interface CreateSessionResult {
    ok: boolean;
    sessionId?: string;
    error?: string;
}
/**
 * Host seams the bridge drives. `attach` wires the answerer waterfalls;
 * everything else is a plain host call. Implemented by `DshInteractionHost`.
 */
export interface InteractionHost {
    /** Register the inbound prompt listeners; returns a disposer. */
    attach(sink: InteractionSink): () => void;
    /** Inject `text` into `sessionId` as an ordinary follow-up user message. */
    prompt(sessionId: string, text: string): Promise<PromptResult>;
    /** Recent continuable sessions, or null when the host cannot list them. */
    listSessions(): Promise<SessionSummaryLike[] | null>;
    /** Registered workspaces, or null when the host cannot list them. */
    listWorkspaces(): Promise<WorkspaceViewLike[] | null>;
    /** Create (or adopt) a session in a workspace. */
    createSession(workspaceId: string): Promise<CreateSessionResult>;
}
/** A pending approval pushed to the interactive channels. */
interface PendingApproval {
    kind: 'approval';
    sessionId: string;
    callId?: string;
    toolName: string;
    reason?: string;
    createdAt: number;
    workspace?: string;
    settle(outcome: ApprovalOutcome | null): void;
}
/** A pending question batch pushed to the interactive channels. */
interface PendingQuestion {
    kind: 'question';
    sessionId: string;
    questions: QuestionItem[];
    createdAt: number;
    workspace?: string;
    settle(answer: QuestionAnswer | null): void;
}
/** A pending answerable interaction pushed to interactive channels. */
export type PromptInteraction = PendingApproval | PendingQuestion;
/** Internal alias. */
type PendingInteraction = PromptInteraction;
/** One button of a channel menu (text label + opaque callback payload). */
export interface MenuButton {
    text: string;
    data: string;
}
/**
 * A structured selection menu. Channels with inline keyboards (Telegram)
 * render the buttons; text-only channels (WeChat) fall back to `text`,
 * which must list entries numbered so the user can reply `/sel <kind> <n>`.
 */
export interface MenuMessage {
    text: string;
    buttons: MenuButton[][];
}
/** Wiring the bridge needs from the notify service. */
export interface InteractionBridgeHooks {
    /** Push a plain-text message to every interactive channel. */
    pushText(text: string): Promise<void>;
    /**
     * Push an approval/question prompt with channel-native affordances (e.g.
     * Telegram inline-keyboard buttons). Channels without buttons render text
     * via the bridge's public formatters. Resolve TRUE when every configured
     * channel was served; false/undefined falls back to plain pushText.
     */
    sendPrompt?(entry: PromptInteraction): Promise<boolean>;
    /**
     * Push a selection menu (session/workspace picker) with channel-native
     * buttons. Same contract as sendPrompt: TRUE means served; false/undefined
     * falls back to plain pushText of menu.text.
     */
    sendMenu?(menu: MenuMessage): Promise<boolean>;
    /** Whether a channel user may drive interactions (channel allowlists). */
    canInteract(userId: string): boolean;
}
export declare class InteractionBridge {
    private ctx;
    private host;
    private hooks;
    /** Pending answerable interactions in arrival order (newest last). */
    private pending;
    /** Session that received the most recent push — the continuation target. */
    private lastSessionId;
    /** Human labels per session (workspace basename), learned from pushes. */
    private sessionLabels;
    /** Latest menu alias tables: kind → ordered ids (1-based for the user). */
    private menuAliases;
    /** Host listener disposer while attached. */
    private detach;
    private running;
    constructor(ctx: Context, host: InteractionHost, hooks: InteractionBridgeHooks);
    /** Subscribe to the host's answerer waterfalls. Idempotent. */
    start(): void;
    /** Detach from the host and release every pending prompt unanswered. */
    dispose(): void;
    /**
     * Remember that a notification went out for a session, so a later free-text
     * WeChat reply continues THAT conversation.
     */
    noteNotification(sessionId: string | undefined, workspace?: string): void;
    /** Whether the bridge is attached to the host answerer seams. */
    get isActive(): boolean;
    /** Number of pending interactions (diagnostics/tests). */
    get pendingCount(): number;
    /**
     * Surface one approval and hold the seam open until the chat answers. The
     * host adapter races this against the downstream answerer chain, so the Web
     * UI can still claim the request first; a `null` resolution means the chat
     * lost (or the bridge was disposed) and the host falls back to the chain.
     */
    private onApprovalRequest;
    /** Surface one question batch and hold the seam open until the chat answers. */
    private onQuestionRequest;
    /**
     * Another answerer settled a prompt first (the host reports the downstream
     * winner). Resolve it with `null` so the waiting seam delegates, and drop it
     * so a later chat reply reports "已在其他端处理" instead of re-answering.
     */
    private dropPending;
    private track;
    /**
     * Route one inbound WeChat text message: answer the newest pending
     * interaction when one exists, otherwise continue the most recently
     * notified conversation. Sends a WeChat receipt for every outcome.
     */
    handleReply(userId: string, text: string): Promise<void>;
    /** Card replies must target the exact live prompt, never the latest one. */
    handlePromptReply(userId: string, text: string, entry: PromptInteraction): Promise<boolean>;
    private answerApproval;
    private answerQuestion;
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
    private parseQuestionAnswers;
    /**
     * Free-text continuation: inject the reply into the most recently notified
     * session as an ordinary follow-up message (queue mode — it runs as the
     * next turn, or after the in-flight one settles).
     */
    private continueConversation;
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
    private handleCommand;
    /** /sessions — menu of recent conversations. */
    private cmdSessions;
    /** /workspace — menu of workspaces. */
    private cmdWorkspaces;
    /** /current — report the continuation target. */
    private cmdCurrent;
    /** /sel s|w <n|id> — apply a menu pick (button callback or typed). */
    private cmdSelect;
    /** Switch the continuation target to a conversation. */
    private selectSession;
    /**
     * Switch the default workspace: reuse the workspace's most recent
     * conversation when one exists, otherwise create a fresh session there.
     */
    private selectWorkspace;
    /** Recent continuable conversations (non-blank, non-subagent), or null on failure. */
    private listRecentSessions;
    /** Resolve a menu pick: an all-digit ref indexes the latest menu of that
     *  kind; anything else is treated as a raw id. */
    private resolveAlias;
    /** Push a selection menu: channels with buttons get the structured form,
     *  others the numbered text (whose /sel commands the bridge parses back). */
    private pushMenu;
    /** Display title of a session row: projection title, else a short id. */
    private titleOf;
    /** Basename of a cwd, for labeling sessions. */
    private workspaceLabel;
    /**
     * Push an answerable prompt: channels with native affordances get the
     * structured entry via hooks.sendPrompt; when no channel claims it the
     * plain-text rendering goes to hooks.pushText.
     */
    private pushPrompt;
    /**
     * Push an answerable prompt without letting a channel failure escape into the
     * host's answerer waterfall: a throw there fails the approval closed
     * ('unavailable') and denies the operation, even though the browser could
     * still have answered. The seam stays open either way.
     */
    private pushPromptSafely;
    /** Public plain-text rendering of an approval prompt (channels without buttons). */
    formatApprovalPush(entry: Extract<PendingInteraction, {
        kind: 'approval';
    }>): string;
    /** Public plain-text rendering of a question prompt (channels without buttons). */
    formatQuestionPush(entry: Extract<PendingInteraction, {
        kind: 'question';
    }>): string;
    private labelOf;
}
export {};
//# sourceMappingURL=interaction.d.ts.map