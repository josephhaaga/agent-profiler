/**
 * OTLP/HTTP trace ingest for harness-profiler.
 *
 * Accepts both OTLP JSON (`application/json`) and OTLP proto-JSON
 * (`application/x-protobuf` arrives as JSON after the collector decodes it).
 *
 * OpenInference span attributes we care about:
 *   session.id, agent.name, user.id
 *   openinference.span.kind  ("CHAIN" | "LLM" | "TOOL")
 *   input.value, output.value
 *   metadata (JSON string containing messageID, agent, model)
 *   llm.model_name, llm.provider, llm.invocation_parameters
 *   llm.token_count.prompt, .completion, .total
 *   llm.token_count.completion_details.reasoning
 *   llm.token_count.prompt_details.cache_read
 *   llm.token_count.prompt_details.cache_write
 *   llm.cost.total
 *   llm.input_messages  (JSON array)
 *   llm.output_messages (JSON array)
 *   tool.name, tool.id, tag.tags
 *
 * Extended harness-profiler schema (§4.1 of PLAN.md):
 *   prompt.segments        (JSON array)
 *   llm.tools.definitions  (JSON)
 *   prompt.static_prefix.sha256
 *   prompt.static_prefix.tokens
 */

import type {
  HarnessKind,
  LlmCallRecord,
  PromptSegmentRecord,
  SessionRecord,
  ToolCallRecord,
  ToolDefRecord,
  TurnRecord,
} from "@agent-profiler/schema";
import type { Store } from "@agent-profiler/store";

// ── Raw OTLP JSON types (minimal subset we read) ─────────────────────────────

interface OtlpKeyValue {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string | number }
    | { doubleValue: number }
    | { boolValue: boolean }
    | { arrayValue: { values: OtlpKeyValue["value"][] } }
    | { kvlistValue: { values: OtlpKeyValue[] } };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes?: OtlpKeyValue[];
  status?: { code?: number; message?: string };
}

interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: Array<{
    spans?: OtlpSpan[];
  }>;
}

export interface OtlpExportRequest {
  resourceSpans?: OtlpResourceSpans[];
}

// ── Attribute helpers ─────────────────────────────────────────────────────────

function attrMap(attrs: OtlpKeyValue[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of attrs) {
    out[kv.key] = resolveValue(kv.value);
  }
  return out;
}

function resolveValue(v: OtlpKeyValue["value"]): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) return v.arrayValue.values.map(resolveValue);
  if ("kvlistValue" in v) return attrMap(v.kvlistValue.values);
  return null;
}

function str(attrs: Record<string, unknown>, key: string): string | undefined {
  const v = attrs[key];
  return typeof v === "string" ? v : undefined;
}

