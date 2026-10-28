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
import { createHash } from "node:crypto";

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
  status?: { code?: number | string; message?: string };
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

/** Malformed client data; callers should return HTTP 400, not retryable 500. */
export class IngestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestValidationError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new IngestValidationError(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new IngestValidationError(`Invalid ${label}`);
  return value;
}

function validateAttributes(value: unknown): void {
  if (value === undefined) return;
  for (const entry of array(value, "attributes")) {
    const kv = object(entry, "attribute");
    if (typeof kv.key !== "string") throw new IngestValidationError("Invalid attribute key");
    validateValue(kv.value);
  }
}

function validateValue(value: unknown): void {
  const v = object(value, "attribute value");
  if (Object.keys(v).length !== 1) throw new IngestValidationError("Attribute values must have one type");
  if ("stringValue" in v && typeof v.stringValue === "string") return;
  if ("boolValue" in v && typeof v.boolValue === "boolean") return;
  if ("doubleValue" in v && typeof v.doubleValue === "number" && Number.isFinite(v.doubleValue)) return;
  if ("intValue" in v && ((typeof v.intValue === "string" && /^[+-]?\d+$/.test(v.intValue)) ||
      (typeof v.intValue === "number" && Number.isFinite(v.intValue) && Number.isInteger(v.intValue)))) return;
  if ("arrayValue" in v) {
    const values = object(v.arrayValue, "array value").values;
    if (values !== undefined) for (const item of array(values, "array values")) validateValue(item);
    return;
  }
  if ("kvlistValue" in v) {
    validateAttributes(object(v.kvlistValue, "key-value list").values);
    return;
  }
  throw new IngestValidationError("Invalid attribute value");
}

function validateTimestamp(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new IngestValidationError(`Invalid ${label}`);
  const nano = BigInt(value);
  if (!Number.isFinite(new Date(Number(nano / 1_000_000n)).getTime())) throw new IngestValidationError(`Out-of-range ${label}`);
  return nano;
}

function validatePayload(payload: unknown): void {
  const request = object(payload, "OTLP request");
  if (request.resourceSpans === undefined) return;
  for (const entry of array(request.resourceSpans, "resourceSpans")) {
    const resource = object(entry, "resource spans");
    if (resource.resource !== undefined) validateAttributes(object(resource.resource, "resource").attributes);
    if (resource.scopeSpans === undefined) continue;
    for (const entry of array(resource.scopeSpans, "scopeSpans")) {
      const scope = object(entry, "scope spans");
      if (scope.spans === undefined) continue;
      for (const entry of array(scope.spans, "spans")) {
        const span = object(entry, "span");
        if (typeof span.spanId !== "string" || !span.spanId || (span.parentSpanId !== undefined && typeof span.parentSpanId !== "string")) {
          throw new IngestValidationError("Invalid span identity");
        }
        const start = validateTimestamp(span.startTimeUnixNano, "startTimeUnixNano");
        if (span.endTimeUnixNano !== undefined && validateTimestamp(span.endTimeUnixNano, "endTimeUnixNano") < start) {
          throw new IngestValidationError("Span ends before it starts");
        }
        validateAttributes(span.attributes);
        if (span.status !== undefined) {
          const status = object(span.status, "span status");
          if ((status.code !== undefined && normalizeStatusCode(status.code as number | string) === undefined) ||
              (status.message !== undefined && typeof status.message !== "string")) throw new IngestValidationError("Invalid span status");
        }
      }
    }
  }
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
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(resolveValue);
  if ("kvlistValue" in v) return attrMap(v.kvlistValue.values ?? []);
  return null;
}

function str(attrs: Record<string, unknown>, key: string): string | undefined {
  const v = attrs[key];
  return typeof v === "string" ? v : undefined;
}

function num(attrs: Record<string, unknown>, key: string): number {
  const v = attrs[key];
  if (v === undefined) return 0;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || (key.startsWith("llm.token_count.") && !Number.isSafeInteger(n))) {
    throw new IngestValidationError(`Invalid nonnegative ${key.startsWith("llm.token_count.") ? "integer" : "number"}: ${key}`);
  }
  return n;
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

