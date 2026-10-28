import { afterAll, expect, test } from "bun:test";

const collector = Bun.spawn(["bun", "run", "packages/server/src/index.ts"], {
  env: { ...process.env, AGENT_PROFILER_PORT: "0", AGENT_PROFILER_DB_PATH: ":memory:" },
  stdout: "pipe", stderr: "pipe",
});
const reader = collector.stdout.getReader();
let output = "";
while (!output.includes("agent-profiler listening on")) {
  const chunk = await reader.read();
  if (chunk.done) throw new Error("Memory collector did not start");
  output += new TextDecoder().decode(chunk.value);
}
const base = output.match(/http:\/\/localhost:\d+/)![0];
afterAll(async () => { collector.kill(); await collector.exited; });

const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } });
function span(session: string, id: string, kind: string, attributes: ReturnType<typeof attr>[] = []) {
  return {
    traceId: `trace_${session}`, spanId: id, parentSpanId: `${session}-turn`, name: kind,
    startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000001000000000",
    attributes: [attr("session.id", session), attr("openinference.span.kind", kind), ...attributes],
  };
}
const payload = (...spans: unknown[]) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
async function post(body: unknown, path = "/v1/traces") {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function get(path: string): Promise<any> {
  const response = await fetch(base + path);
  expect(response.status).toBe(200);
  return response.json();
}

test("sparse live tool replays retain evidence, classification, known latency and error provenance", async () => {
  const tool = span("sparse-live", "sparse-tool", "TOOL", [
    attr("tool.name", "search"), attr("input.value", '{"query":"fixture"}'),
    attr("output.value", "recorded evidence"),
  ]);
  const enriched = { ...tool, attributes: [...tool.attributes, {
    key: "tag.tags", value: { arrayValue: { values: [{ stringValue: "mcp:fixture" }] } },
  }], status: { code: 2, message: "denied" } };
  expect((await post(payload(enriched))).status).toBe(204);
  const before = (await get("/api/turns/sparse-live-turn/tool-calls")).toolCalls[0];
  const replay = span("sparse-live", "sparse-tool", "TOOL");
  const { endTimeUnixNano, ...sparse } = replay;
  expect((await post(payload(sparse))).status).toBe(204);
  const after = (await get("/api/turns/sparse-live-turn/tool-calls")).toolCalls[0];
  expect(after).toEqual(before);
  expect(after).toMatchObject({ name: "search", kind: "mcp", server: "fixture", latencyMs: 1000,
    tokensOutEst: 5, status: "ERROR", capture: { statusCode: "STATUS_CODE_ERROR", statusMessage: "denied", unknownMetrics: [] } });
  expect(after.argsRef).toBeString();
  expect(after.outputRef).toBeString();
});

test("sparse live replay preserves import-seeded tool evidence; explicit empty values and zero replace it", async () => {
  const session = "ses_sparse_import";
  expect((await post({ info: { id: session, time: { created: 1000, updated: 3000 } }, messages: [
    { id: "user", type: "user", time: { created: 1000 }, text: "read" },
    { id: "assistant", type: "assistant", time: { created: 2000, completed: 3000 }, content: [
      { type: "tool", id: "tool", name: "read", time: { created: 2000, ran: 2100, completed: 2900 },
        state: { status: "error", input: { path: "fixture" }, error: "denied" } },
    ] },
  ] }, "/api/import/opencode")).status).toBe(200);
  const turnId = `opencode:${session}:user`;
  const before = (await get(`/api/turns/${turnId}/tool-calls`)).toolCalls[0];
  const live = { ...span(session, "import-live-tool", "TOOL", [attr("tool.id", "tool")]), parentSpanId: turnId };
  const { endTimeUnixNano, ...sparse } = live;
  expect((await post(payload(sparse))).status).toBe(204);
  const after = (await get(`/api/turns/${turnId}/tool-calls`)).toolCalls[0];
  expect(after).toMatchObject({ name: "read", kind: "other", argsRef: before.argsRef,
    outputRef: before.outputRef, tokensOutEst: before.tokensOutEst, latencyMs: 800, status: "ERROR",
    capture: { source: "live", partial: true, unknownMetrics: [] } });
  const explicit = { ...live, endTimeUnixNano: live.startTimeUnixNano, attributes: [...live.attributes,
    attr("tool.name", ""), attr("input.value", ""), attr("output.value", ""),
    { key: "tag.tags", value: { arrayValue: { values: [] } } },
  ] };
  expect((await post(payload(explicit))).status).toBe(204);
  const cleared = (await get(`/api/turns/${turnId}/tool-calls`)).toolCalls[0];
  expect(cleared).toMatchObject({ name: "", kind: "builtin", latencyMs: 0, tokensOutEst: 0,
    status: "ERROR", capture: { source: "live", partial: true, unknownMetrics: [] } });
  expect(cleared.argsRef).not.toBe(before.argsRef);
  expect(cleared.outputRef).not.toBe(before.outputRef);
  expect(await (await fetch(base + `/api/blobs/${cleared.outputRef}`)).text()).toBe("");
});

test("invalid usage never becomes a recorded zero, while numeric strings and zero remain valid", async () => {
  for (const [index, value] of ["oops", "-1", "1.5", "Infinity", ""].entries()) {
    const session = `invalid-usage-${index}`;
    const response = await post(payload(span(session, `${session}-llm`, "LLM", [
      attr("llm.token_count.prompt", value),
    ])));
    expect(response.status).toBe(400);
    expect((await fetch(base + `/api/sessions/${session}`)).status).toBe(404);
  }
  const valid = span("valid-usage", "valid-usage-llm", "LLM", [
    attr("llm.token_count.completion", "0"),
    attr("llm.cost.total", "0.125"),
  ]);
  expect((await post(payload({ ...valid, attributes: [...valid.attributes,
    { key: "llm.token_count.prompt", value: { intValue: "100" } },
  ] }))).status).toBe(204);
  const call = (await get("/api/turns/valid-usage-turn/llm-calls")).llmCalls[0];
  expect(call).toMatchObject({ promptTokens: 100, completionTokens: 0, cost: 0.125,
    reasoningTokens: null, cacheReadTokens: null });
  expect(call.capture.unknownMetrics).not.toContain("promptTokens");
  expect(call.capture.unknownMetrics).not.toContain("completionTokens");
  expect(call.capture.unknownMetrics).not.toContain("cost");
});

test("a rejected multi-resource request preserves prior records and emits no partial SSE updates", async () => {
  const original = span("rollback-existing", "rollback-tool", "TOOL", [
    attr("tool.name", "read"), attr("output.value", "original evidence"),
  ]);
  expect((await post(payload(original))).status).toBe(204);
  const before = (await get("/api/turns/rollback-existing-turn/tool-calls")).toolCalls;
  const stream = await fetch(base + "/api/stream");
  const events = stream.body!.getReader();
  await events.read(); // Initial heartbeat.
  try {
    const changed = { ...original, attributes: [...original.attributes, attr("output.value", "must not commit")] };
    for (const invalid of [
      { ...span("rollback-bad", "rollback-bad-tool", "TOOL"), startTimeUnixNano: "not-a-number" },
      span("rollback-bad", "rollback-bad-llm", "LLM", [attr("llm.cost.total", "-1")]),
    ]) {
      const rejected = await post({ resourceSpans: [
        { scopeSpans: [{ spans: [changed, span("rollback-new", "rollback-new-tool", "TOOL")] }] },
        { scopeSpans: [{ spans: [invalid] }] },
      ] });
      expect(rejected.status).toBe(400);
      expect((await get("/api/turns/rollback-existing-turn/tool-calls")).toolCalls).toEqual(before);
      expect((await fetch(base + "/api/sessions/rollback-new")).status).toBe(404);
    }
    // A successful marker bounds the SSE observation without timing assumptions.
    expect((await post(payload(span("commit-marker", "commit-marker-tool", "TOOL")))).status).toBe(204);
    let text = "";
    while (!text.includes("commit-marker")) {
      const chunk = await events.read();
      if (chunk.done) throw new Error("SSE ended before marker");
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).not.toContain("rollback-");
  } finally { await events.cancel(); }
});

test("usage failure inside ingestion rolls back earlier resources, and malformed envelopes never persist records", async () => {
  const resources = (spans: unknown[]) => ({ scopeSpans: [{ spans }] });
  const rejected = await post({ resourceSpans: [
    resources([span("transaction-first", "transaction-tool", "TOOL", [attr("output.value", "do not retain")])]),
    resources([span("transaction-invalid", "transaction-llm", "LLM", [attr("llm.cost.total", "-0.1")])]),
  ] });
  expect(rejected.status).toBe(400);
  expect((await fetch(base + "/api/sessions/transaction-first")).status).toBe(404);
  expect((await get("/api/turns/transaction-first-turn/tool-calls")).toolCalls).toEqual([]);
  for (const body of [null, [], { resourceSpans: {} }, { resourceSpans: [null] },
    { resourceSpans: [{ scopeSpans: "bad" }] }, payload({ ...span("bad-time", "bad-time-tool", "TOOL"), endTimeUnixNano: "1" }),
    payload({ ...span("bad-attrs", "bad-attrs-tool", "TOOL"), attributes: [{ key: "bad", value: null }] }),
  ]) {
    expect((await post(body)).status).toBe(400);
  }
});
