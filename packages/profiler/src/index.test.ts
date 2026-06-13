import { describe, expect, test } from "bun:test";
import {
  analyzeCacheEfficiency,
  analyzeAttribution,
  analyzeComposition,
  analyzeRightsizing,
  analyzeCompare,
  runProfilers,
} from "../src/index";
import { Store } from "@agent-profiler/store";
import type { SessionRecord, TurnRecord, LlmCallRecord, ToolCallRecord } from "@agent-profiler/schema";

// ── Fixture builders ──────────────────────────────────────────────────────────

function seedSession(
  store: Store,
  id: string,
  overrides: Partial<SessionRecord> = {}
): SessionRecord {
  const s: SessionRecord = {
    id,
    harness: "opencode",
    agent: "test",
    model: "claude-opus-4-5",
    startedAt: "2024-01-01T00:00:00.000Z",
    endedAt: "2024-01-01T00:01:00.000Z",
    turnCount: 1,
    llmCallCount: 1,
    toolCallCount: 0,
    promptTokens: 1000,
    completionTokens: 100,
    reasoningTokens: 0,
    cacheReadTokens: 800,
    cacheWriteTokens: 200,
    costTotal: 0.01,
    ...overrides,
  };
  store.upsertSession(s);
  return s;
}

function seedTurn(store: Store, overrides: Partial<TurnRecord> = {}): TurnRecord {
  const t: TurnRecord = {
    id: `turn-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "sess-1",
    idx: 0,
    userText: "Tell me about Paris",
    assistantText: "Paris is the capital of France.",
    startedAt: "2024-01-01T00:00:01.000Z",
    endedAt: "2024-01-01T00:00:30.000Z",
    llmRoundTrips: 1,
    promptTokens: 1000,
    completionTokens: 100,
    reasoningTokens: 0,
    cacheReadTokens: 800,
    cacheWriteTokens: 200,
    cost: 0.01,
    endSignal: "completed",
    ...overrides,
  };
  store.upsertTurn(t);
  return t;
}

function seedLlmCall(store: Store, turnId: string, overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
  const c: LlmCallRecord = {
    id: `llm-${Math.random().toString(36).slice(2, 8)}`,
    turnId,
    sessionId: "sess-1",
    model: "claude-opus-4-5",
    provider: "anthropic",
    promptTokens: 1000,
    completionTokens: 100,
    reasoningTokens: 0,
    cacheReadTokens: 800,
    cacheWriteTokens: 200,
    cost: 0.01,
    latencyMs: 2000,
    finishReason: "stop",
    ...overrides,
  };
  store.upsertLlmCall(c);
  return c;
}

function seedToolCall(store: Store, turnId: string, overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  const tc: ToolCallRecord = {
    id: `tc-${Math.random().toString(36).slice(2, 8)}`,
    turnId,
    sessionId: "sess-1",
    name: "read",
    kind: "builtin",
    latencyMs: 500,
    tokensOutEst: 100,
    ...overrides,
  };
  store.upsertToolCall(tc);
  return tc;
}

// ── Cache analyzer ────────────────────────────────────────────────────────────

describe("analyzeCacheEfficiency", () => {
  test("returns 0 hit ratio for session with no LLM calls", () => {
    const store = new Store();
    const session = seedSession(store, "sess-1");
    const r = analyzeCacheEfficiency(session, store);
    expect(r.hitRatio).toBe(0);
    expect(r.insights).toHaveLength(0);
  });

  test("computes correct hit ratio from LLM calls", () => {
    const store = new Store();
    const session = seedSession(store, "sess-1");
    const turn = seedTurn(store, { sessionId: "sess-1" });
    seedLlmCall(store, turn.id, { promptTokens: 1000, cacheReadTokens: 900 });

    const r = analyzeCacheEfficiency(session, store);
    expect(r.hitRatio).toBeCloseTo(0.9);
  });

  test("emits warn insight when hit ratio < 30%", () => {
    const store = new Store();
    const session = seedSession(store, "sess-1");
    const t1 = seedTurn(store, { sessionId: "sess-1" });
    const t2 = seedTurn(store, { sessionId: "sess-1", idx: 1 });
    // Two calls with low cache read → ratio < 0.1
    seedLlmCall(store, t1.id, { promptTokens: 1000, cacheReadTokens: 50 });
    seedLlmCall(store, t2.id, { promptTokens: 1000, cacheReadTokens: 50 });

    const r = analyzeCacheEfficiency(session, store);
    expect(r.hitRatio).toBeLessThan(0.3);
    expect(r.insights.some((i) => i.kind === "cache.low_hit_ratio")).toBe(true);
    const ins = r.insights.find((i) => i.kind === "cache.low_hit_ratio")!;
    expect(ins.severity).toBe("critical"); // < 0.1
  });

  test("emits warn insight for prefix volatility with static segments", () => {
    const store = new Store();
    const session = seedSession(store, "sess-1");
    const t1 = seedTurn(store, { sessionId: "sess-1" });
    const t2 = seedTurn(store, { sessionId: "sess-1", idx: 1 });
    const l1 = seedLlmCall(store, t1.id);
    const l2 = seedLlmCall(store, t2.id);

    // Two calls with different static prefix hashes
    store.upsertPromptSegments([{
      llmCallId: l1.id, ord: 0, sourceKind: "system", sourceName: "instructions",
      charLen: 500, tokenEst: 125, sha256: "hash-v1", isStatic: true,
    }]);
    store.upsertPromptSegments([{
      llmCallId: l2.id, ord: 0, sourceKind: "system", sourceName: "instructions",
      charLen: 500, tokenEst: 125, sha256: "hash-v2", isStatic: true, // different hash!
    }]);

    const r = analyzeCacheEfficiency(session, store);
    expect(r.volatilityScore).toBe(1.0); // 1 change / 1 pair
    expect(r.prefixChanges).toHaveLength(1);
    expect(r.insights.some((i) => i.kind === "cache.prefix_volatile")).toBe(true);
  });
});

// ── Attribution analyzer ──────────────────────────────────────────────────────

describe("analyzeAttribution", () => {
  test("groups LLM calls by model with p50/p95 latency", () => {
    const store = new Store();
    const session = seedSession(store, "sess-1");
    const turn = seedTurn(store, { sessionId: "sess-1" });
    seedLlmCall(store, turn.id, { model: "claude-opus-4-5", latencyMs: 1000 });
    seedLlmCall(store, turn.id, { model: "claude-opus-4-5", latencyMs: 2000 });
    seedLlmCall(store, turn.id, { model: "claude-haiku-3-5", latencyMs: 300 });

    const r = analyzeAttribution(session, store);
    expect(r.byModel.length).toBe(2);
    const opus = r.byModel.find((m) => m.model === "claude-opus-4-5")!;
    expect(opus.callCount).toBe(2);
    expect(opus.p50LatencyMs).toBe(1000);
    // p95 of [1000, 2000]: floor(0.95 * 1) = 0 → 1000 (nearest-rank on 2 samples)
    expect(opus.p95LatencyMs).toBe(1000);
  });

  test("emits insight when tool consumes >30% of session duration", () => {
    const store = new Store();
    // Session runs 10 seconds; tool runs 4 seconds = 40%
    const session = seedSession(store, "sess-1", {
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: "2024-01-01T00:00:10.000Z",
    });
    const turn = seedTurn(store, { sessionId: "sess-1" });
    seedToolCall(store, turn.id, { name: "slow_mcp", kind: "mcp", latencyMs: 4000 });

    const r = analyzeAttribution(session, store);
    expect(r.insights.some((i) => i.kind === "attribution.tool_latency_high")).toBe(true);
  });

  test("no tool insight when session endedAt is missing", () => {
    const store = new Store();
    const session = seedSession(store, "sess-1", { endedAt: undefined });
    const turn = seedTurn(store, { sessionId: "sess-1" });
    seedToolCall(store, turn.id, { latencyMs: 99999 });
    const r = analyzeAttribution(session, store);
    expect(r.insights.filter((i) => i.kind === "attribution.tool_latency_high")).toHaveLength(0);
  });
});

// ── Composition analyzer ──────────────────────────────────────────────────────

describe("analyzeComposition", () => {
  test("returns empty result when no segments exist", () => {
    const store = new Store();
    seedSession(store, "sess-1");
    const turn = seedTurn(store, { sessionId: "sess-1" });
    const llm = seedLlmCall(store, turn.id);
    const r = analyzeComposition(llm.id, "sess-1", store);
    expect(r.segments).toHaveLength(0);
    expect(r.totalTokenEst).toBe(0);
    expect(r.insights).toHaveLength(0);
  });

  test("detects tool-def bloat when >25% of tokens are tool schemas", () => {
    const store = new Store();
    seedSession(store, "sess-1");
    const turn = seedTurn(store, { sessionId: "sess-1" });
    const llm = seedLlmCall(store, turn.id);

    // Seed segments: 1000 total token est
    store.upsertPromptSegments([
      { llmCallId: llm.id, ord: 0, sourceKind: "system", sourceName: "instructions", charLen: 1500, tokenEst: 375, sha256: "s1", isStatic: true },
      { llmCallId: llm.id, ord: 1, sourceKind: "tool", sourceName: "read_schema", charLen: 2500, tokenEst: 625, sha256: "s2", isStatic: false },
    ]);

    // Seed tool defs: 650 tokens
    store.upsertToolDef({ sessionId: "sess-1", name: "read", kind: "builtin", schemaJson: "{}", schemaTokensEst: 650, sha256: "td1" });

    const r = analyzeComposition(llm.id, "sess-1", store);
    expect(r.toolDefsTokens).toBe(650);
    expect(r.toolDefsFraction).toBeGreaterThan(0.25);
    expect(r.insights.some((i) => i.kind === "composition.tool_defs_bloat")).toBe(true);
  });

  test("detects duplicate segments by sha256", () => {
    const store = new Store();
    seedSession(store, "sess-1");
    const turn = seedTurn(store, { sessionId: "sess-1" });
    const llm = seedLlmCall(store, turn.id);

    store.upsertPromptSegments([
      { llmCallId: llm.id, ord: 0, sourceKind: "system", sourceName: "instructions", charLen: 500, tokenEst: 125, sha256: "same-hash", isStatic: true },
      { llmCallId: llm.id, ord: 1, sourceKind: "system", sourceName: "instructions-copy", charLen: 500, tokenEst: 125, sha256: "same-hash", isStatic: false },
    ]);

    const r = analyzeComposition(llm.id, "sess-1", store);
    expect(r.insights.some((i) => i.kind === "composition.duplicate_segments")).toBe(true);
  });
});

// ── Right-sizing analyzer ─────────────────────────────────────────────────────

describe("analyzeRightsizing", () => {
  test("flags turn with user_stopped as underpowered", () => {
    const store = new Store();
    const session = seedSession(store, "sess-1");
    seedTurn(store, { sessionId: "sess-1", endSignal: "user_stopped", cost: 0.01 });

    const r = analyzeRightsizing(session, store, [session]);
    expect(r.turns[0]!.signal).toBe("underpowered");
    expect(r.insights.some((i) => i.kind.includes("underpowered"))).toBe(true);
  });

  test("flags turn with error endSignal as underpowered", () => {
    const store = new Store();
    const session = seedSession(store, "sess-1");
    seedTurn(store, { sessionId: "sess-1", endSignal: "error", cost: 0.01 });

    const r = analyzeRightsizing(session, store, [session]);
    expect(r.turns[0]!.signal).toBe("underpowered");
  });

  test("flags turn followed by corrective message as underpowered", () => {
    const store = new Store();
    const session = seedSession(store, "sess-1");
    seedTurn(store, { sessionId: "sess-1", idx: 0, endSignal: "completed", cost: 0.01 });
    seedTurn(store, { sessionId: "sess-1", idx: 1, userText: "No that's wrong, try again", endSignal: "completed", cost: 0.01 });

    const r = analyzeRightsizing(session, store, [session]);
    expect(r.turns[0]!.signal).toBe("underpowered");
  });

  test("flags high-cost outlier turn as overpowered", () => {
    const store = new Store();
    // Create sessions with many cheap turns to establish a baseline
    const baseline: SessionRecord[] = [];
    for (let i = 0; i < 5; i++) {
      const s = seedSession(store, `baseline-${i}`, { id: `baseline-${i}`, costTotal: 0.001 });
      baseline.push(s);
      seedTurn(store, { sessionId: `baseline-${i}`, cost: 0.001 });
    }

    const expensiveSession = seedSession(store, "expensive", { id: "expensive", costTotal: 5.0 });
    seedTurn(store, { sessionId: "expensive", cost: 5.0, endSignal: "completed" });

    const r = analyzeRightsizing(expensiveSession, store, [...baseline, expensiveSession]);
    expect(r.turns[0]!.signal).toBe("overpowered");
  });

  test("marks normal turn as ok", () => {
    const store = new Store();
    const session = seedSession(store, "sess-1");
    seedTurn(store, { sessionId: "sess-1", endSignal: "completed", cost: 0.01 });

    const r = analyzeRightsizing(session, store, [session]);
    expect(r.turns[0]!.signal).toBe("ok");
    expect(r.insights).toHaveLength(0);
  });
});

// ── Compare analyzer ──────────────────────────────────────────────────────────

describe("analyzeCompare", () => {
  test("returns empty metrics when no sessions", () => {
    const store = new Store();
    const r = analyzeCompare(store);
    expect(r.metrics).toHaveLength(0);
    expect(r.pairwiseDeltas).toHaveLength(0);
  });

  test("groups metrics by harness", () => {
    const store = new Store();
    // Two opencode sessions
    const oc1 = seedSession(store, "oc-1", { harness: "opencode", costTotal: 0.01 });
    const oc2 = seedSession(store, "oc-2", { harness: "opencode", costTotal: 0.02 });
    seedTurn(store, { sessionId: "oc-1", cost: 0.01 });
    seedTurn(store, { sessionId: "oc-2", cost: 0.02 });

    // One vscode session
    seedSession(store, "vs-1", { harness: "vscode", costTotal: 0.05 });
    seedTurn(store, { sessionId: "vs-1", cost: 0.05 });

    void oc1; void oc2;

    const r = analyzeCompare(store);
    expect(r.metrics.length).toBe(2);
    const oc = r.metrics.find((m) => m.harness === "opencode")!;
    expect(oc.sessionCount).toBe(2);
    expect(oc.meanCostPerTurn).toBeCloseTo(0.015);
  });

  test("produces pairwise deltas for 2 harnesses", () => {
    const store = new Store();
    seedSession(store, "oc-1", { harness: "opencode", costTotal: 0.01 });
    seedTurn(store, { sessionId: "oc-1", cost: 0.01 });
    seedSession(store, "vs-1", { harness: "vscode", costTotal: 0.05 });
    seedTurn(store, { sessionId: "vs-1", cost: 0.05 });

    const r = analyzeCompare(store);
    expect(r.pairwiseDeltas.length).toBe(1);
    const delta = r.pairwiseDeltas[0]!;
    expect([delta.from, delta.to]).toContain("opencode");
    expect([delta.from, delta.to]).toContain("vscode");
  });
});

// ── runProfilers integration ──────────────────────────────────────────────────

describe("runProfilers", () => {
  test("returns empty array for unknown session", async () => {
    const store = new Store();
    const insights = await runProfilers("no-such", store);
    expect(insights).toHaveLength(0);
  });

  test("persists generated insights to store", async () => {
    const store = new Store();
    const session = seedSession(store, "sess-1");
    const turn = seedTurn(store, { sessionId: "sess-1" });
    // Low cache read → will trigger insight
    seedLlmCall(store, turn.id, { promptTokens: 1000, cacheReadTokens: 20 });
    seedLlmCall(store, turn.id, { promptTokens: 1000, cacheReadTokens: 20 });

    void session;

    await runProfilers("sess-1", store);
    const stored = store.listInsights("session", "sess-1");
    expect(stored.length).toBeGreaterThan(0);
  });
});