/** Synchronous hashing keeps ingestion's SQLite transaction free of async yields. */
function sha256hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
  statusCode?: "STATUS_CODE_UNSET" | "STATUS_CODE_OK" | "STATUS_CODE_ERROR";
  statusMessage?: string;
}

function normalizeSpan(span: OtlpSpan): NormalizedSpan {
  const attrs = attrMap(span.attributes ?? []);
  // Parse supplied usage even if this span will not become a model-call record.
  // A present but invalid value must never acquire complete/recorded-zero coverage.
  for (const key of ["llm.token_count.prompt", "llm.token_count.completion", "llm.token_count.total",
    "llm.token_count.completion_details.reasoning", "llm.token_count.prompt_details.cache_read",
    "llm.token_count.prompt_details.cache_write", "llm.cost.total"]) num(attrs, key);
  const tags = attrs["tag.tags"];
  if (tags !== undefined && (!Array.isArray(tags) || tags.some(tag => typeof tag !== "string"))) {
    throw new IngestValidationError("Invalid tool tag list");
  }
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
    statusCode: normalizeStatusCode(span.status?.code),
    statusMessage: span.status?.message,
  };
}

function normalizeStatusCode(code: number | string | undefined): NormalizedSpan["statusCode"] {
  if (code === 0 || code === "0" || code === "STATUS_CODE_UNSET") return "STATUS_CODE_UNSET";
  if (code === 1 || code === "1" || code === "STATUS_CODE_OK" || code === "OK") return "STATUS_CODE_OK";
  if (code === 2 || code === "2" || code === "STATUS_CODE_ERROR" || code === "ERROR") return "STATUS_CODE_ERROR";
  return undefined;
}

interface ResolvedStatus {
  status?: string;
  endSignal?: TurnRecord["endSignal"];
  isError: boolean;
  capture: Record<string, unknown>;
}

function isErrorStatus(status: string | undefined): boolean {
  return status?.toUpperCase() === "ERROR";
}

function isSuccessStatus(status: string | undefined): boolean {
  const normalized = status?.toUpperCase();
  return normalized === "OK" || normalized === "COMPLETED" || normalized === "COMPLETE";
}

function validEndSignal(value: string | undefined): TurnRecord["endSignal"] | undefined {
  return value === "completed" || value === "user_stopped" || value === "error"
    ? value
    : undefined;
}

function resolveStatus(
  span: NormalizedSpan,
  previousCapture: Record<string, unknown> | undefined,
  previousStatus?: string,
  previousEndSignal?: TurnRecord["endSignal"],
): ResolvedStatus {
  const customStatus = str(span.attrs, "status");
  const endSignal = validEndSignal(str(span.attrs, "end_signal"));
  const hasReportedStatus = span.statusCode !== undefined || customStatus !== undefined;
  const isSuccess = span.statusCode === "STATUS_CODE_OK" || isSuccessStatus(customStatus);
  const isError = span.statusCode === "STATUS_CODE_ERROR"
    || isErrorStatus(customStatus)
    || (!hasReportedStatus && (previousCapture?.statusCode === "STATUS_CODE_ERROR" || isErrorStatus(previousStatus) || previousEndSignal === "error"));

  let status = isError
    ? "ERROR"
    : span.statusCode === "STATUS_CODE_OK"
      ? (customStatus ?? "OK")
      : customStatus ?? previousStatus;

  let resolvedEndSignal: TurnRecord["endSignal"];
  if (isError) resolvedEndSignal = "error";
  else if (endSignal) resolvedEndSignal = endSignal;
  else if (isSuccess) resolvedEndSignal = "completed";
  else if (customStatus !== undefined) resolvedEndSignal = isErrorStatus(customStatus) ? "error" : previousEndSignal;
  else if (hasReportedStatus && span.statusCode === "STATUS_CODE_UNSET") resolvedEndSignal = previousEndSignal;
  else resolvedEndSignal = previousEndSignal ?? (hasReportedStatus ? undefined : "completed");

  if (status === "ERROR") status = "ERROR";
  const hasExplicitCode = span.statusCode !== undefined && span.statusCode !== "STATUS_CODE_UNSET";
  const statusCode = isError
    ? "STATUS_CODE_ERROR"
    : hasExplicitCode
      ? span.statusCode
      : isSuccessStatus(customStatus)
        ? "STATUS_CODE_OK"
      : (previousCapture?.statusCode as NormalizedSpan["statusCode"] | undefined)
        ?? span.statusCode;
  const capture: Record<string, unknown> = {};
  if (statusCode !== undefined) capture.statusCode = statusCode;
  else if (hasReportedStatus) capture.statusCode = null;

  if (hasExplicitCode) {
    capture.statusMessage = span.statusMessage ?? null;
    capture.customStatus = customStatus ?? null;
  } else if (customStatus !== undefined) {
    capture.customStatus = customStatus;
  } else if (span.statusCode === "STATUS_CODE_UNSET") {
    capture.statusMessage = previousCapture?.statusMessage ?? null;
    capture.customStatus = previousCapture?.customStatus ?? null;
  }

  if (hasExplicitCode && span.statusCode !== statusCode) capture.reportedStatusCode = span.statusCode;
  else if (!hasReportedStatus && previousCapture?.reportedStatusCode !== undefined) {
    capture.reportedStatusCode = previousCapture.reportedStatusCode;
  } else if (hasExplicitCode) capture.reportedStatusCode = null;

  if (!hasReportedStatus) {
    for (const key of ["statusMessage", "customStatus", "reportedStatusCode"] as const) {
      if (previousCapture?.[key] !== undefined) capture[key] = previousCapture[key];
    }
  }

  return { status, endSignal: resolvedEndSignal, isError, capture };
}

