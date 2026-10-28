/** V2 boundary: correlate durable step events with session-scoped request hooks. */
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { createHash } from "node:crypto";
import { TraceBuilder } from "./trace-builder.js";
import { safeJson, truncate } from "./attributes.js";
import type { ResolvedConfig } from "./config.js";
import type { UserMessage } from "./types.js";

type Stream = ReturnType<Plugin.Context["event"]["subscribe"]>;
export type PublicEvent = Stream extends AsyncIterable<infer E> ? E : never;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return safeJson(value);
  return value.map((part: unknown) => {
    if (part && typeof part === "object" && "type" in part && part.type === "text" &&
        "text" in part && typeof part.text === "string") return part.text;
    return safeJson(part);
  }).join("\n");
}

export class V2Adapter {
  private turns = new Map<string, UserMessage>();
  private steps = new Map<string, { sessionID: string; model: { id: string; providerID: string }; text: Map<number, string>; streamed?: number }>();

  constructor(private builder: TraceBuilder, private config: ResolvedConfig) {}

  onUser(sessionID: string, message: { id: string; text: string; time: { created: number } }): void {
    if (this.turns.get(sessionID)?.id === message.id) return;
    const user: UserMessage = { id: message.id, sessionID, role: "user", time: message.time,
      agent: "", model: { modelID: "", providerID: "" } };
    this.turns.set(sessionID, user);
    this.builder.onChatMessage({ sessionID, messageID: message.id }, { message: user,
      parts: [{ id: message.id, sessionID, messageID: message.id, type: "text", text: message.text }] });
  }

  onContext(event: SessionContext): void {
    let turn = this.turns.get(event.sessionID);
    if (!turn) {
      // A resumed session or subagent need not pass through this runtime's prompt hook.
      turn = { id: `resume:${event.sessionID}`, sessionID: event.sessionID, role: "user",
        time: { created: Date.now() }, agent: event.agent,
        model: { modelID: event.model.id, providerID: event.model.providerID } };
      this.turns.set(event.sessionID, turn);
      this.builder.onChatMessage({ sessionID: event.sessionID, agent: event.agent }, { message: turn, parts: [] });
    }
    const messages = [
      ...event.system.map((part) => ({ role: "system", content: truncate(contentText([part]), this.config.maxAttrChars) })),
      ...event.messages.map((message) => ({ role: message.role, content: truncate(contentText(message.content), this.config.maxAttrChars) })),
    ];
    this.builder.onRequestContext(event.sessionID, messages);
    const span = this.builder.onChatParams({
      sessionID: event.sessionID, agent: event.agent, message: turn,
      model: { modelID: event.model.id }, provider: { info: { id: event.model.providerID } },
    }, { ...event.options, maxOutputTokens: event.options.maxTokens });
    if (this.config.captureContent && !this.config.hideInputs && !this.config.hideInputMessages) {
      const segments = messages.map((message, ord) => ({
        ord, source_kind: message.role, source_name: `${message.role}[${ord}]`,
        char_len: message.content.length, sha256: hash(message.content),
        token_est: Math.ceil(message.content.length / 4), is_static: false,
      }));
      span.setAttribute("prompt.segments", safeJson(segments));
      const prefix = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
      span.setAttribute("prompt.static_prefix.sha256", hash(prefix));
      span.setAttribute("prompt.static_prefix.tokens", Math.ceil(prefix.length / 4));
      span.setAttribute("llm.tools.definitions", safeJson(Object.entries(event.tools).map(([name, tool]) => ({
        name, description: tool.description, schema: tool.input,
      }))));
    }
  }

  onEvent(event: PublicEvent): void {
    switch (event.type) {
      case "session.step.started": {
        this.steps.set(event.data.assistantMessageID, { sessionID: event.data.sessionID, model: event.data.model, text: new Map() });
        break;
      }
      case "session.step.streamed": {
        const step = this.steps.get(event.data.assistantMessageID);
        if (step) step.streamed = event.created;
        break;
      }
      case "session.text.ended": {
        this.steps.get(event.data.assistantMessageID)?.text.set(event.data.ordinal, event.data.text);
        break;
      }
      case "session.step.ended":
      case "session.step.failed": {
        const data = event.data;
        const step = this.steps.get(data.assistantMessageID);
        if (!step) break;
        const turn = this.turns.get(data.sessionID);
        if (!turn) break;
        const usage = data.tokens;
        const text = [...step.text].sort(([a], [b]) => a - b).map(([, value]) => value).join("\n");
        this.builder.onMessagePartUpdated({ id: data.assistantMessageID, type: "text", sessionID: data.sessionID, messageID: data.assistantMessageID, text });
        this.builder.onMessageUpdated({
          id: data.assistantMessageID, sessionID: data.sessionID, parentID: turn.id,
          role: "assistant", mode: turn.agent, modelID: step.model.id, providerID: step.model.providerID,
          time: { created: turn.time.created, completed: step.streamed ?? event.created },
          // V2 input excludes cached tokens; OpenInference prompt includes them.
          tokens: usage ? { ...usage, input: usage.input + usage.cache.read + usage.cache.write }
            : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: data.cost ?? 0, finish: data.finish ?? "error",
          error: event.type === "session.step.failed" ? event.data.error : undefined,
        });
        this.steps.delete(data.assistantMessageID);
        break;
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.deleted": {
        this.builder.endSession(event.data.sessionID,
          event.type === "session.execution.failed" || event.type === "session.execution.interrupted", true);
        this.turns.delete(event.data.sessionID);
        for (const [id, step] of this.steps) if (step.sessionID === event.data.sessionID) this.steps.delete(id);
        break;
      }
    }
  }
}
