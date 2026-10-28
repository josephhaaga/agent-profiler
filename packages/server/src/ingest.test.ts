import { afterAll, expect, test } from "bun:test";

const serverProcess = Bun.spawn(["bun", "run", "packages/server/src/index.ts"], {
  env: { ...process.env, AGENT_PROFILER_PORT: "0", AGENT_PROFILER_DB_PATH: ":memory:" },
  stdout: "pipe",
  stderr: "pipe",
});
const stdoutReader = serverProcess.stdout.getReader();
let stdout = "";
while (!stdout.includes("agent-profiler listening on")) {
  const chunk = await stdoutReader.read();
  if (chunk.done) throw new Error(await new Response(serverProcess.stderr).text());
  stdout += new TextDecoder().decode(chunk.value);
}
const baseUrl = stdout.match(/http:\/\/localhost:\d+/)![0];
afterAll(async () => {
  serverProcess.kill();
  await serverProcess.exited;
});

async function request(path: string, body?: unknown): Promise<any> {
  const response = await fetch(baseUrl + path, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(body === undefined ? 200 : 204);
  return response.status === 204 ? undefined : response.json();
}

function span(
  id: string,
  parentSpanId: string | undefined,
  name: string,
  kind: "CHAIN" | "LLM" | "TOOL",
  attributes: Array<{ key: string; value: Record<string, unknown> }>,
  status?: { code: number | string; message?: string },
) {
  return {
    traceId: "trace_http",
    spanId: id,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001000000000",
    attributes: [
      { key: "openinference.span.kind", value: { stringValue: kind } },
      { key: "session.id", value: { stringValue: "session_http" } },
      ...attributes,
    ],
    ...(status ? { status } : {}),
  };
}

function payload(spans: ReturnType<typeof span>[]) {
  return { resourceSpans: [{ scopeSpans: [{ spans }] }] };
}

const turnSpan = span("turn_http", "session_http", "turn", "CHAIN", [
  { key: "input.value", value: { stringValue: "do the task" } },
  { key: "output.value", value: { stringValue: "done" } },
]);
const llmSpan = span("llm_http", "turn_http", "model call", "LLM", [
  { key: "llm.model_name", value: { stringValue: "fixture-model" } },
  { key: "llm.token_count.prompt", value: { intValue: 42 } },
  { key: "llm.token_count.completion", value: { intValue: 7 } },
]);
const toolSpan = span("tool_http", "turn_http", "read", "TOOL", [
  { key: "tool.name", value: { stringValue: "read" } },
]);
const sessionSpan = span("session_http", undefined, "session", "CHAIN", []);

test("late child spans refresh turn totals and coverage before the session", async () => {
  await request("/v1/traces", payload([sessionSpan, turnSpan]));
  const stream = await fetch(baseUrl + "/api/stream");
  const streamReader = stream.body!.getReader();
  await streamReader.read(); // heartbeat
  await request("/v1/traces", payload([llmSpan, toolSpan]));
  await request("/v1/traces", payload([llmSpan, toolSpan]));

  let streamText = "";
  while ((streamText.match(/"type":"session"/g)?.length ?? 0) < 2) {
    const chunk = await streamReader.read();
    if (chunk.done) throw new Error("SSE stream closed before updated session event");
    streamText += new TextDecoder().decode(chunk.value);
  }
  await streamReader.cancel();
  const eventTypes = streamText.split("\n\n").flatMap((event) => {
    const line = event.split("\n").find((part) => part.startsWith("data: "));
    return line ? [JSON.parse(line.slice(6)).type as string] : [];
  });
  expect(eventTypes.lastIndexOf("turn")).toBeLessThan(eventTypes.lastIndexOf("session"));

  const { turn } = await request("/api/turns/turn_http");
  const { llmCalls } = await request("/api/turns/turn_http/llm-calls");
  const { toolCalls } = await request("/api/turns/turn_http/tool-calls");
  expect(llmCalls).toHaveLength(1);
  expect(toolCalls).toHaveLength(1);
  expect(turn).toMatchObject({
    llmRoundTrips: 1,
    promptTokens: 42,
    completionTokens: 7,
    reasoningTokens: null,
    cost: null,
  });
  expect(turn.capture.unknownMetrics).toContain("reasoningTokens");
  expect(turn.capture.unknownMetrics).toContain("cost");
});

test("OTLP explicit error overrides custom success and preserves status metadata", async () => {
  const failedTurn = span("turn_error", "session_http", "failed turn", "CHAIN", [
    { key: "status", value: { stringValue: "completed" } },
  ], { code: 2, message: "provider rejected request" });
  const failedTool = span("tool_error", "turn_error", "write", "TOOL", [
    { key: "status", value: { stringValue: "completed" } },
  ], { code: "STATUS_CODE_ERROR", message: "permission denied" });
  await request("/v1/traces", payload([failedTurn, failedTool]));

  const { turn } = await request("/api/turns/turn_error");
  const { toolCalls } = await request("/api/turns/turn_error/tool-calls");
  expect(turn.endSignal).toBe("error");
  expect(turn.status).toBe("ERROR");
  expect(turn.capture).toMatchObject({ statusCode: "STATUS_CODE_ERROR", statusMessage: "provider rejected request" });
  expect(toolCalls[0].status).toBe("ERROR");
  expect(toolCalls[0].capture).toMatchObject({ statusCode: "STATUS_CODE_ERROR", statusMessage: "permission denied" });
});

test("OTLP OK is success, while unset status does not claim an outcome", async () => {
  const okTurn = span("turn_ok", "session_http", "ok turn", "CHAIN", [], { code: 1, message: "finished" });
  const unsetTurn = span("turn_unset", "session_http", "unset turn", "CHAIN", [], { code: 0 });
  await request("/v1/traces", payload([okTurn, unsetTurn]));

  const { turn: ok } = await request("/api/turns/turn_ok");
  const { turn: unset } = await request("/api/turns/turn_unset");
  expect(ok.endSignal).toBe("completed");
  expect(ok.status).toBe("OK");
  expect(ok.capture).toMatchObject({ statusCode: "STATUS_CODE_OK", statusMessage: "finished" });
  expect(unset.endSignal).toBeUndefined();
});

test("sparse span replays preserve known errors; a later explicit OK reconciles them", async () => {
  const failedTurn = span("turn_replay", "session_http", "turn", "CHAIN", [], { code: 2, message: "turn failed" });
  const failedTool = span("tool_replay", "turn_replay", "write", "TOOL", [], { code: 2, message: "tool failed" });
  const failedLlm = span("llm_replay", "turn_replay", "model call", "LLM", [
    { key: "llm.model_name", value: { stringValue: "fixture-model" } },
  ], { code: 2, message: "model failed" });
  await request("/v1/traces", payload([failedTurn, failedTool, failedLlm]));

  const sparseTurn = span("turn_replay", "session_http", "turn", "CHAIN", []);
  const sparseTool = span("tool_replay", "turn_replay", "write", "TOOL", []);
  const sparseLlm = span("llm_replay", "turn_replay", "model call", "LLM", [
    { key: "llm.model_name", value: { stringValue: "fixture-model" } },
  ]);
  await request("/v1/traces", payload([sparseTurn, sparseTool, sparseLlm]));

  const { turn: stillFailed } = await request("/api/turns/turn_replay");
  const { toolCalls: stillFailedTools } = await request("/api/turns/turn_replay/tool-calls");
  const { llmCalls: stillFailedLlm } = await request("/api/turns/turn_replay/llm-calls");
  expect(stillFailed).toMatchObject({ status: "ERROR", endSignal: "error" });
  expect(stillFailed.capture).toMatchObject({ statusCode: "STATUS_CODE_ERROR", statusMessage: "turn failed" });
  expect(stillFailedTools[0]).toMatchObject({ status: "ERROR", capture: { statusCode: "STATUS_CODE_ERROR", statusMessage: "tool failed" } });
  expect(stillFailedLlm[0].capture).toMatchObject({ statusCode: "STATUS_CODE_ERROR", statusMessage: "model failed" });

  const recoveredTurn = span("turn_replay", "session_http", "turn", "CHAIN", [], { code: 1, message: "recovered" });
  const recoveredTool = span("tool_replay", "turn_replay", "write", "TOOL", [], { code: 1, message: "recovered" });
  const recoveredLlm = span("llm_replay", "turn_replay", "model call", "LLM", [
    { key: "llm.model_name", value: { stringValue: "fixture-model" } },
  ], { code: 1, message: "recovered" });
  await request("/v1/traces", payload([recoveredTurn, recoveredTool, recoveredLlm]));

  const { turn: recovered } = await request("/api/turns/turn_replay");
  const { toolCalls: recoveredTools } = await request("/api/turns/turn_replay/tool-calls");
  const { llmCalls: recoveredLlmCalls } = await request("/api/turns/turn_replay/llm-calls");
  expect(recovered).toMatchObject({ status: "OK", endSignal: "completed", capture: { statusCode: "STATUS_CODE_OK", statusMessage: "recovered" } });
  expect(recoveredTools[0]).toMatchObject({ status: "OK", capture: { statusCode: "STATUS_CODE_OK", statusMessage: "recovered" } });
  expect(recoveredLlmCalls[0].capture).toMatchObject({ statusCode: "STATUS_CODE_OK", statusMessage: "recovered" });
});

test("UNSET honors explicit end_signal; contradictory OTLP OK and custom error stays error", async () => {
  const stopped = span("turn_stopped", "session_http", "stopped", "CHAIN", [
    { key: "end_signal", value: { stringValue: "user_stopped" } },
  ], { code: "STATUS_CODE_UNSET" });
  const contradiction = span("turn_contradiction", "session_http", "contradiction", "CHAIN", [
    { key: "status", value: { stringValue: "ERROR" } },
  ], { code: "STATUS_CODE_OK", message: "OTLP reports OK" });
  await request("/v1/traces", payload([stopped, contradiction]));

  const { turn: stoppedTurn } = await request("/api/turns/turn_stopped");
  const { turn: contradictoryTurn } = await request("/api/turns/turn_contradiction");
  expect(stoppedTurn.endSignal).toBe("user_stopped");
  expect(contradictoryTurn).toMatchObject({ status: "ERROR", endSignal: "error" });
  expect(contradictoryTurn.capture).toMatchObject({
    statusCode: "STATUS_CODE_ERROR",
    reportedStatusCode: "STATUS_CODE_OK",
    statusMessage: "OTLP reports OK",
    customStatus: "ERROR",
  });
});