function setCaptureWithCoverage(
  store: Store,
  id: string,
  unknownMetrics: string[],
  metadata: Record<string, unknown> = {},
): void {
  const merged = {
    ...(store.getCapture(id) ?? { source: "live", partial: false }),
    // A new live span is the newest provenance even when an import seeded this
    // identity first. Keep its other evidence, including status and coverage.
    source: "live",
    unknownMetrics,
  } as Record<string, unknown>;
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  store.setCapture(id, merged);
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
  validatePayload(payload);
  const events: Array<{ type: string; data: unknown }> = [];
  const result = store.db.transaction(() => ingestValidatedPayload(payload, store, event => events.push(event)))();
  // No observer can see a write from a rolled-back request. Publish committed
  // snapshots only, rather than the intermediate zero-filled aggregate records.
  const committed = new Map<string, { type: string; data: unknown }>();
  for (const event of events) {
    const record = event.data as { id: string };
    const key = `${event.type}:${record.id}`;
    committed.delete(key);
    committed.set(key, event);
  }
  for (const event of committed.values()) emitter?.(event);
  return result;
}

function ingestValidatedPayload(
  payload: OtlpExportRequest,
  store: Store,
  emitter: (event: { type: string; data: unknown }) => void,
): IngestResult {
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

    if (harness === "opencode") {
      for (const span of allSpans) {
        const sessionId = str(span.attrs, "session.id");
        if (!sessionId) continue;
        let messageId: string | undefined;
        try { messageId = JSON.parse(str(span.attrs, "metadata") ?? "{}").messageID; } catch { /* optional metadata */ }
        const sourceId = span.kind === "tool" ? str(span.attrs, "tool.id") : messageId;
        if (typeof sourceId === "string" && sourceId && ["chain", "turn", "llm", "tool"].includes(span.kind)) {
          store.registerSpanId(span.id, `opencode:${sessionId}:${sourceId}`);
        }
      }
      for (const span of allSpans) {
        span.id = store.resolveSpanId(span.id);
        if (span.parentId) span.parentId = store.resolveSpanId(span.parentId);
      }
    }
    const roots = buildTree(allSpans);

    for (const root of roots) {
      const orphanSessionId = str(root.span.attrs, "session.id");
      const isOrphan =
        root.span.parentId !== undefined &&
        orphanSessionId !== undefined &&
        orphanSessionId !== root.span.id;

      if (isOrphan) {
        processOrphanBatch(root, orphanSessionId!, harness, store, result, emitter);
      } else {
        processSessionRoot(root, harness, store, result, emitter);
      }
    }
  }

  return result;
}

// ── Session-level processing ──────────────────────────────────────────────────

