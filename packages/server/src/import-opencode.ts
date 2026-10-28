import { createHash } from "crypto";
import type { Store } from "@agent-profiler/store";
import type { LlmCallRecord, TurnRecord } from "@agent-profiler/schema";

type Usage = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
type Message = {
  id: string; type: string; text?: string; summary?: string; status?: string;
  time: { created: number; streamed?: number; completed?: number };
  model?: { id: string; providerID: string }; tokens?: Usage; cost?: number;
  finish?: string; error?: unknown; content?: Array<Record<string, any>>;
};
type Export = { info: { id: string; title?: string; time: { created: number; updated: number }; location?: { directory?: string }; agent?: string }; messages: Message[] };
const iso = (time: number) => new Date(time).toISOString();
const metrics = ["promptTokens", "completionTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"];
const identity = (session: string, id: string) => `opencode:${session}:${id}`;

/** Validate the envelope before any writes; exports are data, never executable input. */
export function validateExport(value: unknown): asserts value is Export {
  const data = value as Export;
  if (!data?.info?.id?.startsWith("ses_") || !Number.isFinite(data.info.time?.created) || !Array.isArray(data.messages)) throw new Error("Invalid OpenCode V2 export");
  if (data.info.title != null && typeof data.info.title !== "string") throw new Error("Invalid session title");
  const ids = new Set<string>();
  const toolIds = new Set<string>();
  for (const m of data.messages) {
    if (typeof m.id !== "string" || !m.id || ids.has(m.id) || !Number.isFinite(m.time?.created) || typeof m.type !== "string") throw new Error("Invalid or duplicate OpenCode message");
    ids.add(m.id);
    if (m.tokens && ![m.tokens.input, m.tokens.output, m.tokens.reasoning, m.tokens.cache?.read, m.tokens.cache?.write].every(v => Number.isFinite(v) && v >= 0)) throw new Error("Invalid recorded token usage");
    if (m.cost != null && (!Number.isFinite(m.cost) || m.cost < 0)) throw new Error("Invalid recorded cost");
    if (m.content != null && !Array.isArray(m.content)) throw new Error("Invalid message content");
    for (const tool of (m.content ?? []).filter(c => c?.type === "tool")) {
      if (typeof tool.id !== "string" || !tool.id || toolIds.has(tool.id) || typeof tool.name !== "string" ||
          !Number.isFinite(tool.time?.created) || !["streaming", "running", "completed", "error"].includes(tool.state?.status)) throw new Error("Invalid recorded tool");
      toolIds.add(tool.id);
      if (tool.time.completed != null) iso(tool.time.completed);
    }
    if (m.time.completed != null) iso(m.time.completed);
    if (m.time.streamed != null) iso(m.time.streamed);
    iso(m.time.created);
  }
  iso(data.info.time.created);
}

