# Adversarial backend review — Round 2

## Result

**Five new defects verified through real HTTP against a disposable `:memory:` collector.** No implementation/test changes, personal data, installs, publishing, commits, or production writes. Existing reports were not overwritten.

The round-1 duplicate-ID/reconciliation, late-child accounting, status parsing, invalid composition percentage, and descriptive-compare fixes were not re-reported. Repeated unchanged profile requests produced no finding SSE events in the exercised case. Null confidence intervals and unmatched cohorts are intentional and are not defects.

All five findings below are HTTP-observed, not merely inferred. File references describe the working tree at review time. Fix estimates include focused regression tests.

## Shared exact reproduction setup

Start the current source server with an ephemeral database and port:

```sh
AGENT_PROFILER_DB_PATH=:memory: AGENT_PROFILER_PORT=0 bun run packages/server/src/index.ts
```

Use the printed localhost URL as `base` in the following Bun JavaScript helpers. The probes actually used a `Bun.spawn` child with those environment variables and killed it in `finally`; no persistent collector was left running.

```js
const base = "http://localhost:<printed-port>";
const attr = (key, stringValue) => ({ key, value: { stringValue } });
const span = (session, id, parent, kind, extra = [], status) => ({
  traceId: "trace_" + session,
  spanId: id,
  ...(parent ? { parentSpanId: parent } : {}),
  name: kind,
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000001000000000",
  attributes: [attr("session.id", session),
    attr("openinference.span.kind", kind), ...extra],
  ...(status ? { status } : {}),
});
const payload = (...spans) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
const req = async (path, body) => {
  const r = await fetch(base + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let result; try { result = JSON.parse(text); } catch { result = text; }
  return { status: r.status, body: result };
};
const post = (...spans) => req("/v1/traces", payload(...spans));
```

### 1. Recorded errors disappear from findings until a parent turn exists

**P1 trust gap; 2–4 hours.** Independent of the repaired OTLP status parser.

```js
await post(
  span("orphan", "o-tool", "not-yet", "TOOL", [],
    { code: 2, message: "denied" }),
  span("orphan", "o-llm", "not-yet", "LLM", [],
    { code: 2, message: "rejected" }),
); // 204
await req("/api/turns/not-yet/tool-calls");
await req("/api/sessions/orphan/insights");
```

Observed: the tool endpoint returns the captured `ERROR` and `STATUS_CODE_ERROR`, but session insights contain **only `coverage.incomplete`**, with no execution-error finding. `GET /api/sessions/orphan/turns` has no actual turn to navigate. When turn spans are not emitted, the missing warning is permanent rather than a brief ordering artifact.

Cause: `packages/profiler/src/index.ts:641–656` enumerates existing turns before inspecting their errors. Session-owned calls with unresolved/nonexistent turn IDs never enter that loop, even though ingestion stores them successfully (`packages/ingest/src/index.ts:534–553`).

Expected: recorded model/tool errors appear immediately in session findings, linking to their actual call IDs and identifying the unresolved parent. Do not fabricate a completed turn merely to make the finding visible.

Minimal fix: analyze session-owned call lists independently of turn existence. Use session-scoped findings for unresolved parents and reconcile into turn scope when the parent arrives. Test no-parent, direct-session children, eventual reparenting, and changed-only SSE retirement of the temporary scope.

### 2. Import backfill preserves an unresolved live parent, producing zero-cost turns and incorrect comparison data

**P1 accounting error; 3–5 hours.** The imported message identity already provides enough information to repair the association; no fuzzy matching is needed.

```js
const sid = "ses_import_mix";
await post(span(sid, "live-call", "unresolved-turn", "LLM", [
  attr("metadata", JSON.stringify({ messageID: "assistant-a" })),
], { code: 2, message: "rejected" })); // 204
await req("/api/import/opencode", {
  info: { id: sid, time: { created: 1700000000000, updated: 1700000001000 } },
  messages: [
    { id: "user-a", type: "user", text: "do task",
      time: { created: 1700000000000 } },
    { id: "assistant-a", type: "assistant",
      model: { id: "test", providerID: "test" },
      time: { created: 1700000000000, completed: 1700000001000 },
      tokens: { input: 100, output: 10, reasoning: 0,
        cache: { read: 0, write: 0 } }, cost: 1, content: [] },
  ],
}); // 200
await req("/api/sessions/" + sid + "/turns");
await req("/api/turns/unresolved-turn/llm-calls");
await req("/api/compare");
```

Observed: imported turn `opencode:ses_import_mix:user-a` reports **0 calls, 0 prompt tokens, and cost 0**. The backfilled call has **100 prompt tokens, 10 completion tokens, cost 1**, but still references nonexistent `unresolved-turn`. The source's model remains `unknown` even though the export supplied `test`. In a fresh collector containing only this scenario, compare includes the session and reports tokens/cost per turn as zero, rather than 110/1. The recorded error is also absent from findings for the reason in finding 1.

Cause: `packages/server/src/import-opencode.ts:95–103` copies `existing` and merges only missing **numeric** metrics. It never adopts the authoritative `current.id` parent or fills unknown model/provider metadata. Totals at `:124–133` then aggregate the empty imported turn. `packages/profiler/src/index.ts:497–505,533–544` sees available call coverage and trusts those turn totals.

Expected: live request/output evidence stays intact, but the matching imported assistant belongs to its source user turn; that turn and the session agree on usage/cost. Partial provenance remains explicit. Compare must not admit a session whose calls are outside its enumerated turns without excluding or reporting those unmatched calls.

