import { describe, expect, test, beforeEach } from "bun:test";
import { Store } from "../src/index";
import type { SessionRecord, TurnRecord, LlmCallRecord, ToolCallRecord, Insight } from "@agent-profiler/schema";

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess-1",
    harness: "opencode",
    agent: "test-agent",
    model: "claude-opus-4-5",
    startedAt: "2024-01-01T00:00:00.000Z",
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
}

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: "turn-1",
    sessionId: "sess-1",
    idx: 0,
    userText: "Hello",
    assistantText: "Hi there",
    startedAt: "2024-01-01T00:00:01.000Z",
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
}

function makeLlmCall(overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    id: "llm-1",
    turnId: "turn-1",
    sessionId: "sess-1",
    model: "claude-opus-4-5",
    provider: "anthropic",
    promptTokens: 1000,
    completionTokens: 100,
    reasoningTokens: 0,
    cacheReadTokens: 800,
    cacheWriteTokens: 200,
    cost: 0.01,
    latencyMs: 2500,
    finishReason: "stop",
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "tool-1",
    turnId: "turn-1",
    sessionId: "sess-1",
    name: "read",
    kind: "builtin",
    latencyMs: 120,
    tokensOutEst: 50,
    status: "ok",
    ...overrides,
  };
}

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(); // in-memory
  });

  // ── Sessions ───────────────────────────────────────────────────────────────

  test("upsertSession + getSession round-trips camelCase correctly", () => {
    store.upsertSession(makeSession());
    const s = store.getSession("sess-1");
    expect(s).toBeDefined();
    expect(s!.id).toBe("sess-1");
    expect(s!.harness).toBe("opencode");
    expect(s!.agent).toBe("test-agent");
    expect(s!.promptTokens).toBe(1000);
    expect(s!.cacheReadTokens).toBe(800);
    expect(s!.costTotal).toBe(0.01);
  });

  test("listSessions returns camelCase fields", () => {
    store.upsertSession(makeSession({ id: "sess-a" }));
    store.upsertSession(makeSession({ id: "sess-b" }));
    const list = store.listSessions();
    expect(list.length).toBe(2);
    // spot-check camelCase
    expect(typeof list[0]!.turnCount).toBe("number");
    expect(typeof list[0]!.llmCallCount).toBe("number");
    expect(typeof list[0]!.cacheWriteTokens).toBe("number");
  });

  test("upsertSession updates on conflict", () => {
    store.upsertSession(makeSession({ costTotal: 0.01 }));
    store.upsertSession(makeSession({ costTotal: 0.99 }));
    expect(store.getSession("sess-1")!.costTotal).toBe(0.99);
  });

  test("getSession returns undefined for unknown id", () => {
    expect(store.getSession("nope")).toBeUndefined();
  });

  // ── Turns ──────────────────────────────────────────────────────────────────

  test("upsertTurn + listTurns + getTurn", () => {
    store.upsertSession(makeSession());
    store.upsertTurn(makeTurn());
    const turns = store.listTurns("sess-1");
    expect(turns.length).toBe(1);
    expect(turns[0]!.userText).toBe("Hello");
    expect(turns[0]!.endSignal).toBe("completed");
    expect(turns[0]!.cacheReadTokens).toBe(800);

    const t = store.getTurn("turn-1");
    expect(t!.sessionId).toBe("sess-1");
  });

  test("listTurns returns [] for unknown session", () => {
    expect(store.listTurns("no-such")).toHaveLength(0);
  });

  // ── LLM Calls ──────────────────────────────────────────────────────────────

  test("upsertLlmCall + listLlmCalls", () => {
    store.upsertSession(makeSession());
    store.upsertTurn(makeTurn());
    store.upsertLlmCall(makeLlmCall());
    const calls = store.listLlmCalls("turn-1");
    expect(calls.length).toBe(1);
    expect(calls[0]!.model).toBe("claude-opus-4-5");
    expect(calls[0]!.cacheReadTokens).toBe(800);
    expect(calls[0]!.latencyMs).toBe(2500);
  });

  test("listLlmCallsBySession returns all calls for session", () => {
    store.upsertSession(makeSession());
    store.upsertTurn(makeTurn({ id: "t1" }));
    store.upsertTurn(makeTurn({ id: "t2", idx: 1 }));
    store.upsertLlmCall(makeLlmCall({ id: "l1", turnId: "t1" }));
    store.upsertLlmCall(makeLlmCall({ id: "l2", turnId: "t2" }));
    expect(store.listLlmCallsBySession("sess-1")).toHaveLength(2);
  });

  // ── Tool Calls ─────────────────────────────────────────────────────────────

  test("upsertToolCall + listToolCalls", () => {
    store.upsertSession(makeSession());
    store.upsertTurn(makeTurn());
    store.upsertToolCall(makeToolCall({ name: "datadog_search", kind: "mcp", server: "datadog" }));
    const tcs = store.listToolCalls("turn-1");
    expect(tcs.length).toBe(1);
    expect(tcs[0]!.name).toBe("datadog_search");
    expect(tcs[0]!.kind).toBe("mcp");
    expect(tcs[0]!.server).toBe("datadog");
  });

  // ── Prompt Segments ────────────────────────────────────────────────────────

  test("upsertPromptSegments + listPromptSegments", () => {
    store.upsertSession(makeSession());
    store.upsertTurn(makeTurn());
    store.upsertLlmCall(makeLlmCall());
    store.upsertPromptSegments([
      { llmCallId: "llm-1", ord: 0, sourceKind: "system", sourceName: "instructions", charLen: 500, tokenEst: 125, sha256: "abc", isStatic: true },
      { llmCallId: "llm-1", ord: 1, sourceKind: "tool", sourceName: "read", charLen: 200, tokenEst: 50, sha256: "def", isStatic: false },
    ]);
    const segs = store.listPromptSegments("llm-1");
    expect(segs).toHaveLength(2);
    expect(segs[0]!.sourceKind).toBe("system");
    expect(segs[0]!.isStatic).toBe(true);
    expect(segs[1]!.isStatic).toBe(false);
  });

  // ── Blobs ──────────────────────────────────────────────────────────────────

  test("putBlob + getBlob", () => {
    store.putBlob("ref1", "application/json", '{"hello": "world"}');
    const b = store.getBlob("ref1");
    expect(b!.mime).toBe("application/json");
    expect(b!.bytes).toBe('{"hello": "world"}');
    expect(store.getBlob("missing")).toBeUndefined();
  });

  // ── Insights ───────────────────────────────────────────────────────────────

  test("upsertInsight + listInsights with scope filter", () => {
    const ins: Insight = {
      id: "ins-1",
      scopeType: "session",
      scopeId: "sess-1",
      kind: "cache.low_hit_ratio",
      severity: "warn",
      title: "Low cache hit",
      summary: "Only 10% cache hits",
      evidence: { hitRatio: 0.1 },
      createdAt: new Date().toISOString(),
    };
    store.upsertInsight(ins);
    const all = store.listInsights();
    expect(all.length).toBe(1);
    expect(all[0]!.kind).toBe("cache.low_hit_ratio");
    expect(all[0]!.evidence).toEqual({ hitRatio: 0.1 });

    const scoped = store.listInsights("session", "sess-1");
    expect(scoped.length).toBe(1);
    const wrong = store.listInsights("session", "other");
    expect(wrong.length).toBe(0);
  });

  // ── Tool attribution ───────────────────────────────────────────────────────

  test("getToolAttribution aggregates correctly", () => {
    store.upsertSession(makeSession());
    store.upsertTurn(makeTurn());
    store.upsertToolCall(makeToolCall({ id: "tc-1", name: "read", kind: "builtin", latencyMs: 100, tokensOutEst: 20 }));
    store.upsertToolCall(makeToolCall({ id: "tc-2", name: "read", kind: "builtin", latencyMs: 200, tokensOutEst: 30 }));
    store.upsertToolCall(makeToolCall({ id: "tc-3", name: "datadog_search", kind: "mcp", latencyMs: 500, tokensOutEst: 100 }));

    const attr = store.getToolAttribution("sess-1");
    expect(attr.length).toBe(2);
    // sorted by total_latency_ms desc
    expect(attr[0]!.name).toBe("datadog_search");
    expect(attr[0]!.call_count).toBe(1);
    expect(attr[0]!.total_latency_ms).toBe(500);
    expect(attr[1]!.name).toBe("read");
    expect(attr[1]!.call_count).toBe(2);
    expect(attr[1]!.total_latency_ms).toBe(300);
    expect(attr[1]!.total_tokens_out).toBe(50);
  });
});
