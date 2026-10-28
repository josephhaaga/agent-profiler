import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(process.env.AGENT_PROFILER_TEST_TMPDIR ?? tmpdir(), "profiler-import-"));
const collector = Bun.spawn(["bun", "run", "packages/server/src/index.ts"], {
  env: { ...process.env, AGENT_PROFILER_PORT: "0", AGENT_PROFILER_DB_PATH: join(dir, "test.sqlite") },
  stdout: "pipe", stderr: "pipe",
});
const reader = collector.stdout.getReader();
let output = "";
while (!output.includes("agent-profiler listening on")) {
  const chunk = await reader.read();
  if (chunk.done) throw new Error(await new Response(collector.stderr).text());
  output += new TextDecoder().decode(chunk.value);
}
const base = output.match(/http:\/\/localhost:(\d+)/)![0];
const saved = {
  info: { id: "ses_saved", title: "Investigate file contents", time: { created: 1000, updated: 4000 }, location: { directory: "/project" } },
  messages: [
    { type: "user", id: "msg_user", text: "Read a file", time: { created: 1000 } },
    { type: "assistant", id: "msg_answer", model: { id: "test-model", providerID: "test" },
      time: { created: 2000, streamed: 2500, completed: 3000 }, cost: 0.02,
      tokens: { input: 20, output: 10, reasoning: 3, cache: { read: 80, write: 5 } },
      content: [{ type: "text", text: "Read it" }, { type: "tool", id: "call_read", name: "read",
        time: { created: 2500, ran: 2600, completed: 2900 },
        state: { status: "completed", input: { path: "file.txt" }, content: [{ type: "text", text: "file contents" }] } }] },
  ],
};
const exports = new Map<string, any>([[saved.info.id, saved]]);
const source = Bun.serve({ port: 0, fetch(req) {
  const url = new URL(req.url);
  const all = [...exports.values()].filter(s => Boolean(s.info.time.archived) === (url.searchParams.get("archived") === "true"));
  const cursor = url.searchParams.get("cursor");
  const offset = cursor == null ? 0 : Number(cursor);
  if (!Number.isInteger(offset)) return Response.json({ error: "Invalid cursor" }, { status: 400 });
  return Response.json(url.pathname === "/api/session"
    ? { data: all.slice(offset, offset + 1).map(s => s.info), cursor: { previous: offset > 0 ? String(offset - 1) : null, next: offset + 1 < all.length ? String(offset + 1) : null } }
    : { data: exports.get(url.pathname.split("/")[4]!) });
} });
afterAll(() => { collector.kill(); source.stop(true); rmSync(dir, { recursive: true, force: true }); });

async function runImport() {
  const proc = Bun.spawn(["bun", "run", "packages/cli/src/index.ts", "import", "opencode", "--opencode-url", source.url.toString(), "--endpoint", base], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, stderr).toBe(0);
  return stdout;
}
const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;

test("CLI imports recorded usage and tools under the original OpenCode session ID", async () => {
  await runImport();
  const { session } = await get("/api/sessions/ses_saved");
  expect(session).toMatchObject({ id: "ses_saved", title: "Investigate file contents", llmCallCount: 1, toolCallCount: 1, promptTokens: 105, cacheReadTokens: 80, costTotal: 0.02 });
  const { turns } = await get("/api/sessions/ses_saved/turns");
  expect(turns).toHaveLength(1);
  expect(turns[0].userText).toBe("Read a file");
  const { llmCalls } = await get(`/api/turns/${turns[0].id}/llm-calls`);
  expect(llmCalls[0]).toMatchObject({ completionTokens: 10, reasoningTokens: 3, capture: { source: "opencode-import", partial: true } });
  expect((await get(`/api/llm-calls/${llmCalls[0].id}/segments`)).segments).toEqual([]);
  const { toolCalls } = await get(`/api/turns/${turns[0].id}/tool-calls`);
  expect(await (await fetch(base + `/api/blobs/${toolCalls[0].outputRef}`)).text()).toContain("file contents");
});

