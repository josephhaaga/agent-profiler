# Diagnostic trust audit — Round 1

## Decision

Fix finding lifecycle and order-independent accounting before adding more recommendations. Existing records can produce duplicate, stale, contradictory findings even when ingestion succeeds.

Scope: `packages/{profiler,store,server,ingest}` and the server's OpenCode importer. No implementation edits, live database access, private sessions, installs, commits, publishing, or network writes. Existing chart/cache-sort/command-menu work was not changed.

Validation used direct source imports with Bun and synthetic `new Store()` in-memory databases. Public HTTP behavior below is traced through the router, not exercised against a running server. Existing focused tests pass: **48 tests, 128 assertions** (`bun test packages/store/src/index.test.ts packages/ingest/src/index.test.ts packages/profiler/src/index.test.ts`). The adversarial cases below are missing from that passing suite.

## 1. Findings accumulate on every recomputation and never resolve

**Severity: P1 / high. Effort: 4–8 engineering hours**, including lifecycle tests; batching is an additional 1–2 hours.

The implementation has three mutually reinforcing problems:

- `packages/profiler/src/index.ts:20–40` uses a process-global sequence in every insight ID. Identical evidence produces a new identity each run rather than an upsert of the same finding.
- `packages/profiler/src/index.ts:648–651` only inserts/upserts the newly emitted findings. `packages/store/src/index.ts:645–701` has no retirement, replacement, or resolved-state operation, so findings that cease to apply stay visible indefinitely.
- `packages/server/src/index.ts:144–155` runs the entire session's profilers once **per span**, not once per affected session. Each run revisits every call's composition and scans comparison-baseline sessions (`packages/profiler/src/index.ts:618–645`). A payload with 100 spans sharing a session invokes 100 full passes and broadcasts repeated findings.

**Verified counterexample:** seed one session with two calls, each with 1,000 prompt tokens and zero cache reads. Run `runProfilers` twice. Stored session findings contain `cache.low_hit_ratio:s:1` and `cache.low_hit_ratio:s:2`. Correct both calls to 900 cache-read tokens and run again: the return value has **0 findings**, but the store still has **2 active-looking low-cache findings**.

**Expected public API behavior:** repeated `POST /api/sessions/:id/profile` with unchanged evidence returns stable identities without growing `GET /api/sessions/:id/insights`. After corrected evidence, the GET endpoint no longer returns the warning as current; an explicit resolved/history state is also acceptable. One `POST /v1/traces` profiles each affected session once, and SSE does not announce unchanged findings repeatedly.

**Smallest useful fix:** assign stable identities that include the actual evidence entity (for example, tool identity or LLM-call ID where relevant), atomically reconcile each completed analysis with its prior findings, and deduplicate affected sessions before profiling. Preserve an explicit unknown/insufficient-evidence state rather than treating skipped analysis as proof of resolution. Test unchanged reruns, evidence correction, coverage loss, multiple tools/calls with the same finding kind, and repeated payloads.

## 2. Late child spans leave turn totals and metric coverage permanently stale

**Severity: P1 / high. Effort: 3–5 engineering hours**, including arrival-order and SSE tests.

`packages/ingest/src/index.ts:410–429` processes orphan LLM spans but only recomputes **session** totals afterward. `recomputeTurnTotals` is called only while processing the parent turn (`packages/ingest/src/index.ts:541–567`). A child arriving after its turn therefore does not update that existing turn's round trips, tokens, cost, or `unknownMetrics`.

**Verified counterexample:** ingest a session and its turn without children, then ingest a separate LLM span pointing to that turn with `llm.token_count.prompt=100` and other usage metrics absent. Observed state:

- Session `promptTokens` is **100**.
- The turn's LLM list contains **1 call**.
- Turn `promptTokens` is still **0**, with `llmRoundTrips=0` from the first batch.
- Turn capture still says `partial:false, unknownMetrics:[]`, although the child has missing usage.

**Expected public API behavior:** after the second `POST /v1/traces`, `GET /api/turns/:id` reports `promptTokens:100`, `llmRoundTrips:1`, and unknown child-derived totals as `null`, consistent with `GET /api/turns/:id/llm-calls`. SSE must emit the updated turn as well as the session. Totals must be invariant under parent-first, child-first, repeated, and interleaved delivery.

**Smallest useful fix:** reconcile every existing affected turn after writing or reparenting calls, propagate coverage before publishing aggregate events, then reconcile the session. The existing test at `packages/ingest/src/index.test.ts:111–122` covers **child-first only**, so it does not detect this inverse ordering. This is also why a UI-only unknown-value fix cannot restore trust.

## 3. Composition warnings divide session-wide schemas by a partial call prompt

**Severity: P1 / high false-positive risk. Effort: 4–8 engineering hours** for coverage gating and per-call schema snapshots; an interim suppression is smaller.

`packages/profiler/src/index.ts:312–332` mixes `listPromptSegments(llmCallId)` with `listToolDefs(sessionId)`. The latter is the session-wide accumulated latest schema per name (`packages/store/src/index.ts:592–622`), not the tools sent in that request. Ingest keeps adding definitions and never records a call-specific membership set (`packages/ingest/src/index.ts:705–726`). Its fallback prompt segment can be only the system message (`packages/ingest/src/index.ts:673–698`). Nevertheless the finding calls this fraction a share of "the prompt"/"context window" (`packages/profiler/src/index.ts:336–346`).

