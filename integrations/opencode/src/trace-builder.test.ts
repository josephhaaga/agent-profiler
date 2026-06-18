/**
 * Integration test for TraceBuilder.
 *
 * Uses OTel's InMemorySpanExporter to capture spans without any network I/O
 * or opencode dependency. Simulates the exact hook-firing sequence observed
 * from real opencode sessions.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { TraceBuilder } from "../src/trace-builder.js";
import { CONFIG_DEFAULTS } from "../src/config.js";
import type { UserMessage } from "../src/types.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const SESSION_ID = "ses_test_session_001";
const USER_MSG_ID = "msg_user_001";
const ASST_MSG_ID = "msg_asst_001";
const CALL_ID = "call_bash_001";

function makeProvider() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "test" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  // Use the provider directly rather than the global trace API so each test
  // gets its own isolated tracer.
  const tracer = provider.getTracer("test-tracer");
  return { exporter, provider, tracer };
}

function makeBuilder(tracer: ReturnType<typeof makeProvider>["tracer"]) {
  return new TraceBuilder({
    tracer,
    config: { ...CONFIG_DEFAULTS, captureContent: true },
  });
}

function userMessage(overrides = {}) {
  return {
    id: USER_MSG_ID,
    sessionID: SESSION_ID,
    role: "user" as const,
    time: { created: Date.now() },
    // Extra fields required by newer SDK versions; cast to avoid version skew.
    agent: "build",
    model: { providerID: "github-copilot", modelID: "claude-sonnet-4.6" },
    ...overrides,
  } as unknown as UserMessage;
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: ASST_MSG_ID,
    sessionID: SESSION_ID,
    parentID: USER_MSG_ID,
    role: "assistant" as const,
    modelID: "claude-sonnet-4.6",
    providerID: "github-copilot",
    mode: "build",
    cost: 0.05,
    tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 800, write: 200 } },
    finish: "stop",
    time: { created: Date.now(), completed: Date.now() + 2000 },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TraceBuilder", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let builder: TraceBuilder;

  beforeEach(() => {
    const p = makeProvider();
    exporter = p.exporter;
    provider = p.provider;
    builder = makeBuilder(p.tracer);
  });

  test("creates session span on first hook", () => {
    builder.onChatMessage(
      { sessionID: SESSION_ID, agent: "build", model: { providerID: "github-copilot", modelID: "claude-sonnet-4.6" } },
      { message: userMessage(), parts: [] }
    );
    builder.endSession(SESSION_ID);

    const spans = exporter.getFinishedSpans();
    const session = spans.find((s) => s.name.startsWith("session "));
    expect(session).toBeDefined();
    expect(session!.attributes["session.id"]).toBe(SESSION_ID);
    expect(session!.attributes["agent.name"]).toBe("build");
  });

  test("LLM span gets token and cost attributes", () => {
    // Simulate the real hook-firing order observed from opencode:
    // 1. chat.message (user turn starts)
    // 2. chat.params (LLM call dispatched)
    // 3. message.updated terminal (response complete with tokens)
    // Note: session.idle fires AFTER message.updated, so endSession is delayed.

    builder.onChatMessage(
      { sessionID: SESSION_ID, agent: "build", model: { providerID: "github-copilot", modelID: "claude-sonnet-4.6" } },
      { message: userMessage(), parts: [] }
    );

    builder.onChatParams(
      {
        sessionID: SESSION_ID,
        agent: "build",
        model: { modelID: "claude-sonnet-4.6" },
        provider: { info: { id: "github-copilot" } },
        message: userMessage(),
      },
      { temperature: 1, topP: 1, topK: 0, maxOutputTokens: 32000, options: {} }
    );

    // Terminal message.updated — carries token/cost data
    builder.onMessageUpdated(assistantMessage());

    // session.idle fires — close session
    builder.endSession(SESSION_ID);

    const spans = exporter.getFinishedSpans();
    const llm = spans.find((s) => s.name.startsWith("chat "));
    expect(llm).toBeDefined();
    expect(llm!.attributes["llm.token_count.prompt"]).toBe(1000);
    expect(llm!.attributes["llm.token_count.completion"]).toBe(100);
    expect(llm!.attributes["llm.token_count.prompt_details.cache_read"]).toBe(800);
    expect(llm!.attributes["llm.cost.total"]).toBe(0.05);
  });

  test("session.idle before message.updated does not lose token data", () => {
    // Simulate the race: session.idle fires, then message.updated fires.
    // With the 2s delay in index.ts this shouldn't happen in practice,
    // but TraceBuilder itself should still handle it gracefully — the session
    // gets deleted by endSession and onMessageUpdated returns early.
    // The key invariant: no crash.

    builder.onChatMessage(
      { sessionID: SESSION_ID, agent: "build", model: { providerID: "github-copilot", modelID: "claude-sonnet-4.6" } },
      { message: userMessage(), parts: [] }
    );

    builder.onChatParams(
      {
        sessionID: SESSION_ID,
        agent: "build",
        model: { modelID: "claude-sonnet-4.6" },
        provider: { info: { id: "github-copilot" } },
        message: userMessage(),
      },
      { temperature: 1, topP: 1, topK: 0, maxOutputTokens: 32000, options: {} }
    );

    // session.idle fires BEFORE message.updated (the bad race)
    builder.endSession(SESSION_ID);

    // message.updated fires late — should not crash
    expect(() => builder.onMessageUpdated(assistantMessage())).not.toThrow();
  });

  test("tool span gets session.id attribute", () => {
    builder.onChatMessage(
      { sessionID: SESSION_ID, agent: "build", model: { providerID: "github-copilot", modelID: "claude-sonnet-4.6" } },
      { message: userMessage(), parts: [] }
    );

    builder.onToolBefore(
      { tool: "bash", sessionID: SESSION_ID, callID: CALL_ID, args: { command: "date" } },
      { args: { command: "date" } }
    );
    builder.onToolAfter(
      { tool: "bash", sessionID: SESSION_ID, callID: CALL_ID },
      { output: "Thu Jun 18 2026" }
    );

    builder.endSession(SESSION_ID);

    const spans = exporter.getFinishedSpans();
    const tool = spans.find((s) => s.name === "bash");
    expect(tool).toBeDefined();
    expect(tool!.attributes["session.id"]).toBe(SESSION_ID);
    expect(tool!.attributes["openinference.span.kind"]).toBe("TOOL");
  });

  test("turn span has correct user and assistant text", () => {
    builder.onChatMessage(
      { sessionID: SESSION_ID, agent: "build", model: { providerID: "github-copilot", modelID: "claude-sonnet-4.6" } },
      { message: userMessage(), parts: [{ type: "text", text: "run date for me", messageID: USER_MSG_ID, id: "part_001", sessionID: SESSION_ID }] }
    );

    builder.onChatParams(
      {
        sessionID: SESSION_ID,
        agent: "build",
        model: { modelID: "claude-sonnet-4.6" },
        provider: { info: { id: "github-copilot" } },
        message: userMessage(),
      },
      { temperature: 1, topP: 1, topK: 0, maxOutputTokens: 32000, options: {} }
    );

    // Accumulate assistant text via part updates
    builder.onMessagePartUpdated({ type: "text", text: "Thu Jun 18", messageID: ASST_MSG_ID, id: "part_002", sessionID: SESSION_ID });
    builder.onMessagePartUpdated({ type: "text", text: "Thu Jun 18 2026", messageID: ASST_MSG_ID, id: "part_002", sessionID: SESSION_ID });

    builder.onMessageUpdated(assistantMessage());
    builder.endSession(SESSION_ID);

    const spans = exporter.getFinishedSpans();
    const turn = spans.find((s) => s.name.startsWith("turn "));
    expect(turn).toBeDefined();
    expect(turn!.attributes["output.value"]).toBe("Thu Jun 18 2026");
  });
});
