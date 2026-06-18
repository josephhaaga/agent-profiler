/**
 * TraceBuilder: the correlation state machine. Content and metrics for one
 * logical LLM call arrive across several hooks that fire at different times and
 * do not all carry the same key. This class buffers and correlates them into a
 * session → turn → (LLM | tool) span tree. See DESIGN.md §6.2.
 *
 * Threading model: OpenCode hooks are discrete async callbacks on a single
 * session that runs largely sequentially (one model call in flight at a time).
 * We therefore keep per-session state and use a FIFO of open LLM spans, closing
 * the oldest on each terminal `message.updated`.
 */
import { type Span, type Tracer } from "@opentelemetry/api";
import { SemanticConventions } from "@arizeai/openinference-semantic-conventions";
import type { ResolvedConfig } from "./config.js";
import type {
  AssistantMessage,
  Message,
  Part,
  UserMessage,
} from "./types.js";
import { openSessionSpan, closeSessionSpan } from "./spans/session.js";
import { openTurnSpan, closeTurnSpan } from "./spans/turn.js";
import {
  openLlmSpan,
  setLlmInputMessages,
  closeLlmSpan,
} from "./spans/llm.js";
import { openToolSpan, closeToolSpan } from "./spans/tool.js";
import {
  partsToMessage,
  systemMessages,
  buildInputMessages,
  type OIMessage,
} from "./messages.js";

interface OpenLlm {
  span: Span;
  createdAt: number;
  /** Buffered input messages awaiting attachment (set at open). */
}

interface OpenTool {
  span: Span;
  identity: ReturnType<typeof openToolSpan>["identity"];
  createdAt: number;
}

interface TurnState {
  span: Span;
  messageID: string;
  createdAt: number;
  /** callIDs currently mid-flight under this turn. */
  pendingTools: Set<string>;
  finalText?: string;
}

interface SessionState {
  span: Span;
  createdAt: number;
  agent?: string;
  /** Turn keyed by the user messageID (== assistant.parentID). */
  turns: Map<string, TurnState>;
  /** Most recently opened turn (fallback when parentID unknown). */
  lastTurn?: TurnState;
  /**
   * Open LLM spans keyed by the user messageID that triggered them
   * (== input.message.id in chat.params == assistant.parentID in message.updated).
   * This replaces the FIFO queue which assumed chat.params fires before
   * message.updated — that ordering is not guaranteed in opencode ≥1.17.
   */
  llmMap: Map<string, OpenLlm>;
  /** Fallback FIFO for cases where the message ID is unavailable. */
  llmQueue: OpenLlm[];
  /** Open tool spans keyed by callID. */
  tools: Map<string, OpenTool>;
  /** Buffered pre-request context for the next LLM span. */
  pendingSystem?: string[];
  pendingMessages?: { info: Message; parts: Part[] }[];
  /** Accumulated assistant text keyed by assistant messageID. */
  assistantText: Map<string, string>;
  /**
   * Set to true when endSession was called while llmMap/llmQueue were
   * non-empty. The session stays alive until both drain, then auto-closes.
   */
  draining?: boolean;
  drainingErrored?: boolean;
}

export class TraceBuilder {
  private readonly tracer: Tracer;
  private readonly config: ResolvedConfig;
  private readonly sessions = new Map<string, SessionState>();
  private mcpServers: ReadonlySet<string> | undefined;
  private userId: string | undefined;

  constructor(opts: {
    tracer: Tracer;
    config: ResolvedConfig;
    mcpServers?: ReadonlySet<string>;
    userId?: string;
  }) {
    this.tracer = opts.tracer;
    this.config = opts.config;
    this.mcpServers = opts.mcpServers;
    this.userId = opts.userId;
  }

  setMcpServers(servers: ReadonlySet<string>): void {
    this.mcpServers = servers;
  }

  /** Set the user id used on session spans (resolved lazily at startup). */
  setUserId(userId: string | undefined): void {
    if (userId) this.userId = userId;
  }

  // ---- session lifecycle -------------------------------------------------

