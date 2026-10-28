import { afterAll, expect, test } from "bun:test";

const collector = Bun.spawn(["bun", "run", "packages/server/src/index.ts"], {
  env: { ...process.env, AGENT_PROFILER_PORT: "0", AGENT_PROFILER_DB_PATH: ":memory:" },
  stdout: "pipe", stderr: "pipe",
});
const reader = collector.stdout.getReader();
let output = "";
while (!output.includes("agent-profiler listening on")) {
  const chunk = await reader.read();
  if (chunk.done) throw new Error(await new Response(collector.stderr).text());
  output += new TextDecoder().decode(chunk.value);
}
const base = output.match(/http:\/\/localhost:\d+/)![0];
afterAll(async () => { collector.kill(); await collector.exited; });

async function request(path: string, body?: unknown) {
  const response = await fetch(base + path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.status === 204 ? undefined : response.json() as Promise<any>;
}

function savedSession(id: string, cacheRead = 0, known = true) {
  return { info: { id, title: "Synthetic diagnostic fixture", time: { created: 1000, updated: 5000 } }, messages: [
    { type: "user", id: "msg_user", text: "Inspect a fixture", time: { created: 1000 } },
    ...[0, 1].map(i => ({ type: "assistant", id: `msg_answer_${i}`,
      model: { id: "fixture-model", providerID: "fixture" }, time: { created: 2000 + i * 1000, completed: 2500 + i * 1000 },
      tokens: known ? { input: 1000 - cacheRead, output: 10, reasoning: 0, cache: { read: cacheRead, write: 0 } } : undefined,
      cost: 0.01, finish: "stop", content: [],
    })),
  ] };
}

function attributes(values: Record<string, string | number | string[]>) {
  return Object.entries(values).map(([key, value]) => ({ key, value: typeof value === "string" ? { stringValue: value }
    : typeof value === "number" ? { doubleValue: value } : { arrayValue: { values: value.map(stringValue => ({ stringValue })) } } }));
}

function trace(id: string, children: unknown[], harness = "custom") {
  return { resourceSpans: [{ resource: { attributes: attributes({ harness }) }, scopeSpans: [{ spans: [
    { traceId: id, spanId: `${id}-root`, name: "session", startTimeUnixNano: "1000000000", endTimeUnixNano: "2000000000", attributes: attributes({ "session.id": id, "openinference.span.kind": "CHAIN" }) },
    ...children,
  ] }] }] };
}

test("reprofiling unchanged evidence keeps one current finding with a stable identity", async () => {
  const id = "ses_finding_identity";
  await request("/api/import/opencode", savedSession(id));
  const first = await request(`/api/sessions/${id}/profile`, {});
  const second = await request(`/api/sessions/${id}/profile`, {});
  expect(first.insights.filter((i: any) => i.kind === "cache.low_hit_ratio")).toHaveLength(1);
  expect(second.insights).toEqual(first.insights);
  expect((await request(`/api/sessions/${id}/insights`)).insights).toEqual(first.insights);
});

test("corrected findings retire, while missing evidence produces an explicit no-conclusion finding", async () => {
  const id = "ses_finding_lifecycle";
  await request("/api/import/opencode", savedSession(id));
  await request(`/api/sessions/${id}/profile`, {});
  await request("/api/import/opencode", savedSession(id, 900));
  expect((await request(`/api/sessions/${id}/profile`, {})).insights.some((i: any) => i.kind === "cache.low_hit_ratio")).toBe(false);
  expect((await request(`/api/sessions/${id}/insights`)).insights.some((i: any) => i.kind === "cache.low_hit_ratio")).toBe(false);
  await request("/api/import/opencode", savedSession(id, 0, false));
  const { insights } = await request(`/api/sessions/${id}/profile`, {});
  expect(insights).toHaveLength(1);
  expect(insights[0]).toMatchObject({ kind: "coverage.incomplete", severity: "info", evidence: { unknownCallCount: 2 } });
  expect((await request(`/api/sessions/${id}/insights`)).insights).toEqual(insights);
});

test("same-named tools of different kinds retain distinct current findings", async () => {
  const id = "ses_tool_kinds";
  await request("/v1/traces", trace(id, ["builtin", "mcp"].map((kind, i) => ({
    traceId: id, spanId: `${id}-${kind}`, parentSpanId: `${id}-root`, name: "read",
    startTimeUnixNano: "1000000000", endTimeUnixNano: String(1900000000 - i * 200000000), status: { code: 1 },
    attributes: attributes({ "session.id": id, "openinference.span.kind": "TOOL", "tool.name": "read", "tag.tags": kind === "mcp" ? ["mcp"] : [] }),
  }))));
  const { insights } = await request(`/api/sessions/${id}/insights`);
  expect(insights).toHaveLength(2);
  expect(new Set(insights.map((i: any) => i.id)).size).toBe(2);
  expect((await request(`/api/sessions/${id}/profile`, {})).insights.map((i: any) => i.id).sort()).toEqual(insights.map((i: any) => i.id).sort());
});

test("standard OTLP model errors remain inspectable without a finish-reason attribute", async () => {
  const id = "ses_standard_model_error";
  await request("/v1/traces", trace(id, [
    { traceId: id, spanId: `${id}-turn`, parentSpanId: `${id}-root`, name: "turn", startTimeUnixNano: "1000000000", endTimeUnixNano: "2000000000", status: { code: 1 }, attributes: attributes({ "session.id": id, "openinference.span.kind": "CHAIN" }) },
    { traceId: id, spanId: `${id}-llm`, parentSpanId: `${id}-turn`, name: "chat", startTimeUnixNano: "1100000000", endTimeUnixNano: "1500000000", status: { code: 2, message: "Synthetic provider error" }, attributes: attributes({ "session.id": id, "openinference.span.kind": "LLM", "llm.model_name": "fixture", "llm.token_count.prompt": 100, "llm.token_count.completion": 0, "llm.token_count.completion_details.reasoning": 0, "llm.token_count.prompt_details.cache_read": 0, "llm.token_count.prompt_details.cache_write": 0, "llm.cost.total": 0 }) },
  ]));
  const { insights } = await request(`/api/sessions/${id}/insights`);
  expect(insights.some((i: any) => i.kind === "execution.model_errors" && i.evidence.llmCallIds.includes(`${id}-llm`))).toBe(true);
  expect((await request("/api/sessions")).sessions.find((s: any) => s.id === id)).toMatchObject({ modelErrorCount: 1, toolErrorCount: 0 });
});

test("comparison uses input-only cache weighting and does not invent independent-sample confidence", async () => {
  const id = "ses_compare_input_only";
  await request("/v1/traces", trace(id, [
    { traceId: id, spanId: `${id}-turn`, parentSpanId: `${id}-root`, name: "turn", startTimeUnixNano: "1000000000", endTimeUnixNano: "2000000000", status: { code: 1 }, attributes: attributes({ "session.id": id, "openinference.span.kind": "CHAIN" }) },
    { traceId: id, spanId: `${id}-llm`, parentSpanId: `${id}-turn`, name: "chat", startTimeUnixNano: "1100000000", endTimeUnixNano: "1500000000", status: { code: 1 }, attributes: attributes({ "session.id": id, "openinference.span.kind": "LLM", "llm.model_name": "fixture", "llm.token_count.prompt": 1000, "llm.token_count.completion": 1000, "llm.token_count.completion_details.reasoning": 0, "llm.token_count.prompt_details.cache_read": 800, "llm.token_count.prompt_details.cache_write": 0, "llm.cost.total": 0.01 }) },
  ], "vscode"));
  const { compare } = await request("/api/compare?harnesses=vscode,custom");
  expect(compare.metrics.find((m: any) => m.harness === "vscode").meanCacheHitRatio).toBe(0.8);
  expect(compare.insights).toEqual([]);
  expect(compare.pairwiseDeltas).toHaveLength(1);
  expect(compare.pairwiseDeltas[0].costPerTurnDelta).toMatchObject({ ciLow: null, ciHigh: null });
  expect(compare.comparisonBasis).toContain("unmatched");
});

test("the stream announces changed current findings, not every unchanged recomputation", async () => {
  const id = "ses_stream_lifecycle";
  const barrier = "ses_stream_barrier";
  const controller = new AbortController();
  const response = await fetch(base + "/api/stream", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
  const streamReader = response.body!.getReader();
  const events: any[] = [];
  const collecting = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await streamReader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6));
        if (event.type === "session" && event.data.id === barrier) return;
        events.push(event);
      }
    }
  })();
  try {
    await request("/api/import/opencode", savedSession(id));
    await request(`/api/sessions/${id}/profile`, {});
    await request(`/api/sessions/${id}/profile`, {});
    await request("/api/import/opencode", savedSession(id, 900));
    await request("/api/import/opencode", savedSession(barrier, 900));
    await collecting;
    const snapshots = events.filter(e => e.type === "insights" && e.data.sessionId === id);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].data.insights.some((i: any) => i.kind === "cache.low_hit_ratio")).toBe(true);
    expect(snapshots[1].data.insights.some((i: any) => i.kind === "cache.low_hit_ratio")).toBe(false);
    expect(events.filter(e => e.type === "insight" && e.data.scopeId === id)).toHaveLength(2);
  } finally { controller.abort(); await collecting.catch(() => {}); }
});