function num(attrs: Record<string, unknown>, key: string): number {
  const v = attrs[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function nanoToMs(nano: string | undefined): number {
  if (!nano) return 0;
  return Math.round(Number(BigInt(nano) / 1_000_000n));
}

function nanoToIso(nano: string | undefined): string | undefined {
  if (!nano) return undefined;
  return new Date(Number(BigInt(nano) / 1_000_000n)).toISOString();
}

/** Cheap character-count-based token estimate (≈4 chars/token for English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Simple SHA-256 via Web Crypto (available in Bun). */
async function sha256hex(text: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Per-span normalizer ───────────────────────────────────────────────────────

interface NormalizedSpan {
  id: string;
  parentId?: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  latencyMs: number;
  kind: string; // openinference.span.kind lowercased
  attrs: Record<string, unknown>;
}

function normalizeSpan(span: OtlpSpan): NormalizedSpan {
  const attrs = attrMap(span.attributes ?? []);
  const kindRaw = str(attrs, "openinference.span.kind") ?? "";
  return {
    id: span.spanId,
    parentId: span.parentSpanId ?? undefined,
    name: span.name,
    startedAt: nanoToIso(span.startTimeUnixNano) ?? new Date().toISOString(),
    endedAt: nanoToIso(span.endTimeUnixNano),
    latencyMs:
      span.endTimeUnixNano
        ? nanoToMs(span.endTimeUnixNano) - nanoToMs(span.startTimeUnixNano)
        : 0,
    kind: kindRaw.toLowerCase(),
    attrs,
  };
}

// ── Tree builder ──────────────────────────────────────────────────────────────

interface SpanTree {
  span: NormalizedSpan;
  children: SpanTree[];
}

function buildTree(spans: NormalizedSpan[]): SpanTree[] {
  const byId = new Map<string, SpanTree>(
    spans.map((s) => [s.id, { span: s, children: [] }])
  );
  const roots: SpanTree[] = [];
  for (const node of byId.values()) {
    const pid = node.span.parentId;
    if (pid && byId.has(pid)) {
      byId.get(pid)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ── Main ingestion ────────────────────────────────────────────────────────────

export interface IngestResult {
  sessionsUpserted: number;
  turnsUpserted: number;
  llmCallsUpserted: number;
  toolCallsUpserted: number;
}

export async function ingestOtlpPayload(
  payload: OtlpExportRequest,
  store: Store,
  emitter?: (event: { type: string; data: unknown }) => void
): Promise<IngestResult> {
  const result: IngestResult = {
    sessionsUpserted: 0,
    turnsUpserted: 0,
    llmCallsUpserted: 0,
    toolCallsUpserted: 0,
  };

  for (const rs of payload.resourceSpans ?? []) {
    const resourceAttrs = attrMap(rs.resource?.attributes ?? []);
    const harness = (str(resourceAttrs, "harness") ?? "opencode") as HarnessKind;

    // Collect all spans in this resource
    const allSpans: NormalizedSpan[] = [];
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        allSpans.push(normalizeSpan(span));
      }
    }

    if (!allSpans.length) continue;

    const roots = buildTree(allSpans);

    for (const root of roots) {
      const orphanSessionId = str(root.span.attrs, "session.id");
      const isOrphan =
        root.span.parentId !== undefined &&
        orphanSessionId !== undefined &&
        orphanSessionId !== root.span.id;

      if (isOrphan) {
        await processOrphanBatch(root, orphanSessionId!, harness, store, result, emitter);
      } else {
        await processSessionRoot(root, harness, store, result, emitter);
      }
    }
  }

  return result;
}

// ── Session-level processing ──────────────────────────────────────────────────

async function processSessionRoot(
  root: SpanTree,
  harness: HarnessKind,
  store: Store,
  result: IngestResult,
  emitter?: (event: { type: string; data: unknown }) => void
): Promise<void> {
  const span = root.span;
  const attrs = span.attrs;

  // A session is identified by session.id attribute or the span id itself.
  const sessionId = str(attrs, "session.id") ?? span.id;
  const agentName = str(attrs, "agent.name") ?? str(attrs, "metadata.agent");

  // Parse metadata JSON if present
  let meta: Record<string, unknown> = {};
  const metaStr = str(attrs, "metadata");
  if (metaStr) {
    try {
      meta = JSON.parse(metaStr) as Record<string, unknown>;
    } catch {
      // ignore
    }
  }

  const model =
    str(attrs, "llm.model_name") ??
    (typeof meta.model === "string" ? meta.model : undefined);

  // Aggregate tokens/cost from LLM child spans
  const llmChildren = collectAllSpans(root).filter((s) => s.kind === "llm");

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalReasoningTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const llmSpan of llmChildren) {
    totalPromptTokens += num(llmSpan.attrs, "llm.token_count.prompt");
    totalCompletionTokens += num(llmSpan.attrs, "llm.token_count.completion");
    totalReasoningTokens += num(
      llmSpan.attrs,
      "llm.token_count.completion_details.reasoning"
    );
    totalCacheRead += num(
      llmSpan.attrs,
      "llm.token_count.prompt_details.cache_read"
    );
    totalCacheWrite += num(
      llmSpan.attrs,
      "llm.token_count.prompt_details.cache_write"
    );
    totalCost += num(llmSpan.attrs, "llm.cost.total");
  }

  const turnChildren = root.children.filter(
    (c) => c.span.kind === "chain" || c.span.kind === "turn"
  );
  const toolChildren = collectAllSpans(root).filter((s) => s.kind === "tool");

  const session: SessionRecord = {
    id: sessionId,
    harness,
    agent: agentName ?? (typeof meta.agent === "string" ? meta.agent : undefined),
    model,
    project: str(attrs, "project") ?? undefined,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    turnCount: turnChildren.length,
    llmCallCount: llmChildren.length,
    toolCallCount: toolChildren.length,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    reasoningTokens: totalReasoningTokens,
    cacheReadTokens: totalCacheRead,
    cacheWriteTokens: totalCacheWrite,
    costTotal: totalCost,
    endReason: str(attrs, "end_reason"),
  };

  store.upsertSession(session);
  result.sessionsUpserted++;
  emitter?.({ type: "session", data: session });

  // Process children — only CHAIN/turn spans are actual turns; LLM and tool
  // spans can be direct children of the session when emitTurnSpans=false or
  // when they arrived before their turn parent closed.
  let turnIdx = 0;
  for (const child of root.children) {
    const k = child.span.kind;
    if (k === "chain" || k === "turn") {
      await processTurn(child, sessionId, turnIdx++, store, result, emitter);
    } else if (k === "llm") {
      // LLM direct child of session — attach without a turn wrapper
      await processLlmCall(child, sessionId, sessionId, store, result, emitter);
    } else if (k === "tool") {
      await processToolCall(child.span, sessionId, sessionId, store, result, emitter);
    }
  }

  // Re-aggregate from the store so counts reflect everything written above,
  // including LLM/tool spans nested inside turns.
  recomputeSessionTotals(sessionId, store, emitter);
}

// ── Orphan-batch processing ───────────────────────────────────────────────────
// Handles the case where BatchSpanProcessor flushes turn/LLM/tool spans in a
// separate HTTP request from their parent session span. We route them to the
// existing session via session.id rather than creating a ghost session.

async function processOrphanBatch(
  root: SpanTree,
  sessionId: string,
  harness: HarnessKind,
  store: Store,
  result: IngestResult,
  emitter?: (event: { type: string; data: unknown }) => void
): Promise<void> {
  const kind = root.span.kind;

  // Ensure the session exists in the store (may already be there from an
  // earlier batch; if not, create a minimal placeholder so foreign keys work).
  const existing = store.getSession(sessionId);
  if (!existing) {
    const attrs = root.span.attrs;
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(str(attrs, "metadata") ?? "{}") as Record<string, unknown>; } catch { /* */ }
    store.upsertSession({
      id: sessionId,
      harness,
      agent: str(attrs, "agent.name") ?? (typeof meta.agent === "string" ? meta.agent : undefined),
      model: str(attrs, "llm.model_name") ?? (typeof meta.model === "string" ? meta.model : undefined),
      startedAt: root.span.startedAt,
      endedAt: undefined,
      turnCount: 0,
      llmCallCount: 0,
      toolCallCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costTotal: 0,
    });
    result.sessionsUpserted++;
  }

  // Route by span kind: turn → processTurn, LLM/tool → processLlmCall/processToolCall
  if (kind === "chain" || kind === "turn") {
    const idx = store.listTurns(sessionId).length;
    await processTurn(root, sessionId, idx, store, result, emitter);
  } else {
    // Bare LLM or tool span arriving outside a turn — attach directly to session.
    // Use the span id as a synthetic turnId so FK constraints are satisfied.
    const syntheticTurnId = root.span.id;
    for (const child of [root, ...root.children]) {
      if (child.span.kind === "llm") {
        await processLlmCall(child, syntheticTurnId, sessionId, store, result, emitter);
      } else if (child.span.kind === "tool") {
        await processToolCall(child.span, syntheticTurnId, sessionId, store, result, emitter);
      }
    }
  }

  // Re-aggregate the session totals from what's now in the store
  recomputeSessionTotals(sessionId, store, emitter);
}

function recomputeSessionTotals(
  sessionId: string,
  store: Store,
  emitter?: (event: { type: string; data: unknown }) => void
): void {
  const existing = store.getSession(sessionId);
  if (!existing) return;
  const turns = store.listTurns(sessionId);
  const llmCalls = store.listLlmCallsBySession(sessionId);
  const toolCalls = store.listToolCallsBySession(sessionId);
  const updated = {
    ...existing,
    // Fill in model from the first LLM call if not already on the session span.
    model: existing.model ?? llmCalls[0]?.model ?? undefined,
    turnCount: turns.length,
    llmCallCount: llmCalls.length,
    toolCallCount: toolCalls.length,
    promptTokens: llmCalls.reduce((s, c) => s + c.promptTokens, 0),
    completionTokens: llmCalls.reduce((s, c) => s + c.completionTokens, 0),
    reasoningTokens: llmCalls.reduce((s, c) => s + c.reasoningTokens, 0),
    cacheReadTokens: llmCalls.reduce((s, c) => s + c.cacheReadTokens, 0),
    cacheWriteTokens: llmCalls.reduce((s, c) => s + c.cacheWriteTokens, 0),
    costTotal: llmCalls.reduce((s, c) => s + c.cost, 0),
  };
  store.upsertSession(updated);
  emitter?.({ type: "session", data: updated });
}
async function processTurn(
  node: SpanTree,
  sessionId: string,
  idx: number,
  store: Store,
  result: IngestResult,
  emitter?: (event: { type: string; data: unknown }) => void
): Promise<void> {
  const span = node.span;
  const attrs = span.attrs;
  const turnId = span.id;

  const llmChildren = node.children.filter((c) => c.span.kind === "llm");
  const allDescendantLlm = collectAllSpans(node).filter((s) => s.kind === "llm");

  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;

  for (const llm of allDescendantLlm) {
    promptTokens += num(llm.attrs, "llm.token_count.prompt");
    completionTokens += num(llm.attrs, "llm.token_count.completion");
    reasoningTokens += num(llm.attrs, "llm.token_count.completion_details.reasoning");
    cacheRead += num(llm.attrs, "llm.token_count.prompt_details.cache_read");
    cacheWrite += num(llm.attrs, "llm.token_count.prompt_details.cache_write");
    cost += num(llm.attrs, "llm.cost.total");
  }

  // Determine end_signal heuristic
  let endSignal: TurnRecord["endSignal"] = "completed";
  if (str(attrs, "status") === "ERROR") endSignal = "error";
  else if (str(attrs, "end_signal")) {
    endSignal = str(attrs, "end_signal") as TurnRecord["endSignal"];
  }

  const turn: TurnRecord = {
    id: turnId,
    sessionId,
    idx,
    userText: str(attrs, "input.value"),
    assistantText: str(attrs, "output.value"),
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    llmRoundTrips: llmChildren.length,
    promptTokens,
    completionTokens,
    reasoningTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cost,
    status: str(attrs, "status"),
    endSignal,
  };

  store.upsertTurn(turn);
  result.turnsUpserted++;
  emitter?.({ type: "turn", data: turn });

  // Process LLM calls
  for (const llmNode of llmChildren) {
    await processLlmCall(llmNode, turnId, sessionId, store, result, emitter);
  }
  // Also process nested LLM calls (turn may contain another CHAIN layer)
  for (const child of node.children) {
    if (child.span.kind === "chain") {
      for (const llmNode of child.children.filter((c) => c.span.kind === "llm")) {
        await processLlmCall(llmNode, turnId, sessionId, store, result, emitter);
      }
    }
  }

  // Process tool calls
  const allToolDescendants = collectAllSpans(node).filter((s) => s.kind === "tool");
  for (const toolSpan of allToolDescendants) {
    await processToolCall(toolSpan, turnId, sessionId, store, result, emitter);
  }

  // Re-aggregate turn totals from what's actually in the store now.
  recomputeTurnTotals(turnId, sessionId, store, emitter);
}

function recomputeTurnTotals(
  turnId: string,
  sessionId: string,
  store: Store,
  emitter?: (event: { type: string; data: unknown }) => void
): void {
  const existing = store.getTurn(turnId);
  if (!existing) return;
  const llmCalls = store.listLlmCalls(turnId);
  const toolCalls = store.listToolCalls(turnId);
  const updated: TurnRecord = {
    ...existing,
    llmRoundTrips: llmCalls.length,
    promptTokens: llmCalls.reduce((s, c) => s + c.promptTokens, 0),
    completionTokens: llmCalls.reduce((s, c) => s + c.completionTokens, 0),
    reasoningTokens: llmCalls.reduce((s, c) => s + c.reasoningTokens, 0),
    cacheReadTokens: llmCalls.reduce((s, c) => s + c.cacheReadTokens, 0),
    cacheWriteTokens: llmCalls.reduce((s, c) => s + c.cacheWriteTokens, 0),
    cost: llmCalls.reduce((s, c) => s + c.cost, 0),
  };
  store.upsertTurn(updated);
  emitter?.({ type: "turn", data: updated });
}

// ── LLM call processing ───────────────────────────────────────────────────────

async function processLlmCall(
  node: SpanTree,
  turnId: string,
  sessionId: string,
  store: Store,
  result: IngestResult,
  emitter?: (event: { type: string; data: unknown }) => void
): Promise<void> {
  const span = node.span;
  const attrs = span.attrs;

  const inputMessages = str(attrs, "llm.input_messages");
  const outputMessages = str(attrs, "llm.output_messages");

  // Store large blobs by content hash
  let inputRef: string | undefined;
  let outputRef: string | undefined;

  if (inputMessages) {
    inputRef = await sha256hex(inputMessages);
    store.putBlob(inputRef, "application/json", inputMessages);
  }
  if (outputMessages) {
    outputRef = await sha256hex(outputMessages);
    store.putBlob(outputRef, "application/json", outputMessages);
  }

  const llmCall: LlmCallRecord = {
    id: span.id,
    turnId,
    sessionId,
    model:
      str(attrs, "llm.model_name") ??
      str(attrs, "metadata.model") ??
      "unknown",
    provider: str(attrs, "llm.provider"),
    paramsJson: str(attrs, "llm.invocation_parameters"),
    promptTokens: num(attrs, "llm.token_count.prompt"),
    completionTokens: num(attrs, "llm.token_count.completion"),
    reasoningTokens: num(attrs, "llm.token_count.completion_details.reasoning"),
    cacheReadTokens: num(attrs, "llm.token_count.prompt_details.cache_read"),
    cacheWriteTokens: num(attrs, "llm.token_count.prompt_details.cache_write"),
    cost: num(attrs, "llm.cost.total"),
    latencyMs: span.latencyMs,
    finishReason: str(attrs, "llm.finish_reason"),
    inputMessagesRef: inputRef,
    outputRef,
  };

  store.upsertLlmCall(llmCall);
  result.llmCallsUpserted++;
  emitter?.({ type: "llm_call", data: llmCall });

  // Optional enriched-capture: prompt segments (§4.1)
  const segmentsRaw = str(attrs, "prompt.segments");
  if (segmentsRaw) {
    try {
      const segs = JSON.parse(segmentsRaw) as Array<{
        ord: number;
        source_kind: string;
        source_name: string;
        char_len: number;
        sha256: string;
        token_est?: number;
        is_static?: boolean;
        contributed_by?: string;
      }>;
      const records: PromptSegmentRecord[] = segs.map((s) => ({
        llmCallId: span.id,
        ord: s.ord,
        sourceKind: s.source_kind,
        sourceName: s.source_name,
        charLen: s.char_len,
        tokenEst: s.token_est ?? Math.ceil(s.char_len / 4),
        sha256: s.sha256,
        isStatic: s.is_static ?? false,
        contributedBy: s.contributed_by,
      }));
      store.upsertPromptSegments(records);
    } catch {
      // ignore malformed
    }
  } else if (inputMessages) {
    // Degrade: synthesize a single unattributed segment from the system prompt
    try {
      const msgs = JSON.parse(inputMessages) as Array<{
        message?: { role?: string; content?: unknown };
      }>;
      const systemMsg = msgs.find(
        (m) => m?.message?.role === "system"
      );
      if (systemMsg?.message?.content) {
        const text =
          typeof systemMsg.message.content === "string"
            ? systemMsg.message.content
            : JSON.stringify(systemMsg.message.content);
        const hash = await sha256hex(text);
        const seg: PromptSegmentRecord = {
          llmCallId: span.id,
          ord: 0,
          sourceKind: "system",
          sourceName: "system",
          charLen: text.length,
          tokenEst: estimateTokens(text),
          sha256: hash,
          isStatic: false,
        };
        store.upsertPromptSegments([seg]);
      }
    } catch {
      // ignore
    }
  }

  // Optional enriched capture: tool definitions (§4.1)
  const toolDefsRaw = str(attrs, "llm.tools.definitions");
  if (toolDefsRaw) {
    try {
      const defs = JSON.parse(toolDefsRaw) as Array<{
        name: string;
        kind?: string;
        schema?: Record<string, unknown>;
        description?: string;
      }>;
      for (const def of defs) {
        const schemaStr = JSON.stringify(def.schema ?? {});
        const hash = await sha256hex(schemaStr);
        const toolDef: ToolDefRecord = {
          sessionId,
          name: def.name,
          kind: (def.kind as ToolDefRecord["kind"]) ?? "other",
          schemaJson: schemaStr,
          schemaTokensEst: estimateTokens(schemaStr),
          sha256: hash,
        };
        store.upsertToolDef(toolDef);
      }
    } catch {
      // ignore
    }
  }
}

// ── Tool call processing ──────────────────────────────────────────────────────

async function processToolCall(
  span: NormalizedSpan,
  turnId: string,
  sessionId: string,
  store: Store,
  result: IngestResult,
  emitter?: (event: { type: string; data: unknown }) => void
): Promise<void> {
  const attrs = span.attrs;
  const tags = (attrs["tag.tags"] as string[] | undefined) ?? [];

  // Infer tool kind from tags
  let kind: ToolCallRecord["kind"] = "builtin";
  let server: string | undefined;
  let skill: string | undefined;

  for (const tag of tags) {
    if (tag.startsWith("mcp:")) {
      kind = "mcp";
      server = tag.slice(4);
    } else if (tag === "mcp") {
      kind = "mcp";
    } else if (tag.startsWith("skill:")) {
      kind = "skill";
      skill = tag.slice(6);
    } else if (tag === "skill") {
      kind = "skill";
    }
  }

  const argsRaw = str(attrs, "input.value");
  const outputRaw = str(attrs, "output.value");
  let argsRef: string | undefined;
  let outputRef: string | undefined;

  if (argsRaw) {
    argsRef = await sha256hex(argsRaw);
    store.putBlob(argsRef, "application/json", argsRaw);
  }
  if (outputRaw) {
    outputRef = await sha256hex(outputRaw);
    store.putBlob(outputRef, "text/plain", outputRaw);
  }

  const toolCall: ToolCallRecord = {
    id: span.id,
    turnId,
    sessionId,
    name: str(attrs, "tool.name") ?? span.name,
    kind,
    server,
    skill,
    argsRef,
    outputRef,
    latencyMs: span.latencyMs,
    tokensOutEst: outputRaw ? estimateTokens(outputRaw) : 0,
    status: str(attrs, "status"),
  };

  store.upsertToolCall(toolCall);
  result.toolCallsUpserted++;
  emitter?.({ type: "tool_call", data: toolCall });
}

// ── Utility ───────────────────────────────────────────────────────────────────

function collectAllSpans(node: SpanTree): NormalizedSpan[] {
  const result: NormalizedSpan[] = [node.span];
  for (const child of node.children) {
    result.push(...collectAllSpans(child));
  }
  return result;
}