test("rerunning import preserves counts, costs, and transcript without duplication", async () => {
  await runImport();
  const before = await get("/api/sessions/ses_saved/turns");
  await runImport();
  expect(await get("/api/sessions/ses_saved/turns")).toEqual(before);
  expect((await get("/api/sessions/ses_saved")).session).toMatchObject({ llmCallCount: 1, toolCallCount: 1, costTotal: 0.02 });
});

test("pagination imports unknown usage as null, while recorded zero stays zero", async () => {
  exports.set("ses_unknown", { info: { ...saved.info, id: "ses_unknown" }, messages: [
    saved.messages[0],
    { ...saved.messages[1], tokens: undefined, cost: undefined, content: [] },
    { ...saved.messages[1], id: "msg_zero", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, content: [] },
  ] });
  await runImport();
  expect((await get("/api/sessions/ses_unknown")).session).toMatchObject({ promptTokens: null, costTotal: null, llmCallCount: 2 });
  const { turns } = await get("/api/sessions/ses_unknown/turns");
  const { llmCalls } = await get(`/api/turns/${turns[0].id}/llm-calls`);
  expect(llmCalls[0]).toMatchObject({ promptTokens: null, cacheReadTokens: null, cost: null });
  expect(llmCalls[1]).toMatchObject({ promptTokens: 0, cacheReadTokens: 0, cost: 0 });
});