**Verified counterexample:** seed one call with a 100-token system-only segment and one session tool schema estimated at 600 tokens. `analyzeComposition` returns `toolDefsFraction=6` and emits a **critical 600% of the prompt** warning. It can do this even if the tool belongs only to a later request. Reprofiling that later state rewrites the interpretation of earlier calls.

**Expected public API behavior:** `POST /api/sessions/:id/profile` must not create a tool-share warning unless the numerator and denominator describe the same request and known coverage. `GET /api/sessions/:id/insights` must identify the offending `llmCallId`, the actual tool set, and whether tokens are estimated. A partial system-only capture is insufficient to claim a whole-prompt percentage.

**Smallest useful fix:** suppress the fraction-based finding for incomplete/incompatible capture, persist call-specific schema references, and calculate the share from a clearly defined full-input denominator. Do not clamp 600% to 100%: that hides the scope error. Include `llmCallId` in finding identity/evidence so multiple affected calls are inspectable rather than indistinguishable session warnings.

## 4. Compare contradicts cache analysis and displays the wrong confidence interval

**Severity: P1 / high misleading comparison. Effort: 3–6 engineering hours**, including deterministic statistical tests.

There are two directly observable errors in the compare contract:

- `packages/profiler/src/index.ts:535–539` divides cache reads by **prompt + completion** tokens, whereas session cache analysis divides by **prompt** tokens (`:124–126`). Output verbosity therefore changes the reported cache efficiency even when prompt usage is identical.
- The cost finding summary interpolates **`cacheCI`** into the cost confidence interval (`:598`), while its evidence contains `costCI` (`:599`). The emission gate at `:587–589` also does not check whether the cost interval excludes zero, despite the preceding "significant cost differences" comment.

**Verified counterexamples:** with 1,000 prompt tokens, 1,000 completion tokens, and 800 cache reads, session analysis reports **80%**, but compare reports **40%**. Two one-turn harnesses costing 1 and 2 with identical cache ratios produce the summary `Δ = +100.0%, 95% CI [0.0%, 0.0%]`; the same finding's evidence correctly contains absolute cost CI `[1,1]`.

**Expected public API behavior:** `GET /api/compare` uses a documented input-only cache denominator consistent with session analysis, or explicitly names a different metric. Cost summaries and evidence use the same cost interval and units; if expressed as relative percentages, convert the cost interval using the cost baseline. Empty metric samples are unavailable, not zero-valued competitors. Avoid presenting a confident comparative recommendation when uncertainty spans no difference.

**Smallest useful fix:** centralize the cache-ratio definition, format cost findings from cost evidence, and require sufficient nonempty samples for comparative claims. Add exact tests for long completions, equal cache/different cost, empty cohorts, and a cost interval crossing zero. Any broader causal claim about which harness is "better" still needs matched workloads; that is not established by this endpoint.

## 5. Standard OTLP failures are discarded before tools and turns reach the API

**Severity: P2 / medium-high evidence loss. Effort: 2–4 engineering hours**, including status normalization and regression tests.

The accepted raw span type includes top-level `status.code` and `status.message` (`packages/ingest/src/index.ts:53–62`), but `normalizeSpan` drops both (`:147–162`). Turn failure detection reads only a custom string attribute named `status` (`:492–497`); tool storage does the same (`:780–792`). Thus ordinary OTLP error evidence is lost unless an exporter also supplies this application-specific attribute.

**Verified counterexample:** ingest a tool span with top-level `status:{code:2,message:"failure"}` and no custom `status` attribute. The resulting tool record has **`status:undefined`**. A turn with the same top-level status follows the default `endSignal="completed"` branch. The bundled collector sets the custom attribute, so this is specifically a failure of the general OTLP ingestion contract, not evidence that its collector always loses errors.

**Expected public API behavior:** `GET /api/turns/:id/tool-calls` returns an error status for an OTLP error span. `GET /api/turns/:id` must not call an errored turn completed. Preserve the original status code/message as inspectable evidence, and distinguish unset status from explicit success. A later failure/repetition diagnostic must link to concrete call IDs and captured arguments/output, not infer model inadequacy from failure alone.

**Smallest useful fix:** normalize standard OTLP status at the boundary with a documented precedence rule for custom attributes, retain the diagnostic message, and test both exporter styles. Do not add speculative model-selection advice: `packages/profiler/src/index.ts:430–446` currently treats errors, user stops, or merely more than five calls as underpowered-model signals, none of which establishes that cause.

## Implementation order and safety boundary

1. Make finding reconciliation idempotent and batch profiling per session.
2. Make aggregates and unknown-metric propagation independent of arrival order.
3. Suppress invalid composition percentages, then add call-specific evidence.
4. Correct compare definitions and confidence-interval formatting.
5. Preserve OTLP failure evidence before adding new failure/repetition diagnostics.

This audit does not assert a provider-specific cache root cause or a verified synthetic-event double count. The importer includes completed compaction records (`packages/server/src/import-opencode.ts:83–94`); establishing whether each source record represents a real model invocation requires a source-event contract beyond this audit. No production or personal data is needed to implement the five regression cases above.