  private ensureSession(sessionID: string, agent?: string): SessionState {
    let s = this.sessions.get(sessionID);
    if (!s) {
      const span = openSessionSpan({
        tracer: this.tracer,
        sessionID,
        agent,
        userId: this.userId,
        config: this.config,
      });
      s = {
        span,
        createdAt: Date.now(),
        agent,
        turns: new Map(),
        llmMap: new Map(),
        llmQueue: [],
        tools: new Map(),
        assistantText: new Map(),
        draining: false,
        drainingErrored: false,
      };
      this.sessions.set(sessionID, s);
    } else if (agent && !s.agent) {
      s.agent = agent;
      // Retroactively set the attribute on the already-open session span.
      s.span.setAttribute(SemanticConventions.AGENT_NAME, agent);
    }
    return s;
  }

  endSession(sessionID: string, errored = false): void {
    const s = this.sessions.get(sessionID);
    if (!s) return;
    // If there are LLM spans still awaiting their message.updated token data,
    // mark the session as draining rather than force-closing it. The session
    // will be cleaned up by onMessageUpdated once the map empties.
    if (s.llmMap.size > 0 || s.llmQueue.length > 0) {
      s.draining = true;
      s.drainingErrored = errored;
      return;
    }
    this._closeSession(s, sessionID, errored);
  }

  private _closeSession(s: SessionState, sessionID: string, errored: boolean): void {
    // Force-close anything still open under this session.
    for (const t of s.tools.values()) {
      closeToolSpan(t.span, { identity: t.identity, errored: true, config: this.config });
    }
    s.tools.clear();
    for (const l of s.llmMap.values()) {
      l.span.end();
    }
    s.llmMap.clear();
    for (const l of s.llmQueue) {
      l.span.end();
    }
    s.llmQueue = [];
    for (const turn of s.turns.values()) {
      closeTurnSpan(turn.span, { outputText: turn.finalText, errored, config: this.config });
    }
    s.turns.clear();
    closeSessionSpan(s.span, errored);
    this.sessions.delete(sessionID);
  }

  // ---- turn lifecycle ----------------------------------------------------

  /** chat.message → a new user message starts a turn. */
  onChatMessage(input: {
    sessionID: string;
    messageID?: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
  }, output: { message: UserMessage; parts: Part[] }): void {
    const session = this.ensureSession(input.sessionID, input.agent);
    const messageID = input.messageID ?? output.message?.id;
    if (!messageID) return;
    if (session.turns.has(messageID)) return;

    if (!this.config.emitTurnSpans) {
      // No turn layer: record nothing; LLM/tool spans parent to session.
      return;
    }

    const promptText = this.config.captureContent
      ? partsToMessage("user", output.parts ?? [], {
          maxAttrChars: this.config.maxAttrChars,
          captureContent: this.config.captureContent,
        }).content
      : undefined;

    const span = openTurnSpan({
      tracer: this.tracer,
      parent: session.span,
      sessionID: input.sessionID,
      messageID,
      agent: input.agent ?? session.agent,
      model: input.model?.modelID,
      promptText,
      config: this.config,
    });
    const turn: TurnState = {
      span,
      messageID,
      createdAt: Date.now(),
      pendingTools: new Set(),
    };
    session.turns.set(messageID, turn);
    session.lastTurn = turn;
  }

  /** The parent span for children of a turn (turn span, or session if disabled). */
  private parentForTurn(session: SessionState, turnMessageID?: string): Span {
    if (!this.config.emitTurnSpans) return session.span;
    if (turnMessageID) {
      const t = session.turns.get(turnMessageID);
      if (t) return t.span;
    }
    return session.lastTurn?.span ?? session.span;
  }

  // ---- pre-request buffering --------------------------------------------

  onSystemTransform(sessionID: string | undefined, system: string[]): void {
    if (!sessionID) {
      // No session id: stash on most-recently-touched session as a fallback.
      const last = this.lastSession();
      if (last) last.pendingSystem = system;
      return;
    }
    const s = this.ensureSession(sessionID);
    s.pendingSystem = system;
  }

  onMessagesTransform(entries: { info: Message; parts: Part[] }[]): void {
    // This hook carries no sessionID; attach to the most-recent session.
    const s = this.lastSession();
    if (s) s.pendingMessages = entries;
  }

  // ---- LLM lifecycle -----------------------------------------------------