Minimal fix: reconcile a matched call's parent with the import's source turn (or explicitly flag a genuine conflict), fill unknown descriptive metadata, reconcile dependent tools when source IDs establish their parents, and recompute affected turns. This is distinct from generic late-arriving-span aggregation: no parent span ever needs to arrive for the export to resolve this case.

### 3. Sparse tool replay preserves error status but destroys the evidence and known measurements

**P1 evidence loss; 2–4 hours.** Status replay tests currently cover only part of the record.

```js
await post(
  span("sparse", "sp-turn", "sp-session", "CHAIN"),
  span("sparse", "sp-tool", "sp-turn", "TOOL", [
    attr("tool.name", "read"), attr("input.value", '{"path":"a"}'),
    attr("output.value", "important diagnostic output"),
  ], { code: 2, message: "denied" }),
);
await req("/api/turns/sp-turn/tool-calls");
const replay = span("sparse", "sp-tool", "sp-turn", "TOOL");
delete replay.endTimeUnixNano;
await post(replay); // 204
await req("/api/turns/sp-turn/tool-calls");
```

Observed before/after: name **`read` → `TOOL`**; `argsRef` and `outputRef` **present → absent**; output estimate **7 → 0**; known latency **1000 → null**. Error status/message remain, but the API no longer exposes the arguments/output needed to understand the failure. This also changes finding evidence/tool names on an otherwise sparse replay.

Cause: `packages/ingest/src/index.ts:908–927` loads `previousTool` only for status resolution, then unconditionally upserts new defaults and recalculates coverage exclusively from the replay. This differs from the LLM metric/reference merge at `:755–765`.

Expected: omission is not deletion. A replay without output/name/end timestamp must retain the earlier known values and evidence references. A **provided** value, including explicit zero where meaningful, may replace earlier data.

Minimal fix: presence-aware merge for name, kind/server/skill, args/output references, latency, and token-estimate coverage; retain known latency if the new span omits its end. Test sparse replay after complete live capture and after import-seeded capture, not only sparse status preservation.

### 4. Invalid numeric input is accepted as recorded zero with complete coverage

**P1 measurement-integrity error; 2–4 hours.** Null presentation cannot protect against this path because capture says the fabricated zero is known.

```js
const usage = ["prompt", "completion", "completion_details.reasoning",
  "prompt_details.cache_read", "prompt_details.cache_write"].map(key =>
    attr("llm.token_count." + key, key === "prompt" ? "oops" : "0"));
usage.push(attr("llm.cost.total", "0"));
await post(
  span("badmetrics", "bm-turn", "bm-session", "CHAIN"),
  span("badmetrics", "bm-llm", "bm-turn", "LLM", usage),
); // 204
await req("/api/turns/bm-turn/llm-calls");
```

Observed: `promptTokens:0`, `capture.unknownMetrics:[]`, `partial:false`. The collector converts the nonnumeric supplied value into an allegedly measured zero, and compare admits it. This is not a missing optional field or a deliberate empty-cohort convention.

Cause: `packages/ingest/src/index.ts:100–107` converts invalid strings to zero. Coverage detection at `:748–759` tests only attribute presence/nullness, not validity. The raw `doubleValue` numeric path also lacks finite/nonnegative domain validation; that broader variant is source-inferred, not separately exercised.

Expected: invalid token usage is rejected with a 4xx response before writes, or explicitly represented as invalid/unavailable with a coverage diagnostic. It must not be substituted with recorded zero. Numeric string representations of valid OTLP integer values should remain supported.

Minimal fix: validate finite, nonnegative numeric values and integer requirements for token counts at the boundary; drive value and coverage from one parse result. Include malformed strings, negative values, and out-of-range/nonfinite representations in tests.

### 5. A rejected trace request leaves committed records and already-emitted SSE events

**P1 consistency error; 4–8 hours.** Distinct from finding 4: this is a request-level failure after an earlier resource was successfully written.

```js
await req("/v1/traces", { resourceSpans: [
  { scopeSpans: [{ spans: [
    span("partialwrite", "pw-turn", "pw-session", "CHAIN"),
  ] }] },
  { scopeSpans: [{ spans: [
    { spanId: "bad", startTimeUnixNano: "not-a-number" },
  ] }] },
] }); // 500 "Internal error"
await req("/api/sessions/partialwrite"); // 200: persisted session/turnCount=1
await req("/api/sessions/partialwrite/insights"); // 200: []
```

Observed: the endpoint returns failure, but the first resource's session and turn remain. Profiling never executes because the ingest call throws before the route reaches reconciliation. Existing findings for a previously known session could therefore remain stale after a failed update; that stale-existing-session extension is inferred, while the persisted newly created session was directly observed.

Cause: `packages/ingest/src/index.ts:328–373` normalizes and mutates one resource at a time, without whole-payload validation or a commit boundary. Invalid nanoseconds throw from `:115–117`. The server catches this only after writes and broadcasts have happened (`packages/server/src/index.ts:152–167`).

Expected: malformed envelopes/timestamps return 400 and do not write or emit records. Unexpected ingest failure either rolls back the request or returns an explicit partial-success contract describing accepted/rejected spans; a generic 500 must not silently mean committed partial success.

Minimal fix: validate/normalize the complete request before applying any records; stage async hashing/parsing, apply mutations transactionally, and buffer SSE until successful commit/reconciliation. Merely catching the exception or changing 500 to 400 leaves the integrity defect intact.

## Priority

Fix replay evidence loss and import reparenting first: both corrupt otherwise useful successful ingestion. Then make rejected payloads atomic and validate metric values. Finally expose errors before parent arrival so the evidence remains discoverable throughout collection.
