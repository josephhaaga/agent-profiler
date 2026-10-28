/**
 * Harness Profiler — Profiling engine
 *
 * All analyzers are pure functions over the Store. They emit typed Insight
 * objects with no LLM-as-judge in the hot path.
 *
 * Analyzers implemented:
 *  1. cacheAnalyzer      — hit ratio, prefix-volatility, cache-busting diffs
 *  2. attributionAnalyzer — latency/token/cost by tool, LLM, turn
 *  3. compositionAnalyzer — system-prompt segment treemap + bloat flags
 *  4. rightsizingAnalyzer — over/under-powered turn detection (z-score + rules)
 *  5. compareAnalyzer     — cross-harness metric deltas with bootstrap CIs
 */

import type { Insight, LlmCallRecord, SessionRecord, TurnRecord } from "@agent-profiler/schema";
import type { Store } from "@agent-profiler/store";

// ── Insight factory ───────────────────────────────────────────────────────────

function makeInsight(
  scopeType: Insight["scopeType"],
  scopeId: string,
  kind: string,
  severity: Insight["severity"],
  title: string,
  summary: string,
  evidence: Record<string, unknown>
): Insight {
  return {
    id: [kind, scopeType, scopeId, evidence.entityKey ?? evidence.llmCallId ?? evidence.turnId ?? (evidence.toolName ? `${evidence.toolKind ?? "unknown"}/${evidence.toolName}` : "summary")].map(value => encodeURIComponent(String(value))).join(":"),
    scopeType,
    scopeId,
    kind,
    severity,
    title,
    summary,
    evidence,
    createdAt: new Date().toISOString(),
  };
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

function zScore(value: number, xs: number[]): number {
  const sd = stddev(xs);
  if (sd === 0) return 0;
  return (value - mean(xs)) / sd;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

// ── 1. Cache analyzer ─────────────────────────────────────────────────────────

export interface CacheAnalysisResult {
  sessionId: string;
  hitRatio: number;
  volatilityScore: number;
  prefixChanges: Array<{
    llmCallId: string;
    prevSha256: string;
    newSha256: string;
    tokenEst: number;
  }>;
  insights: Insight[];
}

export function analyzeCacheEfficiency(
  session: SessionRecord,
  store: Store
): CacheAnalysisResult {
  const llmCalls = store.listLlmCallsBySession(session.id);
  if (!llmCalls.length) {
    return { sessionId: session.id, hitRatio: 0, volatilityScore: 0, prefixChanges: [], insights: [] };
  }

  const totalPrompt = llmCalls.reduce((s, c) => s + c.promptTokens, 0);
  const totalCacheRead = llmCalls.reduce((s, c) => s + c.cacheReadTokens, 0);
  const hitRatio = totalPrompt > 0 ? totalCacheRead / totalPrompt : 0;

  // Prefix hash stream: group segments by llm_call and compute the concatenated
  // static-prefix sha256 (simplified: use first static segment per call).
  const prefixHashes: Array<{ llmCallId: string; sha256: string; tokenEst: number }> = [];
  for (const call of llmCalls) {
    const segs = store.listPromptSegments(call.id);
    const staticSegs = segs.filter((s) => s.isStatic);
    if (staticSegs.length) {
      const combined = staticSegs.map((s) => s.sha256).join("|");
      const tokenEst = staticSegs.reduce((s, seg) => s + seg.tokenEst, 0);
      prefixHashes.push({ llmCallId: call.id, sha256: combined, tokenEst });
    }
  }

  // Detect prefix changes
  const prefixChanges: CacheAnalysisResult["prefixChanges"] = [];
  let changedCount = 0;
  for (let i = 1; i < prefixHashes.length; i++) {
    if (prefixHashes[i]!.sha256 !== prefixHashes[i - 1]!.sha256) {
      changedCount++;
      prefixChanges.push({
        llmCallId: prefixHashes[i]!.llmCallId,
        prevSha256: prefixHashes[i - 1]!.sha256,
        newSha256: prefixHashes[i]!.sha256,
        tokenEst: prefixHashes[i]!.tokenEst,
      });
    }
  }

  const volatilityScore =
    prefixHashes.length > 1 ? changedCount / (prefixHashes.length - 1) : 0;

  const insights: Insight[] = [];

  if (hitRatio < 0.3 && llmCalls.length >= 2) {
    insights.push(
      makeInsight(
        "session",
        session.id,
        "cache.low_hit_ratio",
        "info",
        "Low recorded cached-input share",
        `${(hitRatio * 100).toFixed(1)}% of recorded input tokens came from cache (${totalCacheRead.toLocaleString()} / ${totalPrompt.toLocaleString()}) across ${llmCalls.length} calls. Below the 30% review threshold; this does not establish a cache malfunction.`,
        { hitRatio, totalCacheRead, totalPrompt, llmCallCount: llmCalls.length, reviewThreshold: 0.3 }
      )
    );
  }

  if (volatilityScore > 0.5 && prefixChanges.length > 0) {
    insights.push(
      makeInsight(
        "session",
        session.id,
        "cache.prefix_volatile",
        "info",
        "Captured static-prefix hashes changed",
        `Captured static-prefix hashes changed in ${changedCount} of ${prefixHashes.length - 1} adjacent recorded calls (${(volatilityScore * 100).toFixed(0)}%). This alone does not establish a provider cache miss.`,
        { volatilityScore, changedCount, prefixChanges }
      )
    );
  }

  return { sessionId: session.id, hitRatio, volatilityScore, prefixChanges, insights };
}

// ── 2. Attribution analyzer ───────────────────────────────────────────────────

export interface AttributionResult {
  sessionId: string;
  byTool: Array<{
    name: string; kind: string; callCount: number;
    totalLatencyMs: number; totalTokensOut: number;
  }>;
  byModel: Array<{
    model: string; callCount: number;
    totalPromptTokens: number; totalCompletionTokens: number;
    totalCost: number; p50LatencyMs: number; p95LatencyMs: number;
  }>;
  insights: Insight[];
}

export function analyzeAttribution(
  session: SessionRecord,
  store: Store
): AttributionResult {
  const toolAttribution = store.getToolAttribution(session.id);
  const llmCalls = store.listLlmCallsBySession(session.id);

  // Aggregate by model
  const byModelMap = new Map<string, {
    callCount: number; totalPromptTokens: number;
    totalCompletionTokens: number; totalCost: number; latencies: number[];
  }>();

  for (const call of llmCalls) {
    const key = call.model;
    const existing = byModelMap.get(key) ?? {
      callCount: 0, totalPromptTokens: 0,
      totalCompletionTokens: 0, totalCost: 0, latencies: [],
    };
    existing.callCount++;
    existing.totalPromptTokens += call.promptTokens;
    existing.totalCompletionTokens += call.completionTokens;
    existing.totalCost += call.cost;
    existing.latencies.push(call.latencyMs);
    byModelMap.set(key, existing);
  }

  const byModel = Array.from(byModelMap.entries()).map(([model, v]) => {
    const sorted = [...v.latencies].sort((a, b) => a - b);
    return {
      model,
      callCount: v.callCount,
      totalPromptTokens: v.totalPromptTokens,
      totalCompletionTokens: v.totalCompletionTokens,
      totalCost: v.totalCost,
      p50LatencyMs: percentile(sorted, 50),
      p95LatencyMs: percentile(sorted, 95),
    };
  });

  const insights: Insight[] = [];

  // Flag tools with very high cumulative latency (> 30% of session span)
  const sessionDuration = session.endedAt
    ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()
    : 0;

  for (const tool of toolAttribution) {
    const latencyFraction = sessionDuration > 0 ? tool.total_latency_ms / sessionDuration : 0;
    if (latencyFraction > 0.3) {
      insights.push(
        makeInsight(
          "session",
          session.id,
          "attribution.tool_latency_high",
          "info",
          `Review accumulated '${tool.name}' durations`,
          `Recorded call durations total ${tool.total_latency_ms.toLocaleString()}ms across ${tool.call_count} calls. Calls can overlap and the session interval can include idle time; this is not an elapsed-time attribution.`,
          { toolName: tool.name, toolKind: tool.kind, latencyMs: tool.total_latency_ms, sessionIntervalMs: sessionDuration, callCount: tool.call_count, reviewThreshold: 0.3 }
        )
      );
    }
  }

  return {
    sessionId: session.id,
    byTool: toolAttribution.map((t) => ({
      name: t.name,
      kind: t.kind,
      callCount: t.call_count,
      totalLatencyMs: t.total_latency_ms,
      totalTokensOut: t.total_tokens_out,
    })),
    byModel,
    insights,
  };
}

// ── 3. Prompt-composition / bloat analyzer ────────────────────────────────────

export interface SegmentSummary {
  sourceKind: string;
  sourceName: string;
  totalChars: number;
  totalTokenEst: number;
  sha256: string;
  isDuplicate: boolean;
}

export interface CompositionResult {
  llmCallId: string;
  segments: SegmentSummary[];
  totalChars: number;
  totalTokenEst: number;
  toolDefsTokens: number;
  toolDefsFraction: number | null;
  insights: Insight[];
}

export function analyzeComposition(
  llmCallId: string,
  sessionId: string,
  store: Store
): CompositionResult {
  const segments = store.listPromptSegments(llmCallId);
  const toolDefs = store.listToolDefs(sessionId);

  const seenHashes = new Map<string, string>(); // sha256 -> sourceName
  const summaries: SegmentSummary[] = segments.map((seg) => {
    const isDuplicate = seenHashes.has(seg.sha256);
    if (!isDuplicate) seenHashes.set(seg.sha256, seg.sourceName);
    return {
      sourceKind: seg.sourceKind,
      sourceName: seg.sourceName,
      totalChars: seg.charLen,
      totalTokenEst: seg.tokenEst,
      sha256: seg.sha256,
      isDuplicate,
    };
  });

  const totalChars = summaries.reduce((s, x) => s + x.totalChars, 0);
  const totalTokenEst = summaries.reduce((s, x) => s + x.totalTokenEst, 0);
  const toolDefsTokens = toolDefs.reduce((s, d) => s + d.schemaTokensEst, 0);
  // Session inventory is not a per-request tool snapshot, and captured segments
  // are not necessarily the full input. A percentage here would be fabricated.
  const toolDefsFraction = null;

  const insights: Insight[] = [];

  // Duplicate segments
  const dupes = summaries.filter((s) => s.isDuplicate);
  if (dupes.length > 0) {
    insights.push(
      makeInsight(
        "session",
        sessionId,
        "composition.duplicate_segments",
        "info",
        "Repeated captured prompt segments",
        `${dupes.length} captured segment(s) share a content hash. Inspect the request context before treating repetition as unnecessary work.`,
        { llmCallId, duplicates: dupes.map((d) => d.sourceName) }
      )
    );
  }

  return { llmCallId, segments: summaries, totalChars, totalTokenEst, toolDefsTokens, toolDefsFraction, insights };
}

// ── 4. Model right-sizing analyzer ───────────────────────────────────────────

export interface RightsizingResult {
  sessionId: string;
  turns: Array<{
    turnId: string;
    signal: "overpowered" | "underpowered" | "ok";
    evidence: string;
    costZScore: number;
  }>;
  insights: Insight[];
}

/** Simple rules-based corrective-message detector. */
function looksLikeCorrective(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const patterns = [
    /^(no|nope|that('s| is)? (wrong|incorrect|not right))/,
    /^(wrong|incorrect|bad|stop)/,
    /^(that didn't|that did not|you (missed|forgot|ignored))/,
    /(try again|redo|undo|revert|fix that|fix it)/,
    /^(actually|wait|hmm|ugh)/,
  ];
  return patterns.some((p) => p.test(lower));
}

/** Experimental offline heuristic; never used to generate current product findings. */
export function analyzeRightsizing(
  session: SessionRecord,
  store: Store,
  allSessions: SessionRecord[]
): RightsizingResult {
  const turns = store.listTurns(session.id);
  const insights: Insight[] = [];

  // Gather cost-per-turn across all sessions with same model for baseline
  const sameModelSessions = allSessions.filter(
    (s) => s.model === session.model && s.id !== session.id
  );
  const baselineCosts: number[] = [];
  for (const s of sameModelSessions) {
    const sTurns = store.listTurns(s.id);
    for (const t of sTurns) {
      if (t.cost > 0) baselineCosts.push(t.cost);
    }
  }
  // Also include current session turns for the baseline
  for (const t of turns) {
    if (t.cost > 0) baselineCosts.push(t.cost);
  }

  const turnResults: RightsizingResult["turns"] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const nextTurn = turns[i + 1];

    let signal: "overpowered" | "underpowered" | "ok" = "ok";
    let evidence = "";
    const costZ = zScore(turn.cost, baselineCosts);

    // Under-powered signals
    if (turn.endSignal === "user_stopped") {
      signal = "underpowered";
      evidence = "Turn was stopped by user before completion";
    } else if (turn.endSignal === "error") {
      signal = "underpowered";
      evidence = "Turn ended with an error";
    } else if (turn.llmRoundTrips > 5) {
      signal = "underpowered";
      evidence = `High round-trip count (${turn.llmRoundTrips}) suggests repeated retries`;
    } else if (
      nextTurn &&
      nextTurn.userText &&
      looksLikeCorrective(nextTurn.userText)
    ) {
      signal = "underpowered";
      evidence = "Next user message looks like a correction";
    }

    // Over-powered signals (only if task succeeded and cost is a high outlier)
    if (signal === "ok" && costZ > 2.0 && turn.cost > 0) {
      signal = "overpowered";
      evidence = `Cost z-score ${costZ.toFixed(2)} — unusually expensive for this model/task class`;
    }

    if (signal !== "ok") {
      insights.push(
        makeInsight(
          "turn",
          turn.id,
          `rightsizing.turn_${signal}`,
          "warn",
          signal === "underpowered"
            ? "Turn may need a more capable model"
            : "Turn used more resources than typical — consider a smaller model",
          evidence,
          { turnId: turn.id, signal, costZ, cost: turn.cost, llmRoundTrips: turn.llmRoundTrips }
        )
      );
    }

    turnResults.push({ turnId: turn.id, signal, evidence, costZScore: costZ });
  }

  return { sessionId: session.id, turns: turnResults, insights };
}

// ── 5. Cross-harness compare ─────────────────────────────────────────────────

export interface HarnessMetrics {
  harness: string;
  sessionCount: number;
  meanCacheHitRatio: number | null;
  meanTokensPerTurn: number;
  meanCostPerTurn: number;
  meanLatencyMsPerTurn: number | null;
  meanTurnsPerSession: number;
}

export interface CompareResult {
  metrics: HarnessMetrics[];
  pairwiseDeltas: Array<{
    from: string; to: string;
    cacheHitRatioDelta: { delta: number | null; ciLow: number | null; ciHigh: number | null };
    tokensPerTurnDelta: { delta: number; ciLow: number | null; ciHigh: number | null };
    costPerTurnDelta: { delta: number; ciLow: number | null; ciHigh: number | null };
  }>;
  insights: Insight[];
  comparisonBasis: string;
  excludedSessionCount: number;
}

export function analyzeCompare(store: Store, harnessFilter?: string[]): CompareResult {
  const sessions = store.listSessions(1000);

  // Group sessions by harness
  const byHarness = new Map<string, SessionRecord[]>();
  const sessionTurns = new Map<string, TurnRecord[]>();
  let excludedSessionCount = 0;
  for (const s of sessions) {
    if (harnessFilter && !harnessFilter.includes(s.harness)) continue;
    const turns = store.listTurns(s.id);
    const turnIds = new Set(turns.map(t => t.id));
    const calls = store.listLlmCallsBySession(s.id);
    if (!turns.length || ((store.getCapture(s.id)?.associationConflicts ?? []) as string[]).length || ((store.getCapture(s.id)?.unknownMetrics ?? []) as string[]).length ||
        calls.some(c => !turnIds.has(c.turnId) || ((store.getCapture(c.id)?.unknownMetrics ?? []) as string[]).length)) {
      excludedSessionCount++; continue;
    }
    sessionTurns.set(s.id, turns);
    const existing = byHarness.get(s.harness) ?? [];
    existing.push(s);
    byHarness.set(s.harness, existing);
  }

  // Compute per-harness turn metrics
  const harnessMetricsMap = new Map<string, {
    cacheHitRatios: number[];
    tokensPerTurn: number[];
    costPerTurn: number[];
    latencyPerTurn: number[];
    turnsPerSession: number[];
    cacheRead: number;
    cacheInput: number;
  }>();

  for (const [harness, sessList] of byHarness) {
    const m = {
      cacheHitRatios: [] as number[],
      tokensPerTurn: [] as number[],
      costPerTurn: [] as number[],
      latencyPerTurn: [] as number[],
      turnsPerSession: [] as number[],
      cacheRead: 0,
      cacheInput: 0,
    };
    for (const sess of sessList) {
      const turns = sessionTurns.get(sess.id)!;
      if (!turns.length) continue;
      m.turnsPerSession.push(turns.length);
      for (const turn of turns) {
        const total = turn.promptTokens;
        if (total > 0 && turn.cacheReadTokens >= 0 && turn.cacheReadTokens <= total) {
          m.cacheHitRatios.push(turn.cacheReadTokens / total);
          m.cacheRead += turn.cacheReadTokens;
          m.cacheInput += total;
        }
        m.tokensPerTurn.push(turn.promptTokens + turn.completionTokens);
        m.costPerTurn.push(turn.cost);
        const llmCalls = store.listLlmCalls(turn.id);
        const turnLatency = llmCalls.reduce((s, c) => s + c.latencyMs, 0);
        if (llmCalls.length) m.latencyPerTurn.push(turnLatency);
      }
    }
    harnessMetricsMap.set(harness, m);
  }

  const metrics: HarnessMetrics[] = [];
  for (const [harness, m] of harnessMetricsMap) {
    metrics.push({
      harness,
      sessionCount: byHarness.get(harness)!.length,
      meanCacheHitRatio: m.cacheInput > 0 ? m.cacheRead / m.cacheInput : null,
      meanTokensPerTurn: mean(m.tokensPerTurn),
      meanCostPerTurn: mean(m.costPerTurn),
      meanLatencyMsPerTurn: m.latencyPerTurn.length ? mean(m.latencyPerTurn) : null,
      meanTurnsPerSession: mean(m.turnsPerSession),
    });
  }

  // Descriptive, unmatched cohorts. Turn-level bootstrapping would imply
  // independence that is not established, so no confidence interval is claimed.
  const harnessNames = Array.from(harnessMetricsMap.keys());
  const pairwiseDeltas: CompareResult["pairwiseDeltas"] = [];
  const insights: Insight[] = [];

  for (let i = 0; i < harnessNames.length; i++) {
    for (let j = i + 1; j < harnessNames.length; j++) {
      const fromH = harnessNames[i]!;
      const toH = harnessNames[j]!;
      const fromM = harnessMetricsMap.get(fromH)!;
      const toM = harnessMetricsMap.get(toH)!;

      const fromCache = fromM.cacheInput > 0 ? fromM.cacheRead / fromM.cacheInput : null;
      const toCache = toM.cacheInput > 0 ? toM.cacheRead / toM.cacheInput : null;

      pairwiseDeltas.push({
        from: fromH,
        to: toH,
        cacheHitRatioDelta: { delta: fromCache == null || toCache == null ? null : toCache - fromCache, ciLow: null, ciHigh: null },
        tokensPerTurnDelta: { delta: mean(toM.tokensPerTurn) - mean(fromM.tokensPerTurn), ciLow: null, ciHigh: null },
        costPerTurnDelta: { delta: mean(toM.costPerTurn) - mean(fromM.costPerTurn), ciLow: null, ciHigh: null },
      });

    }
  }

  return { metrics, pairwiseDeltas, insights, comparisonBasis: "Observed, unmatched workloads among the latest 1000 sessions. Recorded cost is not billed spend; no winner or confidence interval is inferred.", excludedSessionCount };
}

// ── Run all analyzers for a session and persist insights ──────────────────────

export async function runProfilers(
  sessionId: string,
  store: Store
): Promise<Insight[]> {
  const session = store.getSession(sessionId);
  if (!session) return [];

  const hasMissingMetrics = (id: string) => ((store.getCapture(id)?.unknownMetrics ?? []) as string[]).length > 0 ||
    store.listLlmCallsBySession(id).some(c => ((store.getCapture(c.id)?.unknownMetrics ?? []) as string[]).length > 0);
  const allInsights: Insight[] = [];

  // Cache
  if (!hasMissingMetrics(sessionId)) {
    const cache = analyzeCacheEfficiency(session, store);
    allInsights.push(...cache.insights);
  }

  // Attribution
  if (!hasMissingMetrics(sessionId)) {
    const attr = analyzeAttribution(session, store);
    allInsights.push(...attr.insights);
  }

  // Composition: run for each LLM call in the session
  const llmCalls = store.listLlmCallsBySession(sessionId);
  const sessionCapture = store.getCapture(sessionId);
  if (hasMissingMetrics(sessionId) || sessionCapture?.partial === true) {
    const incompleteCalls = llmCalls.filter(c => ((store.getCapture(c.id)?.unknownMetrics ?? []) as string[]).length > 0);
    const sessionUnknownMetrics = (sessionCapture?.unknownMetrics ?? []) as string[];
    const callUnknownMetrics = [...new Set(incompleteCalls.flatMap(c => (store.getCapture(c.id)?.unknownMetrics ?? []) as string[]))];
    allInsights.push(makeInsight("session", sessionId, "coverage.incomplete", "info",
      hasMissingMetrics(sessionId) ? "Some measurements are unavailable" : "Capture is partial",
      incompleteCalls.length ? `${incompleteCalls.length} of ${llmCalls.length} model calls have missing measurements. Numeric recommendations are withheld; this is not a conclusion about run quality.`
        : sessionUnknownMetrics.length ? `Session aggregates are unavailable for ${sessionUnknownMetrics.join(", ")}. Current evidence cannot establish a complete measurement.`
        : "Recorded call metrics remain inspectable, but capture is partial: full request composition or completeness is not guaranteed. No missing data is reconstructed.",
      { unknownCallCount: incompleteCalls.length, llmCallCount: llmCalls.length,
        partialCapture: sessionCapture?.partial === true, sessionUnknownMetrics,
        associationConflicts: sessionCapture?.associationConflicts ?? [],
        unknownMetrics: [...new Set([...sessionUnknownMetrics, ...callUnknownMetrics])] }));
  }
  for (const call of llmCalls) {
    const comp = analyzeComposition(call.id, sessionId, store);
    allInsights.push(...comp.insights);
  }

  // Recorded execution outcomes are evidence. Errors, user stops, or many
  // round trips do not establish that a model is over/under-powered.
  const turns = new Map(store.listTurns(sessionId).map(t => [t.id, t]));
  const toolCalls = store.listToolCallsBySession(sessionId);
  const toolErrors = new Map<string, typeof toolCalls>();
  const modelErrors = new Map<string, typeof llmCalls>();
  for (const tool of toolCalls) if (tool.status === "ERROR") {
    const group = toolErrors.get(tool.turnId) ?? []; group.push(tool); toolErrors.set(tool.turnId, group);
  }
  for (const call of llmCalls) if (call.finishReason === "error" || [2, "STATUS_CODE_ERROR"].includes(store.getCapture(call.id)?.statusCode as string | number)) {
    const group = modelErrors.get(call.turnId) ?? []; group.push(call); modelErrors.set(call.turnId, group);
  }
  const parentIds = new Set([...turns.keys(), ...modelErrors.keys(), ...toolErrors.keys()]);
  for (const parentId of parentIds) {
    const turn = turns.get(parentId);
    const scopeType = turn ? "turn" : "session";
    const scopeId = turn?.id ?? sessionId;
    const context = turn ? { sessionId, turnId: turn.id } : { sessionId, pendingTurnId: parentId, entityKey: `pending:${parentId}` };
    const tools = toolErrors.get(parentId) ?? [];
    const calls = modelErrors.get(parentId) ?? [];
    if (tools.length) allInsights.push(makeInsight(scopeType, scopeId, "execution.tool_errors", "warn",
      `${tools.length} recorded tool ${tools.length === 1 ? "error" : "errors"}`,
      "These tool calls reported errors. Later calls may have recovered; inspect the captured evidence before changing the harness.",
      { ...context, toolCallIds: tools.map(t => t.id), toolNames: [...new Set(tools.map(t => t.name))], errorCount: tools.length }));
    if (calls.length) allInsights.push(makeInsight(scopeType, scopeId, "execution.model_errors", "warn",
      `${calls.length} recorded model-call ${calls.length === 1 ? "error" : "errors"}`,
      "The source recorded a model-call error status or finish reason. This is not a diagnosis of provider failure or model suitability.",
      { ...context, llmCallIds: calls.map(c => c.id), errorCount: calls.length }));
    if (turn?.endSignal === "error") allInsights.push(makeInsight("turn", turn.id, "execution.turn_error", "warn",
      "Turn ended with a recorded error", "Inspect the turn's model and tool outcomes for the original evidence.", { sessionId, turnId: turn.id }));
    else if (turn?.endSignal === "user_stopped") allInsights.push(makeInsight("turn", turn.id, "execution.user_stopped", "info",
      "Turn was stopped by the user", "A deliberate stop is not evidence of an agent or model failure.", { sessionId, turnId: turn.id }));
  }

  return store.replaceSessionInsights(sessionId, allInsights);
}