test("live capture and import share message/tool identities in both arrival orders", async () => {
  const attrs = (values: Record<string, string | number>) => Object.entries(values).map(([key, value]) => ({ key, value: typeof value === "string" ? { stringValue: value } : { doubleValue: value } }));
  const batch = (sessionId: string) => ({ resourceSpans: [{ resource: { attributes: attrs({ harness: "opencode" }) }, scopeSpans: [{ spans: [
    { traceId: "trace", spanId: `turn-${sessionId}`, parentSpanId: "root", name: "turn", startTimeUnixNano: "1000000000", attributes: attrs({ "session.id": sessionId, "openinference.span.kind": "CHAIN", metadata: JSON.stringify({ messageID: "msg_user" }) }) },
    { traceId: "trace", spanId: `llm-${sessionId}`, parentSpanId: `turn-${sessionId}`, name: "chat", startTimeUnixNano: "2000000000", attributes: attrs({ "session.id": sessionId, "openinference.span.kind": "LLM", metadata: JSON.stringify({ messageID: "msg_answer" }), "llm.model_name": "live-model", "llm.token_count.prompt": 105, "llm.cost.total": 0.02, "llm.input_messages": JSON.stringify([{ message: { role: "system", content: "live instructions" } }]) }) },
    { traceId: "trace", spanId: `tool-${sessionId}`, parentSpanId: `turn-${sessionId}`, name: "read", startTimeUnixNano: "2500000000", attributes: attrs({ "session.id": sessionId, "openinference.span.kind": "TOOL", "tool.id": "call_read", "tool.name": "read" }) },
  ] }] }] });
  for (const liveFirst of [true, false]) {
    const id = liveFirst ? "ses_live_first" : "ses_import_first";
    exports.set(id, { ...saved, info: { ...saved.info, id } });
    const live = async () => { expect((await fetch(base + "/v1/traces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch(id)) })).status).toBe(204); };
    if (liveFirst) await live();
    await runImport();
    if (!liveFirst) await live();
    await runImport();
    expect((await get(`/api/sessions/${id}`)).session).toMatchObject({ title: "Investigate file contents", llmCallCount: 1, toolCallCount: 1, costTotal: 0.02, turnCount: 1 });
    const { turns } = await get(`/api/sessions/${id}/turns`);
    const { llmCalls } = await get(`/api/turns/${turns[0].id}/llm-calls`);
    expect(llmCalls[0].model).toBe("live-model");
    expect(llmCalls[0].inputMessagesRef).toBeString();
    expect(llmCalls[0].capture.source).toBe("live");
  }
});

test("children arriving before a live parent retain their turn after import", async () => {
  const id = "ses_delayed";
  exports.set(id, { ...saved, info: { ...saved.info, id } });
  const attrs = (values: Record<string, string>) => Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } }));
  const spans = [
    { traceId: "delay", spanId: "delay-llm", parentSpanId: "delay-turn", name: "chat", startTimeUnixNano: "2000000000", attributes: attrs({ "session.id": id, "openinference.span.kind": "LLM", metadata: JSON.stringify({ messageID: "msg_answer" }) }) },
    { traceId: "delay", spanId: "delay-turn", parentSpanId: "delay-root", name: "turn", startTimeUnixNano: "1000000000", attributes: attrs({ "session.id": id, "openinference.span.kind": "CHAIN", metadata: JSON.stringify({ messageID: "msg_user" }) }) },
  ];
  for (const span of spans) expect((await fetch(base + "/v1/traces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }) })).status).toBe(204);
  await runImport();
  const { turns } = await get(`/api/sessions/${id}/turns`);
  expect(turns).toHaveLength(1);
  expect((await get(`/api/turns/${turns[0].id}/llm-calls`)).llmCalls).toHaveLength(1);
  // Live LLM capture does not imply its tool hooks were captured too.
  expect((await get(`/api/turns/${turns[0].id}/tool-calls`)).toolCalls).toHaveLength(1);
});

test("ambiguous legacy overlap is explicitly skipped instead of double-counted", async () => {
  const id = "ses_legacy";
  exports.set(id, { ...saved, info: { ...saved.info, id } });
  const attributes = Object.entries({ "session.id": id, "openinference.span.kind": "LLM" }).map(([key, stringValue]) => ({ key, value: { stringValue } }));
  await fetch(base + "/v1/traces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "legacy", spanId: "legacy", parentSpanId: "legacy-parent", name: "chat", startTimeUnixNano: "2000000000", attributes }] }] }] }) });
  expect(await runImport()).toContain(`Skipped ${id}: existing live records lack OpenCode message/tool IDs`);
  expect((await get(`/api/sessions/${id}`)).session).toMatchObject({ title: "Investigate file contents", llmCallCount: 1 });
});

test("a failed export import leaves no partially written session", async () => {
  const id = "ses_malformed";
  const invalid = { ...saved, info: { ...saved.info, id }, messages: [saved.messages[0], { ...saved.messages[1], content: [{ type: "tool", id: "bad-tool" }] }] };
  const res = await fetch(base + "/api/import/opencode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(invalid) });
  expect(res.status).toBe(400);
  expect((await fetch(base + `/api/sessions/${id}`)).status).toBe(404);
});

test("migrated synthetic and metadata messages survive in the source snapshot", async () => {
  const id = "ses_migrated";
  exports.set(id, { ...saved, info: { ...saved.info, id }, messages: [
    { type: "synthetic", id: "msg_synthetic", time: { created: 900 }, text: "Restored context" },
    ...saved.messages,
    { type: "agent-selected", id: "msg_selection", time: { created: 3500 }, agent: "build" },
  ] });
  await runImport();
  const { session } = await get(`/api/sessions/${id}`);
  expect(session.llmCallCount).toBe(1);
  const snapshot = await get(`/api/blobs/${session.capture.sourceRef}`);
  expect(snapshot.messages[0].type).toBe("synthetic");
});

test("missing usage cannot generate a zero-cache warning", async () => {
  const response = await fetch(base + "/api/sessions/ses_unknown/profile", { method: "POST" });
  const { insights } = await response.json() as { insights: Array<{ kind: string }> };
  expect(insights.some(i => i.kind === "cache.low_hit_ratio")).toBe(false);
});

test("default import includes archived historical sessions", async () => {
  const id = "ses_archived";
  exports.set(id, { ...saved, info: { ...saved.info, id, time: { ...saved.info.time, archived: 5000 } } });
  await runImport();
  expect((await get(`/api/sessions/${id}`)).session).toMatchObject({ id, llmCallCount: 1 });
});