  /** chat.params → request start: open the LLM span (accurate latency start). */
  onChatParams(input: {
    sessionID: string;
    agent: string;
    model: { modelID: string; [k: string]: unknown };
    provider: { info: { id: string } };
    message: UserMessage;
  }, output: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    options?: Record<string, unknown>;
  }): void {
    const session = this.ensureSession(input.sessionID, input.agent);
    const turnMessageID = input.message?.id;
    const parent = this.parentForTurn(session, turnMessageID);

    const invocationParams: Record<string, unknown> = {
      temperature: output.temperature,
      top_p: output.topP,
      top_k: output.topK,
      max_output_tokens: output.maxOutputTokens,
      ...(output.options ?? {}),
    };

    const span = openLlmSpan({
      tracer: this.tracer,
      parent,
      sessionID: input.sessionID,
      modelID: input.model.modelID,
      providerID: input.provider?.info?.id ?? "",
      invocationParams,
      config: this.config,
    });

    // Attach buffered input messages (prefer the transform array).
    const messages = this.assembleInputMessages(session);
    if (messages.length > 0) setLlmInputMessages(span, messages, this.config);

    // Consume the buffers.
    session.pendingSystem = undefined;
    session.pendingMessages = undefined;

    // Key by the user message ID so onMessageUpdated can look it up by
    // assistant.parentID without relying on FIFO ordering.
    const llmEntry = { span, createdAt: Date.now() };
    if (turnMessageID) {
      session.llmMap.set(turnMessageID, llmEntry);
    } else {
      session.llmQueue.push(llmEntry);
    }
  }

  private assembleInputMessages(session: SessionState): OIMessage[] {
    const opts = {
      maxAttrChars: this.config.maxAttrChars,
      captureContent: this.config.captureContent,
    };
    const sys = session.pendingSystem ? systemMessages(session.pendingSystem, opts) : [];
    if (session.pendingMessages && session.pendingMessages.length > 0) {
      return [...sys, ...buildInputMessages(session.pendingMessages, opts)];
    }
    return sys;
  }

  /**
   * message.part.updated → accumulate assistant text so we can attach it to the
   * LLM output_messages and the turn output. The AssistantMessage in
   * message.updated does not carry text parts; they arrive as separate parts.
   */
  onMessagePartUpdated(part: Part): void {
    if (!part || part.type !== "text") return;
    const tp = part as { sessionID?: string; messageID?: string; text?: string; synthetic?: boolean };
    if (tp.synthetic || !tp.sessionID || !tp.messageID || !tp.text) return;
    const session = this.sessions.get(tp.sessionID);
    if (!session) return;
    // Text parts stream as growing snapshots; keep the latest (longest) value.
    const prev = session.assistantText.get(tp.messageID) ?? "";
    if (tp.text.length >= prev.length) session.assistantText.set(tp.messageID, tp.text);
  }

  /** message.updated → finalize the matching LLM span + turn output. */
  onMessageUpdated(message: Message): void {
    if (message.role !== "assistant") return;
    const assistant = message as AssistantMessage;
    // Only finalize on a terminal update (tokens present or finish set).
    const terminal = Boolean(assistant.finish) || hasTokens(assistant);
    if (!terminal) return;

    const session = this.sessions.get(assistant.sessionID);
    if (!session) return;

    const assistantText = session.assistantText.get(assistant.id);

    // Look up the open LLM span by parentID (the user message that triggered
    // this LLM call). Fall back to FIFO for spans opened without a message ID.
    const open =
      session.llmMap.get(assistant.parentID) ??
      session.llmQueue.shift();
    if (open) {
      session.llmMap.delete(assistant.parentID);
      const outputMessage: OIMessage = {
        role: "assistant",
        content: assistantText,
      };
      closeLlmSpan(open.span, { assistant, outputMessage, config: this.config });
    }

    // Update the turn's final text + maybe close the turn.
    const turn = session.turns.get(assistant.parentID) ?? session.lastTurn;
    if (turn) {
      if (assistantText) turn.finalText = assistantText;
      // A turn is "done" when its terminal assistant message arrives and no
      // tools remain mid-flight. Tool-use loops emit multiple assistant
      // messages; we only close when nothing is pending.
      if (turn.pendingTools.size === 0 && session.llmMap.size === 0 && session.llmQueue.length === 0) {
        closeTurnSpan(turn.span, {
          outputText: turn.finalText,
          errored: Boolean(assistant.error),
          config: this.config,
        });
        session.turns.delete(turn.messageID);
        if (session.lastTurn === turn) session.lastTurn = undefined;
      }
    }

    // If the session was waiting to drain before closing, do so now.
    if (session.draining && session.llmMap.size === 0 && session.llmQueue.length === 0) {
      this._closeSession(session, assistant.sessionID, session.drainingErrored ?? false);
    }
  }

  // ---- tool lifecycle ----------------------------------------------------

  onToolBefore(input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }): void {
    const session = this.ensureSession(input.sessionID);
    const turn = session.lastTurn;
    const parent = this.parentForTurn(session, turn?.messageID);

    const { span, identity } = openToolSpan({
      tracer: this.tracer,
      parent,
      sessionID: input.sessionID,
      tool: input.tool,
      callID: input.callID,
      args: output?.args,
      mcpServers: this.mcpServers,
      config: this.config,
    });
    session.tools.set(input.callID, { span, identity, createdAt: Date.now() });
    if (turn) turn.pendingTools.add(input.callID);
  }

  onToolAfter(
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title?: string; output?: string; metadata?: unknown },
  ): void {
    const session = this.sessions.get(input.sessionID);
    if (!session) return;
    const open = session.tools.get(input.callID);
    if (!open) return;

    closeToolSpan(open.span, {
      identity: open.identity,
      output: output?.output,
      metadata: output?.metadata,
      errored: false,
      config: this.config,
    });
    session.tools.delete(input.callID);

    // Clear from whichever turn was tracking it.
    for (const turn of session.turns.values()) {
      if (turn.pendingTools.delete(input.callID)) break;
    }
  }

  // ---- leak sweeper ------------------------------------------------------

  /** Force-close spans older than maxSpanAgeMs (missed terminal hooks). */
  sweep(now = Date.now()): void {
    const maxAge = this.config.maxSpanAgeMs;
    for (const [sessionID, s] of this.sessions) {
      for (const [callID, t] of s.tools) {
        if (now - t.createdAt > maxAge) {
          t.span.setAttribute("opencode.timeout", true);
          closeToolSpan(t.span, { identity: t.identity, errored: false, config: this.config });
          s.tools.delete(callID);
          // Release the pending reference so the parent turn can close too.
          for (const turn of s.turns.values()) {
            if (turn.pendingTools.delete(callID)) break;
          }
        }
      }
      s.llmQueue = s.llmQueue.filter((l) => {
        if (now - l.createdAt > maxAge) {
          l.span.setAttribute("opencode.timeout", true);
          l.span.end();
          return false;
        }
        return true;
      });
      for (const [mid, l] of s.llmMap) {
        if (now - l.createdAt > maxAge) {
          l.span.setAttribute("opencode.timeout", true);
          l.span.end();
          s.llmMap.delete(mid);
        }
      }
      for (const [mid, turn] of s.turns) {
        if (now - turn.createdAt > maxAge && turn.pendingTools.size === 0) {
          turn.span.setAttribute("opencode.timeout", true);
          closeTurnSpan(turn.span, { outputText: turn.finalText, config: this.config });
          s.turns.delete(mid);
        }
      }
      // Session itself: only sweep if very old AND nothing pending.
      if (
        now - s.createdAt > maxAge &&
        s.tools.size === 0 &&
        s.llmMap.size === 0 &&
        s.llmQueue.length === 0 &&
        s.turns.size === 0
      ) {
        s.span.setAttribute("opencode.timeout", true);
        closeSessionSpan(s.span, false);
        this.sessions.delete(sessionID);
      }
    }
  }

  /** Close everything (used on dispose). */
  closeAll(): void {
    for (const sessionID of [...this.sessions.keys()]) {
      this.endSession(sessionID, false);
    }
  }

  private lastSession(): SessionState | undefined {
    let last: SessionState | undefined;
    for (const s of this.sessions.values()) {
      if (!last || s.createdAt >= last.createdAt) last = s;
    }
    return last;
  }

  /** Test/introspection helper. */
  get openSessionCount(): number {
    return this.sessions.size;
  }
}

function hasTokens(a: AssistantMessage): boolean {
  const t = a.tokens;
  if (!t) return false;
  return (t.input ?? 0) > 0 || (t.output ?? 0) > 0;
}
