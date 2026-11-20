import { Context } from '@deepseek-ai/cordis';
import type { CreateSessionResult, InteractionHost, InteractionSink, PromptResult, SessionSummaryLike, WorkspaceViewLike } from './interaction.js';
/**
 * The bridge's host side: answerer waterfalls in, session/workspace calls out.
 */
export declare class DshInteractionHost implements InteractionHost {
    private readonly ctx;
    /** @param ctx - the plugin's host cordis context. */
    constructor(ctx: Context);
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
    attach(sink: InteractionSink): () => void;
    /**
     * Offer one approval to the chat and race it against the downstream chain.
     * A `null` chat answer (aborted request, or another answerer already won)
     * delegates by returning the downstream promise.
     */
    private handleApproval;
    /**
     * Offer one `ask_user_question` batch to the chat and race it against the
     * downstream chain. An aborted request signal rejects with that signal's own
     * reason: `ask()` awaits the outermost listener with no timeout of its own,
     * so an unsettled (or silently delegated) listener would hang the tool call.
     */
    private handleQuestion;
    /** Start the downstream answerer chain without letting a sync throw escape. */
    private downstream;
    /**
     * Resolve the first winner of the chat answer, the downstream chain, or an
     * abort gate, and say which side won. A chat `null` means the chat did not
     * claim, so the downstream promise is returned as-is (it may still settle
     * later) and is reported as a downstream win.
     */
    private race;
    /** {@inheritDoc InteractionHost.prompt} */
    prompt(sessionId: string, text_: string): Promise<PromptResult>;
    /** {@inheritDoc InteractionHost.listSessions} */
    listSessions(): Promise<SessionSummaryLike[] | null>;
    /** {@inheritDoc InteractionHost.listWorkspaces} */
    listWorkspaces(): Promise<WorkspaceViewLike[] | null>;
    /** {@inheritDoc InteractionHost.createSession} */
    createSession(workspaceId: string): Promise<CreateSessionResult>;
    /** Project one controller summary row onto the menu's structural shape. */
    private summaryOf;
    /** Latest `session/title` recorded in a live session's log. */
    private titleOfLive;
}
//# sourceMappingURL=host-interaction.d.ts.map