function processSessionRoot(
  root: SpanTree,
  harness: HarnessKind,
  store: Store,
  result: IngestResult,
  emitter?: (event: { type: string; data: unknown }) => void
): void {
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
      processTurn(child, sessionId, turnIdx++, store, result, emitter);
    } else if (k === "llm") {
      // LLM direct child of session — attach without a turn wrapper
      processLlmCall(child, sessionId, sessionId, store, result, emitter);
    } else if (k === "tool") {
      processToolCall(child.span, sessionId, sessionId, store, result, emitter);
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

function processOrphanBatch(
  root: SpanTree,
  sessionId: string,
  harness: HarnessKind,
  store: Store,
  result: IngestResult,
  emitter?: (event: { type: string; data: unknown }) => void
): void {
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
    const idx = store.getTurn(root.span.id)?.idx ?? store.listTurns(sessionId).length;
    processTurn(root, sessionId, idx, store, result, emitter);
  } else {
    // Preserve the actual parent ID when children flush before their turn.
    // Inventing a turn ID here permanently strands those calls: the parent
    // arriving in a later batch cannot reattach or aggregate them.
    const syntheticTurnId = root.span.parentId ?? root.span.id;
    for (const child of [root, ...root.children]) {
      if (child.span.kind === "llm") {
        processLlmCall(child, syntheticTurnId, sessionId, store, result, emitter);
      } else if (child.span.kind === "tool") {
        processToolCall(child.span, syntheticTurnId, sessionId, store, result, emitter);
      }
    }
    // A child may arrive after its turn was already persisted. Refresh from
    // the upserted records so retries/duplicate batches never double-count.
    if (store.getTurn(syntheticTurnId)) {
      recomputeTurnTotals(syntheticTurnId, sessionId, store, emitter);
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
  const capture = store.getCapture(sessionId) ?? { source: "live", partial: false };
  store.setCapture(sessionId, { ...capture, unknownMetrics: [...new Set(llmCalls.flatMap(c => (store.getCapture(c.id)?.unknownMetrics ?? []) as string[]))].filter(k => k !== "latencyMs").map(k => k === "cost" ? "costTotal" : k) });
  emitter?.({ type: "session", data: updated });
}
function processTurn(
  node: SpanTree,
  sessionId: string,
  idx: number,
  store: Store,
  result: IngestResult,
  emitter?: (event: { type: string; data: unknown }) => void
): void {
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

  const previousTurn = store.getTurn(turnId);
  const previousCapture = store.getCapture(turnId);
  const resolvedStatus = resolveStatus(node.span, previousCapture, previousTurn?.status, previousTurn?.endSignal);

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
    status: resolvedStatus.status,
    endSignal: resolvedStatus.endSignal,
  };

  store.upsertTurn(turn);
  setCaptureWithCoverage(store, turnId,
    (previousCapture?.unknownMetrics ?? []) as string[], resolvedStatus.capture);
  result.turnsUpserted++;
  emitter?.({ type: "turn", data: turn });

  // Process LLM calls
  for (const llmNode of llmChildren) {
    processLlmCall(llmNode, turnId, sessionId, store, result, emitter);
  }
  // Also process nested LLM calls (turn may contain another CHAIN layer)
  for (const child of node.children) {
    if (child.span.kind === "chain") {
      for (const llmNode of child.children.filter((c) => c.span.kind === "llm")) {
        processLlmCall(llmNode, turnId, sessionId, store, result, emitter);
      }
    }
  }

  // Process tool calls
  const allToolDescendants = collectAllSpans(node).filter((s) => s.kind === "tool");
  for (const toolSpan of allToolDescendants) {
    processToolCall(toolSpan, turnId, sessionId, store, result, emitter);
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
  setCaptureWithCoverage(
    store,
    turnId,
    [...new Set(llmCalls.flatMap(c => (store.getCapture(c.id)?.unknownMetrics ?? []) as string[]))].filter(k => k !== "latencyMs"),
  );
  emitter?.({ type: "turn", data: updated });
}

// ── LLM call processing ───────────────────────────────────────────────────────

function processLlmCall(
  node: SpanTree,
  turnId: string,
  sessionId: string,
  store: Store,
  result: IngestResult,
  emitter?: (event: { type: string; data: unknown }) => void
): void {
  const span = node.span;
  const attrs = span.attrs;

  const inputMessages = str(attrs, "llm.input_messages");
  const outputMessages = str(attrs, "llm.output_messages");

  // Store large blobs by content hash
  let inputRef: string | undefined;
  let outputRef: string | undefined;

  if (inputMessages) {
    inputRef = sha256hex(inputMessages);
    store.putBlob(inputRef, "application/json", inputMessages);
  }
  if (outputMessages) {
    outputRef = sha256hex(outputMessages);
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

  const metricAttrs: Record<string, string> = {
    promptTokens: "llm.token_count.prompt", completionTokens: "llm.token_count.completion",
    reasoningTokens: "llm.token_count.completion_details.reasoning", cacheReadTokens: "llm.token_count.prompt_details.cache_read",
    cacheWriteTokens: "llm.token_count.prompt_details.cache_write", cost: "llm.cost.total",
  };
  const missing = Object.keys(metricAttrs).filter(key => attrs[metricAttrs[key]!] == null);
  if (!span.endedAt) missing.push("latencyMs");
  const previousCapture = store.getCapture(llmCall.id);
  const previousCall = store.listLlmCallsBySession(sessionId).find(c => c.id === llmCall.id);
  const resolvedStatus = resolveStatus(span, previousCapture);
  const previousMissing = (previousCapture?.unknownMetrics ?? []) as string[];
  const unknownMetrics = missing.filter(key => !previousCall || previousMissing.includes(key));
  if (previousCall) {
    for (const key of missing.filter(k => !unknownMetrics.includes(k))) {
      (llmCall as unknown as Record<string, unknown>)[key] = (previousCall as unknown as Record<string, unknown>)[key];
    }
    llmCall.outputRef ??= previousCall.outputRef;
    llmCall.inputMessagesRef ??= previousCall.inputMessagesRef;
  }
  store.upsertLlmCall(llmCall);
  setCaptureWithCoverage(store, llmCall.id, unknownMetrics, resolvedStatus.capture);
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
        const hash = sha256hex(text);
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
        const hash = sha256hex(schemaStr);
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

function processToolCall(
  span: NormalizedSpan,
  turnId: string,
  sessionId: string,
  store: Store,
  result: IngestResult,
  emitter?: (event: { type: string; data: unknown }) => void
): void {
  const attrs = span.attrs;
  const previousCapture = store.getCapture(span.id);
  const previousTool = store.listToolCallsBySession(sessionId).find((call) => call.id === span.id);
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

  if (argsRaw !== undefined) {
    argsRef = sha256hex(argsRaw);
    store.putBlob(argsRef, "application/json", argsRaw);
  }
  if (outputRaw !== undefined) {
    outputRef = sha256hex(outputRaw);
    store.putBlob(outputRef, "text/plain", outputRaw);
  }

  const resolvedStatus = resolveStatus(span, previousCapture, previousTool?.status);
  const previousUnknown = (previousCapture?.unknownMetrics ?? []) as string[];
  const hasKnownLatency = previousTool !== undefined && !previousUnknown.includes("latencyMs");
  const hasKnownOutputEstimate = previousTool !== undefined && !previousUnknown.includes("tokensOutEst");
  const unknownMetrics = previousUnknown.filter(key => key !== "latencyMs" && key !== "tokensOutEst");
  if (!span.endedAt && !hasKnownLatency) unknownMetrics.push("latencyMs");
  if (outputRaw === undefined && !hasKnownOutputEstimate) unknownMetrics.push("tokensOutEst");
  const hasClassification = attrs["tag.tags"] !== undefined;
  const toolCall: ToolCallRecord = {
    id: span.id,
    turnId,
    sessionId,
    name: str(attrs, "tool.name") ?? previousTool?.name ?? span.name,
    kind: hasClassification ? kind : previousTool?.kind ?? kind,
    server: hasClassification ? server : previousTool?.server,
    skill: hasClassification ? skill : previousTool?.skill,
    argsRef: argsRef ?? previousTool?.argsRef,
    outputRef: outputRef ?? previousTool?.outputRef,
    latencyMs: !span.endedAt && hasKnownLatency ? previousTool.latencyMs : span.latencyMs,
    tokensOutEst: outputRaw !== undefined ? estimateTokens(outputRaw) : previousTool?.tokensOutEst ?? 0,
    status: resolvedStatus.status,
  };

  store.upsertToolCall(toolCall);
  setCaptureWithCoverage(store, toolCall.id, unknownMetrics, resolvedStatus.capture);
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
