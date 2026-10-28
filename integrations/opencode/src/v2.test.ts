import { describe, test, expect } from "bun:test";
import { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { V2Adapter, type PublicEvent } from "./v2.js";
import { TraceBuilder } from "./trace-builder.js";
import { CONFIG_DEFAULTS, type ResolvedConfig } from "./config.js";

const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 80, write: 0 } };
function harness(hideInputs = false, overrides: Partial<ResolvedConfig> = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const config = { ...CONFIG_DEFAULTS, hideInputs, ...overrides };
  const builder = new TraceBuilder({ tracer: provider.getTracer("v2-test"), config });
  const adapter = new V2Adapter(builder, config);
  const event = (type: string, data: object) => adapter.onEvent({ type, data, created: Date.now() } as PublicEvent);
  const request = (sessionID: string, text: string, messageID = `user-${sessionID}`, historyCount = 1) => {
    adapter.onUser(sessionID, { id: messageID, text, time: { created: Date.now() } });
    adapter.onContext({ sessionID, agent: "build", model: { providerID: "openai", id: "test-model" },
      system: [{ type: "text", text: "System instructions" }],
      messages: Array.from({ length: historyCount }, () => ({ role: "user", content: [{ type: "text", text }] })),
      tools: { shell: { description: "Run a command", input: { type: "object" } } }, options: {},
    } as unknown as SessionContext);
  };
  const start = (sessionID: string, assistantMessageID: string) => event("session.step.started", {
    sessionID, assistantMessageID, agent: "build", model: { id: "test-model", providerID: "openai" }, started: Date.now(),
  });
  const end = (sessionID: string, assistantMessageID: string, finish = "stop") => event("session.step.ended", {
    sessionID, assistantMessageID, finish, tokens, cost: 0.01,
  });
  return { exporter, provider, builder, adapter, event, request, start, end };
}

