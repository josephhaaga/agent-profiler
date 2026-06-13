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

let _insightSeq = 0;

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
    id: `${kind}:${scopeId}:${++_insightSeq}`,
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

/** Simple bootstrap CI for mean difference between two arrays. */
function bootstrapCI(
  a: number[],
  b: number[],
  iterations = 1000,
  alpha = 0.05
): { meanA: number; meanB: number; delta: number; ciLow: number; ciHigh: number } {
  const meanA = mean(a);
  const meanB = mean(b);
  const delta = meanB - meanA;

  if (!a.length || !b.length) {
    return { meanA, meanB, delta, ciLow: delta, ciHigh: delta };
  }

  const diffs: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sampleA = Array.from({ length: a.length }, () => a[Math.floor(Math.random() * a.length)]!);
    const sampleB = Array.from({ length: b.length }, () => b[Math.floor(Math.random() * b.length)]!);
    diffs.push(mean(sampleB) - mean(sampleA));
  }
  diffs.sort((x, y) => x - y);
  return {
    meanA,
    meanB,
    delta,
    ciLow: percentile(diffs, alpha / 2 * 100),
    ciHigh: percentile(diffs, (1 - alpha / 2) * 100),
  };
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
        hitRatio < 0.1 ? "critical" : "warn",
        "Low prompt-cache hit ratio",
        `Cache hit ratio is ${(hitRatio * 100).toFixed(1)}% (${totalCacheRead.toLocaleString()} / ${totalPrompt.toLocaleString()} tokens). Consider stabilizing the static prefix.`,
        { hitRatio, totalCacheRead, totalPrompt }
      )
    );
  }

  if (volatilityScore > 0.5 && prefixChanges.length > 0) {
    insights.push(
      makeInsight(
        "session",
        session.id,
        "cache.prefix_volatile",
        "warn",
        "Cache-busting prefix changes detected",
        `The static prompt prefix changed in ${changedCount} of ${prefixHashes.length - 1} consecutive LLM calls (volatility ${(volatilityScore * 100).toFixed(0)}%). This breaks prefix caching.`,
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
          "warn",
          `Tool '${tool.name}' accounts for >30% of session latency`,
          `'${tool.name}' consumed ${tool.total_latency_ms.toLocaleString()}ms across ${tool.call_count} call(s) — ${(latencyFraction * 100).toFixed(0)}% of session duration.`,
          { toolName: tool.name, latencyMs: tool.total_latency_ms, fraction: latencyFraction }
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
  toolDefsFraction: number;
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
  const toolDefsFraction = totalTokenEst > 0 ? toolDefsTokens / totalTokenEst : 0;

  const insights: Insight[] = [];

  // Tool defs bloat: >25% of prompt tokens are tool schemas
  if (toolDefsFraction > 0.25 && toolDefsTokens > 500) {
    insights.push(
      makeInsight(
        "session",
        sessionId,
        "composition.tool_defs_bloat",
        toolDefsFraction > 0.5 ? "critical" : "warn",
        "Tool definitions consume a large share of the context window",
        `Tool schema definitions are estimated at ${toolDefsTokens.toLocaleString()} tokens — ${(toolDefsFraction * 100).toFixed(0)}% of the prompt. Consider reducing tool descriptions or conditionally including tools.`,
        { toolDefsTokens, totalTokenEst, toolDefsFraction }
      )
    );
  }

  // Duplicate segments
  const dupes = summaries.filter((s) => s.isDuplicate);
  if (dupes.length > 0) {
    insights.push(
      makeInsight(
        "session",
        sessionId,
        "composition.duplicate_segments",
        "warn",
        "Duplicate prompt segments detected",
        `${dupes.length} segment(s) appear more than once in the prompt (same content hash). This wastes context and may indicate configuration bugs.`,
        { duplicates: dupes.map((d) => d.sourceName) }
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
  meanCacheHitRatio: number;
  meanTokensPerTurn: number;
  meanCostPerTurn: number;
  meanLatencyMsPerTurn: number;
  meanTurnsPerSession: number;
}

export interface CompareResult {
  metrics: HarnessMetrics[];
  pairwiseDeltas: Array<{
    from: string; to: string;
    cacheHitRatioDelta: { delta: number; ciLow: number; ciHigh: number };
    tokensPerTurnDelta: { delta: number; ciLow: number; ciHigh: number };
    costPerTurnDelta: { delta: number; ciLow: number; ciHigh: number };
  }>;
  insights: Insight[];
}

export function analyzeCompare(store: Store, harnessFilter?: string[]): CompareResult {
  const sessions = store.listSessions(1000);

  // Group sessions by harness
  const byHarness = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    if (harnessFilter && !harnessFilter.includes(s.harness)) continue;
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
  }>();

  for (const [harness, sessList] of byHarness) {
    const m = {
      cacheHitRatios: [] as number[],
      tokensPerTurn: [] as number[],
      costPerTurn: [] as number[],
      latencyPerTurn: [] as number[],
      turnsPerSession: [] as number[],
    };
    for (const sess of sessList) {
      const turns = store.listTurns(sess.id);
      if (!turns.length) continue;
      m.turnsPerSession.push(turns.length);
      for (const turn of turns) {
        const total = turn.promptTokens + turn.completionTokens;
        if (total > 0) {
          m.cacheHitRatios.push(turn.cacheReadTokens / total);
        }
        m.tokensPerTurn.push(turn.promptTokens + turn.completionTokens);
        m.costPerTurn.push(turn.cost);
        const llmCalls = store.listLlmCalls(turn.id);
        const turnLatency = llmCalls.reduce((s, c) => s + c.latencyMs, 0);
        m.latencyPerTurn.push(turnLatency);
      }
    }
    harnessMetricsMap.set(harness, m);
  }

  const metrics: HarnessMetrics[] = [];
  for (const [harness, m] of harnessMetricsMap) {
    metrics.push({
      harness,
      sessionCount: byHarness.get(harness)!.length,
      meanCacheHitRatio: mean(m.cacheHitRatios),
      meanTokensPerTurn: mean(m.tokensPerTurn),
      meanCostPerTurn: mean(m.costPerTurn),
      meanLatencyMsPerTurn: mean(m.latencyPerTurn),
      meanTurnsPerSession: mean(m.turnsPerSession),
    });
  }

  // Pairwise deltas with bootstrap CIs
  const harnessNames = Array.from(harnessMetricsMap.keys());
  const pairwiseDeltas: CompareResult["pairwiseDeltas"] = [];
  const insights: Insight[] = [];

  for (let i = 0; i < harnessNames.length; i++) {
    for (let j = i + 1; j < harnessNames.length; j++) {
      const fromH = harnessNames[i]!;
      const toH = harnessNames[j]!;
      const fromM = harnessMetricsMap.get(fromH)!;
      const toM = harnessMetricsMap.get(toH)!;

      const cacheCI = bootstrapCI(fromM.cacheHitRatios, toM.cacheHitRatios);
      const tokensCI = bootstrapCI(fromM.tokensPerTurn, toM.tokensPerTurn);
      const costCI = bootstrapCI(fromM.costPerTurn, toM.costPerTurn);

      pairwiseDeltas.push({
        from: fromH,
        to: toH,
        cacheHitRatioDelta: { delta: cacheCI.delta, ciLow: cacheCI.ciLow, ciHigh: cacheCI.ciHigh },
        tokensPerTurnDelta: { delta: tokensCI.delta, ciLow: tokensCI.ciLow, ciHigh: tokensCI.ciHigh },
        costPerTurnDelta: { delta: costCI.delta, ciLow: costCI.ciLow, ciHigh: costCI.ciHigh },
      });

      // Surface significant cost differences
      const costRelative = costCI.meanA > 0 ? costCI.delta / costCI.meanA : 0;
      if (Math.abs(costRelative) > 0.2 && !costCI.ciLow.toString().includes("NaN")) {
        const direction = costCI.delta > 0 ? "more expensive" : "cheaper";
        insights.push(
          makeInsight(
            "harness",
            `${fromH}:${toH}`,
            "compare.cost_delta",
            Math.abs(costRelative) > 0.5 ? "critical" : "warn",
            `${toH} is ${direction} than ${fromH} per turn`,
            `Δ = ${costCI.delta >= 0 ? "+" : ""}${(costRelative * 100).toFixed(1)}%, 95% CI [${(cacheCI.ciLow * 100).toFixed(1)}%, ${(cacheCI.ciHigh * 100).toFixed(1)}%]`,
            { from: fromH, to: toH, delta: costCI.delta, ciLow: costCI.ciLow, ciHigh: costCI.ciHigh, relativeChange: costRelative }
          )
        );
      }
    }
  }

  return { metrics, pairwiseDeltas, insights };
}

// ── Run all analyzers for a session and persist insights ──────────────────────

export async function runProfilers(
  sessionId: string,
  store: Store
): Promise<Insight[]> {
  const session = store.getSession(sessionId);
  if (!session) return [];

  const allSessions = store.listSessions(500);
  const allInsights: Insight[] = [];

  // Cache
  const cache = analyzeCacheEfficiency(session, store);
  allInsights.push(...cache.insights);

  // Attribution
  const attr = analyzeAttribution(session, store);
  allInsights.push(...attr.insights);

  // Composition: run for each LLM call in the session
  const llmCalls = store.listLlmCallsBySession(sessionId);
  for (const call of llmCalls) {
    const comp = analyzeComposition(call.id, sessionId, store);
    allInsights.push(...comp.insights);
  }

  // Right-sizing
  const rs = analyzeRightsizing(session, store, allSessions);
  allInsights.push(...rs.insights);

  // Persist all insights
  for (const insight of allInsights) {
    store.upsertInsight(insight);
  }

  return allInsights;
}