test("errors are discoverable before a parent turn exists and reconcile when it arrives", async () => {
  const id = "ses_unresolved_errors";
  const pending = `${id}-pending`;
  await request("/v1/traces", trace(id, [
    { traceId: id, spanId: `${id}-tool`, parentSpanId: pending, name: "read", startTimeUnixNano: "1100000000", endTimeUnixNano: "1500000000", status: { code: 2 }, attributes: attributes({ "session.id": id, "openinference.span.kind": "TOOL", "tool.name": "read" }) },
    { traceId: id, spanId: `${id}-llm`, parentSpanId: pending, name: "chat", startTimeUnixNano: "1100000000", endTimeUnixNano: "1500000000", status: { code: 2 }, attributes: attributes({ "session.id": id, "openinference.span.kind": "LLM" }) },
  ]));
  expect((await request(`/api/sessions/${id}/turns`)).turns).toHaveLength(0);
  const before = (await request(`/api/sessions/${id}/insights`)).insights.filter((i: any) => i.kind.startsWith("execution."));
  expect(before).toHaveLength(2);
  expect(before.every((i: any) => i.scopeType === "session" && i.evidence.pendingTurnId === pending)).toBe(true);
  await request("/v1/traces", trace(id, [
    { traceId: id, spanId: pending, parentSpanId: `${id}-root`, name: "turn", startTimeUnixNano: "1000000000", endTimeUnixNano: "2000000000", attributes: attributes({ "session.id": id, "openinference.span.kind": "CHAIN" }) },
  ]));
  const after = (await request(`/api/sessions/${id}/insights`)).insights.filter((i: any) => i.kind.startsWith("execution."));
  expect(after).toHaveLength(2);
  expect(after.every((i: any) => i.scopeType === "turn" && i.scopeId === pending)).toBe(true);
  expect(after.some((i: any) => before.some((old: any) => old.id === i.id))).toBe(false);
});