export function importOpenCodeExport(data: Export, store: Store): { sessionId: string; skipped?: string } {
  const sessionId = data.info.id;
  const previous = store.getSession(sessionId);
  const existingCalls = new Map(store.listLlmCallsBySession(sessionId).map(c => [c.id, c]));
  const existingTools = new Map(store.listToolCallsBySession(sessionId).map(c => [c.id, c]));
  // Old collectors discarded source identities. Guessing from text/tokens can
  // silently merge distinct requests, so refuse ambiguous overlap explicitly.
  if ([...existingCalls.values()].some(c => !c.id.startsWith(`opencode:${sessionId}:`)) ||
      [...existingTools.values()].some(c => !c.id.startsWith(`opencode:${sessionId}:`))) {
    // Session metadata is safe to refresh even when usage cannot be merged.
    if (previous && data.info.title != null) store.upsertSession({ ...previous, title: data.info.title });
    return { sessionId, skipped: "existing live records lack OpenCode message/tool IDs; cannot deduplicate safely" };
  }
  const blob = (value: unknown, mime = "application/json") => {
    const bytes = typeof value === "string" ? value : JSON.stringify(value);
    const ref = createHash("sha256").update(bytes).digest("hex");
    store.putBlob(ref, mime, bytes);
    return ref;
  };
  const imported = { source: "opencode-import", partial: true, promptComposition: "unavailable", toolSchemas: "unavailable" };
  const transaction = store.db.transaction(() => {
    store.upsertSession({ ...(previous ?? { id: sessionId, harness: "opencode", agent: data.info.agent, project: data.info.location?.directory,
      startedAt: iso(data.info.time.created), turnCount: 0, llmCallCount: 0, toolCallCount: 0,
      promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costTotal: 0 }), title: data.info.title ?? previous?.title });
    // Preserve a lossless source snapshot; it is not an outgoing model prompt.
    const sourceRef = blob(data);
    let current: TurnRecord | undefined;
    let index = 0;
    const touched = new Set<string>();
    const associationConflicts = new Set((store.getCapture(sessionId)?.associationConflicts ?? []) as string[]);
    const makeTurn = (id: string, created: number, text?: string): TurnRecord => ({ id: identity(sessionId, id), sessionId, idx: index++, userText: text,
      startedAt: iso(created), llmRoundTrips: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 });
    for (const message of data.messages) {
      if (message.type === "user") {
        current = makeTurn(message.id, message.time.created, message.text);
        const existing = store.getTurn(current.id);
        store.upsertTurn(existing ? { ...existing, idx: current.idx, userText: current.userText,
          assistantText: undefined } : current);
        touched.add(current.id);
        continue;
      }
      if (message.type !== "assistant" && !(message.type === "compaction" && message.status === "completed")) continue;
      if (!current) { current = makeTurn(`unattributed:${message.id}`, message.time.created); store.upsertTurn(current); touched.add(current.id); }
      const id = identity(sessionId, message.id);
      const existing = existingCalls.get(id);
      const t = message.tokens;
      const text = message.summary ?? (message.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
      const call: LlmCallRecord = { id, turnId: current.id, sessionId, model: message.model?.id ?? "unknown", provider: message.model?.providerID,
        promptTokens: t ? t.input + t.cache.read + t.cache.write : 0, completionTokens: t?.output ?? 0, reasoningTokens: t?.reasoning ?? 0,
        cacheReadTokens: t?.cache.read ?? 0, cacheWriteTokens: t?.cache.write ?? 0, cost: message.cost ?? 0,
        latencyMs: Math.max(0, (message.time.streamed ?? message.time.completed ?? message.time.created) - message.time.created),
        finishReason: message.finish, outputRef: blob([{ message: { role: "assistant", content: text } }]) };
      const unknownMetrics = [...(!t ? metrics : []), ...(message.cost == null ? ["cost"] : []), ...(message.time.streamed == null && message.time.completed == null ? ["latencyMs"] : [])];
      if (existing && store.getCapture(id)?.source === "live") {
        // Keep live prompt/output evidence, but fill metrics missing at capture.
        const missing = (store.getCapture(id)?.unknownMetrics ?? []) as string[];
        const merged = { ...existing, turnId: current.id,
          model: existing.model === "unknown" ? call.model : existing.model,
          provider: existing.provider ?? call.provider,
          finishReason: existing.finishReason ?? call.finishReason,
          outputRef: existing.outputRef ?? call.outputRef };
        if (existing.turnId !== current.id) {
          touched.add(existing.turnId);
          if (store.getTurn(existing.turnId)) associationConflicts.add(existing.turnId);
        }
        for (const key of missing) {
          if (!unknownMetrics.includes(key)) (merged as unknown as Record<string, unknown>)[key] = (call as unknown as Record<string, unknown>)[key];
        }
        store.upsertLlmCall(merged);
        store.setCapture(id, { ...store.getCapture(id), backfilled: true, sourceMessageId: message.id,
          parentResolution: existing.turnId !== current.id ? { from: existing.turnId, to: current.id, basis: "exact OpenCode message ID" } : store.getCapture(id)?.parentResolution,
          unknownMetrics: missing.filter(k => unknownMetrics.includes(k)) });
      } else {
        store.upsertLlmCall(call);
        store.setCapture(id, { ...imported, sourceMessageId: message.id, unknownMetrics });
      }
      for (const tool of (message.content ?? []).filter(c => c.type === "tool")) {
        const toolId = identity(sessionId, tool.id);
        const existingTool = existingTools.get(toolId);
        if (existingTool && store.getCapture(toolId)?.source !== "opencode-import") {
          if (existingTool.turnId !== current.id) {
            touched.add(existingTool.turnId);
            if (store.getTurn(existingTool.turnId)) associationConflicts.add(existingTool.turnId);
          }
          store.upsertToolCall({ ...existingTool, turnId: current.id });
          store.setCapture(toolId, { ...store.getCapture(toolId), backfilled: true, sourceToolId: tool.id });
          continue;
        }
        const state = tool.state;
        const output = state.content ? JSON.stringify(state.content) : state.error ? JSON.stringify(state.error) : undefined;
        store.upsertToolCall({ id: toolId, turnId: current.id, sessionId, name: tool.name, kind: "other",
          argsRef: state.input ? blob(state.input) : undefined, outputRef: output ? blob(output, "application/json") : undefined,
          latencyMs: tool.time.completed != null ? Math.max(0, tool.time.completed - (tool.time.ran ?? tool.time.created)) : 0,
          tokensOutEst: output ? Math.ceil(output.length / 4) : 0, status: state.status === "error" ? "ERROR" : state.status === "completed" ? "OK" : state.status });
        store.setCapture(toolId, { ...imported, sourceToolId: tool.id, unknownMetrics: tool.time.completed == null ? ["latencyMs"] : [] });
      }
      const turn = store.getTurn(current.id)!;
      store.upsertTurn({ ...turn, assistantText: [turn.assistantText, text].filter(Boolean).join("\n"), endedAt: message.time.completed ? iso(message.time.completed) : turn.endedAt,
        endSignal: message.error ? "error" : message.finish === "stop" && message.time.completed ? "completed" : turn.endSignal });
    }
    const sum = (calls: LlmCallRecord[], key: keyof LlmCallRecord) => calls.reduce((n, c) => n + Number(c[key] ?? 0), 0);
    for (const id of touched) {
      const calls = store.listLlmCalls(id);
      const turn = store.getTurn(id);
      if (!turn) continue;
      store.upsertTurn({ ...turn, llmRoundTrips: calls.length, promptTokens: sum(calls, "promptTokens"), completionTokens: sum(calls, "completionTokens"), reasoningTokens: sum(calls, "reasoningTokens"), cacheReadTokens: sum(calls, "cacheReadTokens"), cacheWriteTokens: sum(calls, "cacheWriteTokens"), cost: sum(calls, "cost") });
      store.setCapture(id, { ...(store.getCapture(id)?.source === "live" ? { ...store.getCapture(id), backfilled: true } : imported), unknownMetrics: [...new Set(calls.flatMap(c => (store.getCapture(c.id)?.unknownMetrics ?? []) as string[]))].filter(k => k !== "latencyMs") });
    }
    const calls = store.listLlmCallsBySession(sessionId);
    store.upsertSession({ ...store.getSession(sessionId)!, turnCount: store.listTurns(sessionId).length, llmCallCount: calls.length, toolCallCount: store.listToolCallsBySession(sessionId).length,
      model: calls[0]?.model, promptTokens: sum(calls, "promptTokens"), completionTokens: sum(calls, "completionTokens"), reasoningTokens: sum(calls, "reasoningTokens"), cacheReadTokens: sum(calls, "cacheReadTokens"), cacheWriteTokens: sum(calls, "cacheWriteTokens"), costTotal: sum(calls, "cost") });
    store.setCapture(sessionId, { ...store.getCapture(sessionId), ...imported, sourceRef, associationConflicts: [...associationConflicts], unknownMetrics: [...new Set(calls.flatMap(c => (store.getCapture(c.id)?.unknownMetrics ?? []) as string[]))].filter(k => k !== "latencyMs").map(k => k === "cost" ? "costTotal" : k) });
  });
  transaction();
  return { sessionId };
}
