# Observability UX patterns for a local-first agent profiler

Prioritize **live session truth → metric provenance → evidence-led triage → defensible comparisons → first-event setup**. Improve the existing session workflow before adding another dashboard.

Research date: 2026-10-27. This is a source-reading research pass, not a runtime evaluation of competing products. External factual claims below link to first-party pages actually retrieved during this pass. Moving documentation and `main` links are retrieval-time evidence, not release-pinned guarantees. Recommendations and acceptance criteria are proposed designs, not claims about competitor behavior.

## Verified primary-source findings

| Source | Verified behavior | Transferable lesson |
| --- | --- | --- |
| [Langfuse: Sessions](https://langfuse.com/docs/observability/features/sessions) | Groups observations and their enclosing traces using a shared `sessionId`; offers interaction replay and session annotation through scores. | Keep the conversation/session as the primary unit, with individual calls as evidence. |
| [Langfuse: Token & Cost Tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) | Distinguishes ingested from inferred usage/cost, prioritizes ingested values, and requires exclusive usage buckets; explicitly warns that inclusive provider counts can otherwise double-count tokens and cost. | Make provenance and denominator semantics visible before interpreting a number. |
| [Phoenix: repository README](https://raw.githubusercontent.com/Arize-ai/phoenix/main/README.md) | Documents OpenTelemetry-based tracing, datasets/experiments, replay of traced LLM calls in its playground, and local serving, including a `uvx` invocation. | Connect inspection to reproducible evidence; make local startup a short path. This source does not establish a specific failure-ranking UI or refresh contract. |
| [OpenLIT: repository README](https://raw.githubusercontent.com/openlit/openlit/main/README.md) | Documents coding-agent session instrumentation, a Coding Agents dashboard, tool/error/latency tracing, `openlit doctor`, and a Docker Compose quickstart. | Separate “collector reachable” from “instrumentation working”; retain session context during error investigation. |
| [ccusage: Cost Modes](https://ccusage.com/guide/cost-modes) and [Live Monitoring](https://ccusage.com/guide/live-monitoring) | Documents stored-versus-calculated cost modes; `display` shows zero when stored cost is absent. Its live page explicitly says `blocks --live` was removed in v18 and retains v17 documentation for one-second updates, burn rate, and projections. | Borrow explicit cost-method distinctions; reject missing-as-zero and do not present the historical live monitor as a current capability. |

These four projects provide enough verified evidence for this scope. No claims about tokscale are made without inspecting its primary sources. Competitor installation commands were read, not executed.

## Current repository fit

The following observations refer to the working tree inspected during this pass, including existing UI WIP:

- [App.tsx](../../packages/web/src/App.tsx): `SessionsView` fetches on mount; `SessionDetailView` fetches on session-ID change. `LiveTailView` separately renders event type and a truncated record ID. `InsightCard` displays summary/severity/kind but not `evidence`. Existing work includes the cost/cache timeline, cache panel, nullable metrics, and omnibar; these are foundations to preserve.
- [Schema](../../packages/schema/src/index.ts) and [web types](../../packages/web/src/types.ts): records carry session/turn/call identity, usage, latency, outcomes, and prompt hashes. Web types additionally expose nullable metrics and `capture.source`, `partial`, and `unknownMetrics`; the shared numeric schema alone does not describe the presentation contract.
- [Ingestion](../../packages/ingest/src/index.ts): session/turn refresh functions aggregate child calls and propagate unknown metric names. [Server](../../packages/server/src/index.ts) broadcasts presented records and exposes `/api/stream`, with comment heartbeats every 15 seconds. The inspected stream handler has no replay cursor/history mechanism.
- [Profiler](../../packages/profiler/src/index.ts): cache insights use fixed ratio thresholds and changes in static-segment hashes; comparison groups sessions by harness and bootstraps turn-level arrays. Those mechanisms support investigation but do not establish cache causality or a controlled harness experiment.
- [API client](../../packages/web/src/api.ts): existing session, turn, insight, call, segment, and blob reads cover most drill-down needs. Session listing requests at most 200 records; any summary over that response must identify its scope rather than imply all-time coverage.

## Ranked patterns implementable now

Ranking weighs immediate decision value and feasibility against the current data. “Now” means an incremental slice using current local infrastructure, not that every desired datum already exists.

### 1. Live session ledger with explicit freshness

**Question answered:** Which session changed, and are the numbers I am looking at current?

**Primary precedent:** Langfuse's shared-ID session grouping establishes the useful navigation unit ([Sessions](https://langfuse.com/docs/observability/features/sessions)). ccusage's historical live monitor illustrates refresh cadence, but is not evidence of current support ([removal notice](https://ccusage.com/guide/live-monitoring)).

**Design:** Use stream events to invalidate a session snapshot, then coalesce authoritative session/turn reads. Keep the session row and selected turn stable while values update. Show “connected,” “reconnecting,” or “offline” separately from “last session update.” Turn the tail into navigable supporting evidence, not the only live surface. A missing session end timestamp means “end not recorded,” not necessarily “running.”

**Data dependencies:** Existing IDs, stream events, session/turn endpoints, and browser receipt timestamps suffice for the first slice. Exact ingestion lag, durable replay, and guaranteed atomic multi-endpoint snapshots would require additional server metadata/contracts. Re-fetch after reconnect instead of assuming replay.

**Acceptance criteria:**

1. A synthetic event updates the relevant session totals and turn table within two seconds on a healthy local connection; unrelated sessions do not steal focus.
2. Repeated or out-of-order invalidations do not add money twice. Older fetch responses cannot overwrite newer route state; reconnect triggers a fresh read.
3. The UI distinguishes transport disconnection from a quiet session. Unknown cost stays unknown, and selected rows/keyboard focus survive updates.

**False-positive risks:** An open connection proves transport availability, not fresh instrumentation. Quiet sessions may be waiting for a human; replayed events may be duplicates. Scope all activity labels accordingly.

**Do not copy:** A globally scrolling event wall, inferred quota alarms, or projections based on a few bursty calls. Preserve existing chart and command-palette interactions while improving the underlying update lifecycle.

### 2. Cost/cache provenance beside the number

**Question answered:** What does this value measure, and can I compare it?

**Primary precedent:** Langfuse distinguishes ingested/inferred values and explains exclusive usage buckets ([cost contract](https://langfuse.com/docs/observability/features/token-and-cost-tracking)); ccusage separates stored and calculated modes ([cost modes](https://ccusage.com/guide/cost-modes)).

**Design:** Keep the existing “Unknown” treatment. Label current costs as recorded cost with billing basis unverified, unless stronger provenance is actually captured. Display capture source/partial coverage beside summaries. Define cache hit as a ratio over a documented canonical total-input denominator, with the raw numerator/denominator available in place. Never silently sum cache reads into already-inclusive input counts.

**Data dependencies:** Current web capture metadata supports partial/unknown labeling, but does not establish pricing source, currency, rate version, or provider input semantics. First slice: expose known capture metadata and mark unavailable provenance explicitly. Reliable normalized comparisons need adapter-level inclusive/exclusive mapping; calculated dollars need persisted model/provider, currency, price schedule/version, and cost method. Do not invent that metadata for old records.

**Acceptance criteria:**

1. Missing, observed-zero, and positive values render distinctly. A partial aggregate cannot appear as a complete total; if a known subtotal is added, label it and show included/total call counts.
2. Synthetic equivalent calls with 100 inclusive input tokens and 60 cached tokens, versus 40 uncached plus 60 cached, both yield 60% after explicit adapter normalization. Unverified semantics yield “ratio unavailable.”
3. Session cache share uses summed compatible numerators divided by summed compatible denominators, not an unweighted mean of call percentages. Zero denominator and invalid ratios produce an explanation, not a clipped chart.

**False-positive risks:** Recorded zero can mean a source-reported zero rather than free inference. Cache availability, warmup, and capture gaps can resemble inefficiency. Subscription entitlement is not established by a token-price estimate.

**Do not copy:** ccusage's documented missing-cost-as-zero behavior in `display` mode ([source](https://ccusage.com/guide/cost-modes)). Do not introduce a savings claim until its counterfactual, rates, cache writes, and coverage are known.

### 3. Evidence-first triage, with hypotheses kept separate

**Question answered:** What deserves inspection, and what evidence supports that judgment?

**Primary precedent:** OpenLIT documents investigation of exceptions, tool failures, latency spikes, and unexpected costs ([README](https://raw.githubusercontent.com/openlit/openlit/main/README.md)); Phoenix documents tracing and replay of traced calls ([README](https://raw.githubusercontent.com/Arize-ai/phoenix/main/README.md)). These establish useful evidence categories, not an automatically proven root cause.

**Design:** Show explicit recorded failures before heuristic opportunities. Each item has an observation, impact with units, evidence link, and a qualified hypothesis when appropriate. “Static segment changed” is an observation; “this caused a cache miss” requires more evidence. Render relevant `Insight.evidence` fields as compact rows with links to turn/call/prompt inspector, retaining raw JSON as a secondary disclosure. Keep user-stopped separate from error.

**Data dependencies:** Existing turn end signals, tool status, call finish reason, insight evidence, blob references, and prompt hashes. Some insights only contain aggregate evidence; show that honestly without fabricating a call link. Missing tool outputs and missing timestamps limit diagnosis. A generic LLM finish reason needs an explicit mapping before being labeled failure.

**Acceptance criteria:**

1. Every triage item exposes its supporting values and scope in one action. Missing blobs show “evidence unavailable,” not an empty successful inspection.
2. Synthetic completed, user-stopped, tool-error, and unknown-status turns remain distinguishable. A recovered tool error is not labeled a failed session without session-level evidence.
3. Prefix changes and low cache ratios are labeled observations/opportunities, not proven causes. Thresholds and eligible sample counts are visible; unknown metrics do not trigger critical efficiency warnings.

**False-positive risks:** Retries can recover; expensive calls can be appropriate; tool errors can be expected search outcomes. Hash changes alone do not establish provider cache boundaries, expiry, or causal impact.

**Do not copy:** A broad evaluation platform or an LLM judge in the ingestion path. Do not make a “critical” badge stand in for evidence, or sum overlapping call latencies and call the result elapsed session time.

### 4. Comparable cohorts before winner labels

**Question answered:** Is the difference about the harness, or about different work and accounting?

**Primary precedent:** Phoenix documents datasets/experiments for tracking changes ([README](https://raw.githubusercontent.com/Arize-ai/phoenix/main/README.md)); OpenLIT documents comparing the same prompt across providers in OpenGround ([README](https://raw.githubusercontent.com/openlit/openlit/main/README.md)). The local profiler need not execute experiments to adopt the distinction between controlled and observational comparisons.

**Design:** Rename the interpretation, not necessarily the route: “observed cohort difference.” Place cohort membership, sample counts, completion status, model mix, and capture completeness beside each delta. Gate confidence/winner language when compatibility cannot be established. Keep the existing compare view, but present a neutral difference rather than “better harness” based solely on cost.

**Data dependencies:** Harness/project/model/session status and calls are available for basic cohort descriptions. Current compare response lacks full provenance and task matching. Initial slice can explicitly mark comparison as unmatched and withhold unsupported judgments; useful cohort filters/counts require extending the local aggregation response. Controlled quality comparisons require future task IDs/outcomes, not user-text similarity guessed in the UI.

**Acceptance criteria:**

1. Every delta identifies direction, units, sessions/turns included, excluded unknown values, and cohort scope. A one-session group does not receive a persuasive confidence claim.
2. Different pricing bases, unknown token semantics, or incomplete captures produce “not comparable” for affected metrics, with a reason; valid unrelated metrics remain inspectable.
3. If uncertainty is retained, resample independent sessions rather than treating correlated turns as independent trials. State the sampling unit; label uncontrolled task/model differences even when an interval excludes zero.

**False-positive risks:** Easier tasks, early cancellation, model mix, session length, and missing telemetry can all create apparent savings. Bootstrap precision cannot repair confounding or absent outcome quality.

**Do not copy:** Harness leaderboards, a universal health score, or green/red winners based on a lower mean alone. Do not replace recorded costs with newly calculated ones silently during comparison.

### 5. A first-event setup path that proves each stage

**Question answered:** Is the local collector reachable, and has this integration actually sent anything?

**Primary precedent:** Phoenix documents a short local-serving path ([README](https://raw.githubusercontent.com/Arize-ai/phoenix/main/README.md)); OpenLIT documents endpoint configuration, instrumentation installation, and a distinct `doctor` command ([README](https://raw.githubusercontent.com/openlit/openlit/main/README.md)).

**Design:** Replace an ambiguous empty table with a compact sequence: collector reachable → integration instructions → first event received → open that session. Provide a project-scoped configuration example and a local synthetic-data option. A successful health request completes only the collector step. Clearly identify fixtures as synthetic and isolate them from ordinary comparisons.

**Data dependencies:** Existing `/healthz`, session reads, stream, and repository setup instructions support the first slice. Integration version/handshake and rejected-ingestion diagnostics are not established by these reads; label those states unverified until instrumented. Historical rows alone do not prove a newly configured integration works.

**Acceptance criteria:**

1. Empty, loading, fetch-failed, connected-but-no-events, and populated states have distinct text and one relevant next action each.
2. A synthetic local run reaches a clearly labeled session without an account, global install, or external telemetry service; fixtures use a disposable database rather than production data.
3. The UI reports first-event success only after a new event attributable to the tested source, and preserves endpoint errors instead of interpreting them as “no sessions.”

**False-positive risks:** A healthy server may have a broken exporter. Old sessions or another application's event can falsely confirm setup. An open browser stream does not demonstrate accepted ingestion.

**Do not copy:** Mandatory multi-service deployment, global agent-config edits, automatic public sharing, or a long wizard before showing usable data. Borrow the diagnostic sequence, not the infrastructure footprint.

## Adversarial improvement cycles

These are explicit self-review passes by this fallback researcher, **not independent-model consensus**. No additional agents were spawned; a separate model review remains a parent-session responsibility if required.

### Cycle 1: challenge the attractive UX proposals

| Initial temptation | Adversarial counterexample | Revised decision |
| --- | --- | --- |
| Increment session totals from each live event. | Delivery duplicates and late snapshots can inflate or regress totals. | Treat events as invalidation hints; read authoritative snapshots and guard response ordering. |
| Red means expensive or low cache. | A correct hard task costs more; an unsupported cache metric looks like a miss. | Reserve failure treatment for explicit outcomes; put threshold-based opportunities in evidence-led triage. |
| Show savings in dollars immediately. | Source cost may be zero or unknown; rates and input buckets may differ. | Show recorded amounts and provenance first; withhold savings counterfactuals. |
| A bootstrap interval proves the better harness. | Turns within one session are correlated and tasks differ. | Show unmatched cohort differences; gate conclusions and use sessions as the sampling unit. |
| Health check means setup complete. | The daemon responds while the exporter is misconfigured. | Require a new, attributable first event. |

### Cycle 2: challenge implementation and information design

| Pressure test | Final constraint |
| --- | --- |
| Can this ship without replacing current chart/⌘K WIP? | Yes: improve data refresh, labels, evidence disclosure, and empty/error states around those existing components. No redesign prerequisite. |
| Does a denser timeline necessarily explain causality? | No: aligned time does not establish cause. Prefer aligned cost/cache small multiples or plainly labeled independent scales; keep the turn table as the exact-value alternative. |
| Does a green dot establish freshness? | No: show transport state and last relevant data receipt separately; do not call receipt time ingestion latency. |
| Can null-safe rendering repair a profiler reading numeric defaults? | No: metric eligibility must be checked before analyzer thresholds/comparisons; UI labeling alone cannot make those results trustworthy. |
| Can provenance be reconstructed from `capture.source`? | No: capture origin is not pricing method. Mark unavailable provenance explicitly and make richer metadata a future ingestion contract. |

## Tufte-oriented review criteria

These are design recommendations, not quotations or claims that a competitor implements Tufte's principles:

- **Evidence adjacent to claims:** exact numerator/denominator, units, coverage, and sample size appear beside the ratio or delta; essential caveats are not tooltip-only.
- **Common coordinates, separate quantities:** share turn alignment across views, retain meaningful zero baselines, and avoid using a relative cost peak as an error color. Do not connect unknown cache values as though measured.
- **High information density without duplicate chrome:** prefer one metric baseline, a compact turn ledger, and direct annotations over repeated cards, gauges, and legends.
- **Progressive evidence disclosure:** session → turn → call → captured payload; keep navigation and selected context stable. Every visual finding must also be readable and reachable through text/keyboard controls.
- **Show uncertainty rather than erase it:** distinguish unknown, partial, stale, estimated, recorded, and incomparable. A precise decimal is not evidence of a precise measurement.

## Recommended next implementation slice

Implement pattern 1's coalesced session refresh and truthful connection state, together with pattern 2's existing capture/unknown labels. Verify with synthetic duplicate, reordered, reconnect, and partial-usage cases in a disposable local database. Then expose `Insight.evidence` before expanding heuristics or adding chart types.

This research changed only this document. It used repository source and public first-party documentation, not private sessions or communications.
