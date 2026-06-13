import { describe, expect, test } from "bun:test";
import { ingestOtlpPayload, estimateTokens } from "../src/index";
import type { OtlpExportRequest } from "../src/index";
import { Store } from "@agent-profiler/store";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOtlpTrace(overrides: Partial<{
  sessionId: string;
  agentName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  toolName: string;
}> = {}): OtlpExportRequest {
  const o = {
    sessionId: "test-session",
    agentName: "test-agent",
    model: "claude-opus-4-5",
    promptTokens: 1200,
    completionTokens: 80,
    cacheRead: 1000,
    cacheWrite: 200,
    cost: 0.005,
    toolName: "read",
    ...overrides,
  };

  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "harness", value: { stringValue: "opencode" } },
        ],
      },
      scopeSpans: [{
        spans: [
          {
            traceId: "trace001",
            spanId: "session001",
            name: "CHAIN session",
            startTimeUnixNano: "1700000000000000000",
            endTimeUnixNano: "1700000060000000000",
            attributes: [
              { key: "openinference.span.kind", value: { stringValue: "CHAIN" } },
              { key: "session.id", value: { stringValue: o.sessionId } },
              { key: "agent.name", value: { stringValue: o.agentName } },
            ],
          },
          {
            traceId: "trace001",
            spanId: "turn001",
            parentSpanId: "session001",
            name: "CHAIN turn",
            startTimeUnixNano: "1700000001000000000",
            endTimeUnixNano: "1700000055000000000",
            attributes: [
              { key: "openinference.span.kind", value: { stringValue: "CHAIN" } },
              { key: "session.id", value: { stringValue: o.sessionId } },
              { key: "input.value", value: { stringValue: "What is 2+2?" } },
              { key: "output.value", value: { stringValue: "4" } },
            ],
          },
          {
            traceId: "trace001",
            spanId: "llm001",
            parentSpanId: "turn001",
            name: "LLM chat",
            startTimeUnixNano: "1700000002000000000",
            endTimeUnixNano: "1700000050000000000",
            attributes: [
              { key: "openinference.span.kind", value: { stringValue: "LLM" } },
              { key: "session.id", value: { stringValue: o.sessionId } },
              { key: "llm.model_name", value: { stringValue: o.model } },
              { key: "llm.provider", value: { stringValue: "anthropic" } },
              { key: "llm.token_count.prompt", value: { intValue: String(o.promptTokens) } },
              { key: "llm.token_count.completion", value: { intValue: String(o.completionTokens) } },
              { key: "llm.token_count.prompt_details.cache_read", value: { intValue: String(o.cacheRead) } },
              { key: "llm.token_count.prompt_details.cache_write", value: { intValue: String(o.cacheWrite) } },
              { key: "llm.cost.total", value: { doubleValue: o.cost } },
            ],
          },
          {
            traceId: "trace001",
            spanId: "tool001",
            parentSpanId: "turn001",
            name: "TOOL read",
            startTimeUnixNano: "1700000051000000000",
            endTimeUnixNano: "1700000054000000000",
            attributes: [
              { key: "openinference.span.kind", value: { stringValue: "TOOL" } },
              { key: "session.id", value: { stringValue: o.sessionId } },
              { key: "tool.name", value: { stringValue: o.toolName } },
              { key: "input.value", value: { stringValue: '{"path": "/foo"}' } },
              { key: "output.value", value: { stringValue: "file contents here" } },
              { key: "tag.tags", value: { arrayValue: { values: [{ stringValue: "tool" }, { stringValue: `tool:${o.toolName}` }] } } },
            ],
          },
        ],
      }],
    }],
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ingestOtlpPayload", () => {
  test("ingests session, turn, LLM call, and tool call", async () => {
    const store = new Store();
    const result = await ingestOtlpPayload(makeOtlpTrace(), store);

    expect(result.sessionsUpserted).toBe(1);
    expect(result.turnsUpserted).toBe(1);
    expect(result.llmCallsUpserted).toBe(1);
    expect(result.toolCallsUpserted).toBe(1);
  });

  test("session has correct aggregated token counts", async () => {
    const store = new Store();
    await ingestOtlpPayload(makeOtlpTrace({ promptTokens: 1200, completionTokens: 80, cacheRead: 1000 }), store);

    const session = store.getSession("test-session");
    expect(session).toBeDefined();
    expect(session!.promptTokens).toBe(1200);
    expect(session!.completionTokens).toBe(80);
    expect(session!.cacheReadTokens).toBe(1000);
    expect(session!.cacheWriteTokens).toBe(200);
  });

  test("session harness is picked up from resource attributes", async () => {
    const store = new Store();
    await ingestOtlpPayload(makeOtlpTrace(), store);
    expect(store.getSession("test-session")!.harness).toBe("opencode");
  });

  test("session agent is picked up from span attribute", async () => {
    const store = new Store();
    await ingestOtlpPayload(makeOtlpTrace({ agentName: "my-agent" }), store);
    expect(store.getSession("test-session")!.agent).toBe("my-agent");
  });

  test("turn has correct user/assistant text", async () => {
    const store = new Store();
    await ingestOtlpPayload(makeOtlpTrace(), store);
    const turns = store.listTurns("test-session");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userText).toBe("What is 2+2?");
    expect(turns[0]!.assistantText).toBe("4");
    expect(turns[0]!.endSignal).toBe("completed");
  });

  test("LLM call has correct token and cost fields", async () => {
    const store = new Store();
    await ingestOtlpPayload(makeOtlpTrace({ promptTokens: 500, completionTokens: 50, cost: 0.002 }), store);
    const turns = store.listTurns("test-session");
    const calls = store.listLlmCalls(turns[0]!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.promptTokens).toBe(500);
    expect(calls[0]!.completionTokens).toBe(50);
    expect(calls[0]!.cost).toBe(0.002);
    expect(calls[0]!.latencyMs).toBeGreaterThan(0);
  });

  test("tool call kind is inferred from tag.tags", async () => {
    const store = new Store();
    // make a trace with mcp tags
    const payload = makeOtlpTrace({ toolName: "datadog_search" });
    // Patch the tool span's tags to be mcp
    const toolSpan = payload.resourceSpans![0]!.scopeSpans![0]!.spans![3]!;
    toolSpan.attributes = toolSpan.attributes?.map((attr) => {
      if (attr.key === "tag.tags") {
        return { key: "tag.tags", value: { arrayValue: { values: [{ stringValue: "mcp" }, { stringValue: "mcp:datadog" }] } } };
      }
      return attr;
    });
    await ingestOtlpPayload(payload, store);
    const turns = store.listTurns("test-session");
    const toolCalls = store.listToolCalls(turns[0]!.id);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.kind).toBe("mcp");
    expect(toolCalls[0]!.server).toBe("datadog");
  });

  test("tool call stores args and output blobs", async () => {
    const store = new Store();
    await ingestOtlpPayload(makeOtlpTrace(), store);
    const turns = store.listTurns("test-session");
    const toolCalls = store.listToolCalls(turns[0]!.id);
    expect(toolCalls[0]!.argsRef).toBeDefined();
    expect(toolCalls[0]!.outputRef).toBeDefined();
    // Blobs should be retrievable
    const argsBlob = store.getBlob(toolCalls[0]!.argsRef!);
    expect(argsBlob!.bytes).toContain("/foo");
    const outputBlob = store.getBlob(toolCalls[0]!.outputRef!);
    expect(outputBlob!.bytes).toBe("file contents here");
  });

  test("SSE emitter is called for each ingested record", async () => {
    const store = new Store();
    const emitted: string[] = [];
    await ingestOtlpPayload(makeOtlpTrace(), store, (e) => emitted.push(e.type));
    expect(emitted).toContain("session");
    expect(emitted).toContain("turn");
    expect(emitted).toContain("llm_call");
    expect(emitted).toContain("tool_call");
  });

  test("handles empty resourceSpans gracefully", async () => {
    const store = new Store();
    const result = await ingestOtlpPayload({ resourceSpans: [] }, store);
    expect(result.sessionsUpserted).toBe(0);
  });

  test("handles malformed payload gracefully", async () => {
    const store = new Store();
    const result = await ingestOtlpPayload({} as OtlpExportRequest, store);
    expect(result.sessionsUpserted).toBe(0);
  });
});

describe("estimateTokens", () => {
  test("estimates ~4 chars per token", () => {
    // 400 chars → ~100 tokens
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  test("rounds up for partial tokens", () => {
    expect(estimateTokens("abc")).toBe(1); // 3 chars → ceil(3/4) = 1
    expect(estimateTokens("abcde")).toBe(2); // 5 chars → ceil(5/4) = 2
  });

  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