describe("OpenCode V2 tracing", () => {
  test("output redaction cannot leak through subsequent LLM input capture or prompt enrichment", async () => {
    for (const config of [{ hideOutputs: true }, { hideOutputMessages: true }, { redactToolOutputs: ["shell"] }]) {
      const h = harness(false, config);
      h.request("a", "ordinary user request");
      h.adapter.onContext({ sessionID: "a", agent: "build", model: { providerID: "openai", id: "test-model" },
        system: [{ type: "text", text: "instructions" }], messages: [{ role: "tool", content: [{ type: "text", text: "synthetic-secret-sentinel" }] }], tools: {}, options: {},
      } as unknown as SessionContext);
      h.start("a", "step-a"); h.end("a", "step-a"); h.builder.closeAll();
      const llm = h.exporter.getFinishedSpans().find(s => s.attributes["openinference.span.kind"] === "LLM")!;
      expect(llm.attributes["llm.input_messages"]).toBeUndefined();
      expect(llm.attributes["prompt.segments"]).toBeUndefined();
      expect(JSON.stringify(llm.attributes)).not.toContain("synthetic-secret-sentinel");
      await h.provider.shutdown();
    }
  });
  test("long histories do not exhaust the span attribute budget before usage and output arrive", async () => {
    const h = harness();
    h.request("a", "long-history", "user-a", 100);
    h.start("a", "step-a");
    h.event("session.text.ended", { sessionID: "a", assistantMessageID: "step-a", ordinal: 0, text: "answer" });
    h.end("a", "step-a"); h.builder.closeAll();
    const llm = h.exporter.getFinishedSpans().find((span) => span.attributes["openinference.span.kind"] === "LLM")!;
    expect(llm.attributes["llm.token_count.prompt"]).toBe(180);
    expect(llm.attributes["llm.token_count.completion"]).toBe(20);
    expect(llm.attributes["llm.finish_reason"]).toBe("stop");
    expect(llm.attributes["llm.output_messages"]).toContain("answer");
    expect(JSON.parse(String(llm.attributes["llm.input_messages"]))).toHaveLength(101);
    expect(llm.attributes["prompt.segments"]).toBeDefined();
    await h.provider.shutdown();
  });

  test("captures inputs, outputs, usage, and enriched attributes through a tool loop", async () => {
    const h = harness();
    h.request("session-a", "Inspect the project");
    h.start("session-a", "step-1");
    h.end("session-a", "step-1", "tool-calls");
    h.builder.onToolBefore({ sessionID: "session-a", tool: "shell", callID: "call-1" }, { args: { command: "pwd" } });
    h.builder.onToolAfter({ sessionID: "session-a", tool: "shell", callID: "call-1", args: {} }, { output: "/project" });
    h.request("session-a", "Inspect the project");
    h.start("session-a", "step-2");
    h.event("session.text.ended", { sessionID: "session-a", assistantMessageID: "step-2", ordinal: 0, text: "Done" });
    h.end("session-a", "step-2");
    h.event("session.execution.succeeded", { sessionID: "session-a" });
    await h.provider.forceFlush();
    const spans = h.exporter.getFinishedSpans();
    const llms = spans.filter((span) => span.attributes["openinference.span.kind"] === "LLM");
    const turns = spans.filter((span) => span.name.startsWith("turn "));
    expect(llms).toHaveLength(2);
    expect(turns).toHaveLength(1);
    expect(llms[0]!.attributes["llm.token_count.prompt"]).toBe(180);
    expect(llms[0]!.attributes["llm.tools.definitions"]).toContain("shell");
    expect(llms[0]!.attributes["prompt.segments"]).toContain("system");
    expect(llms[1]!.attributes["llm.output_messages"]).toContain("Done");
    expect(h.builder.openSessionCount).toBe(0);
    await h.provider.shutdown();
  });

  test("interleaved sessions never share request content", async () => {
    const h = harness();
    h.request("a", "only-a"); h.request("b", "only-b");
    h.start("b", "step-b"); h.start("a", "step-a");
    h.end("a", "step-a"); h.end("b", "step-b");
    h.builder.closeAll();
    const spans = h.exporter.getFinishedSpans().filter((span) => span.attributes["openinference.span.kind"] === "LLM");
    for (const span of spans) {
      const content = String(span.attributes["llm.input_messages"]);
      expect(content).toContain(`only-${span.attributes["session.id"]}`);
      expect(content).not.toContain(span.attributes["session.id"] === "a" ? "only-b" : "only-a");
    }
    await h.provider.shutdown();
  });

  test("handles step start before context on resumed sessions", async () => {
    const h = harness();
    h.start("a", "step-a");
    h.request("a", "resumed");
    h.end("a", "step-a");
    h.builder.closeAll();
    expect(h.exporter.getFinishedSpans().filter((span) => span.attributes["openinference.span.kind"] === "LLM")).toHaveLength(1);
    await h.provider.shutdown();
  });

  test("hideInputs suppresses aggregate inputs and prompt enrichment", async () => {
    const h = harness(true);
    h.request("a", "private-input"); h.start("a", "step-a"); h.end("a", "step-a");
    h.builder.closeAll();
    const llm = h.exporter.getFinishedSpans().find((span) => span.attributes["openinference.span.kind"] === "LLM")!;
    expect(llm.attributes["llm.input_messages"]).toBeUndefined();
    expect(llm.attributes["prompt.segments"]).toBeUndefined();
    expect(llm.attributes["llm.tools.definitions"]).toBeUndefined();
    await h.provider.shutdown();
  });

  test("interruption closes unfinished spans instead of leaving a draining session", async () => {
    const h = harness();
    h.request("a", "interrupted"); h.start("a", "step-a");
    h.event("session.execution.interrupted", { sessionID: "a", reason: "user" });
    expect(h.builder.openSessionCount).toBe(0);
    const llm = h.exporter.getFinishedSpans().find((span) => span.attributes["openinference.span.kind"] === "LLM")!;
    expect(llm.attributes["opencode.incomplete"]).toBe(true);
    expect(llm.status.code).toBe(2);
    await h.provider.shutdown();
  });

  test("tool failures have an explicit collector-visible error status", async () => {
    const h = harness();
    h.request("a", "fails"); h.start("a", "step-a");
    h.builder.onToolBefore({ sessionID: "a", tool: "shell", callID: "failed-tool" }, { args: {} });
    h.builder.onToolAfter({ sessionID: "a", tool: "shell", callID: "failed-tool", args: {} }, { output: "failed", errored: true });
    h.end("a", "step-a"); h.builder.closeAll();
    const tool = h.exporter.getFinishedSpans().find((span) => span.attributes["openinference.span.kind"] === "TOOL")!;
    expect(tool.attributes["status"]).toBe("ERROR");
    expect(tool.status.code).toBe(2);
    await h.provider.shutdown();
  });

  test("provider streamed boundary excludes tool settlement from model latency", async () => {
    const h = harness();
    h.request("a", "timing"); h.start("a", "step-a");
    const streamed = Date.now();
    h.adapter.onEvent({ type: "session.step.streamed", created: streamed, data: { sessionID: "a", assistantMessageID: "step-a" } } as PublicEvent);
    h.adapter.onEvent({ type: "session.step.ended", created: streamed + 5000,
      data: { sessionID: "a", assistantMessageID: "step-a", finish: "stop", tokens, cost: 0 } } as PublicEvent);
    h.builder.closeAll();
    const llm = h.exporter.getFinishedSpans().find((span) => span.attributes["openinference.span.kind"] === "LLM")!;
    const endedMs = llm.endTime[0] * 1000 + llm.endTime[1] / 1e6;
    expect(Math.abs(endedMs - streamed)).toBeLessThan(2);
    await h.provider.shutdown();
  });
});