test("an exact imported message resolves a missing live parent without losing request evidence", async () => {
  const id = "ses_import_parent_resolution";
  const pending = `${id}-unresolved`;
  await request("/v1/traces", trace(id, [
    { traceId: id, spanId: `${id}-llm`, parentSpanId: pending, name: "chat", startTimeUnixNano: "1100000000", endTimeUnixNano: "1500000000", status: { code: 2 }, attributes: attributes({ "session.id": id, "openinference.span.kind": "LLM", metadata: JSON.stringify({ messageID: "msg_answer_0" }), "llm.input_messages": JSON.stringify([{ message: { role: "system", content: "Synthetic captured request" } }]) }) },
  ], "opencode"));
  await request("/api/import/opencode", savedSession(id));
  const { session } = await request(`/api/sessions/${id}`);
  const { turns } = await request(`/api/sessions/${id}/turns`);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ llmRoundTrips: 2, promptTokens: session.promptTokens, cost: session.costTotal });
  const { llmCalls } = await request(`/api/turns/${turns[0].id}/llm-calls`);
  expect(llmCalls).toHaveLength(2);
  const liveCall = llmCalls.find((c: any) => c.id.endsWith("msg_answer_0"));
  expect(liveCall).toMatchObject({ model: "fixture-model", provider: "fixture", capture: { source: "live", backfilled: true } });
  expect(liveCall.inputMessagesRef).toBeString();
  expect((await request(`/api/turns/${pending}/llm-calls`)).llmCalls).toEqual([]);
});
