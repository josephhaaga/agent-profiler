# Local harness diagnostics: value gaps

**Scope.** Research for useful, immediately local diagnostics in agent-profiler, using its current stored session/turn/LLM-call/tool-call, token/cache/cost/status and blob data. No account connection, user configuration, remote service, or LLM judge should be required. This is a source-based desk review, not a multi-model consensus or product validation; external search was rate-limited, so claims below are confined to first-party docs/repositories successfully inspected. No personal session, Slack, or production data was used.

## What adjacent tools establish

- [ccusage README](https://github.com/ccusage/ccusage) describes local-file reports for coding-agent usage, including session/model breakdowns, cache read/write counts, cost, filtering and JSON output. **Implication:** local spend/usage reporting is already a well-served baseline; differentiate by explaining behavior and actionable inefficiency, not another usage ledger.
- [Arize Phoenix docs: tracing](https://arize.com/docs/phoenix/tracing/llm-traces) describe tracing a run across model calls, retrieval, tools and custom logic, with timelines and error/performance diagnosis. Its [evaluation docs](https://arize.com/docs/phoenix/evaluation/llm-evals) include deterministic checks as well as judge-based scoring. **Implication:** trace navigation and model/tool sequence are expected; judge scoring is a separate, opt-in workflow, not a prerequisite for local diagnostics.
- [Langfuse docs: data model](https://langfuse.com/docs/observability/data-model) model observations as nested steps, traces as a request/run, and sessions as groups of traces. Its [cost tracking docs](https://langfuse.com/docs/observability/features/token-and-cost-tracking) distinguish ingested usage/cost from inferred values using model prices. **Implication:** preserve provenance and uncertainty for estimated costs; avoid presenting estimates as provider-billed truth.
- [OpenLIT README](https://github.com/openlit/openlit) documents coding-agent observability spanning LLM/tool activity, token usage, cost, and code impact, using OpenTelemetry. It also promotes evals, guards, prompt/context management and integrations. **Implication:** harness-oriented signals are valuable, but broad policy/quality platforms exceed this repo's local, no-setup wedge.
- [OpenTelemetry GenAI client span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) define operation spans through completion/error/cancellation and identify tools and inference operations; the conventions are marked **Development**. The [GenAI metrics conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/client-inference.md) call token usage recommended when readily available and explicitly discuss input/output usage. **Implication:** use familiar concepts and labels, but do not treat the evolving convention as a stable schema mandate.

## Current data affordances

The local schema in [`packages/schema/src/index.ts`](../../packages/schema/src/index.ts) already has session and turn totals, LLM calls with model/provider, token categories, cache reads/writes, cost, latency and finish reason; tool calls have name/kind, latency, estimated output tokens and status. Prompt segments and tool definitions have token estimates, hashes and source names; LLM/tool inputs and outputs may be represented by blob refs. Turns expose status/end signal. `Insight` exists as a typed shape, but this review does not establish that it is populated today. The schema does not obviously encode all retry/attempt lineage, exact user intent/outcome, or a universally reliable distinction between missing and zero metrics; recommendations below avoid assuming those.

## Ranked opportunities

Scores: **Value / evidence reliability / false-positive risk / effort** are qualitative High, Medium, Low; false-positive risk is best when Low. Effort estimates are relative, assuming current schema and existing UI; they are not implementation commitments.

| Rank | Opportunity | Why now / local signal | Value | Evidence reliability | False-positive risk | Effort |
|---|---|---|---|---|---|---|
| 1 | **Session/turn cost-and-latency outlier triage**: rank the most expensive/slow turns and show contributing calls, model, tokens, cache, and tool time; link directly to evidence. | Already captured totals, per-call latency/cost/tokens and tool latency. Gives an immediate answer to “what made this run expensive or slow?” without inference. | High | High (observed fields + common trace workflow) | Low | Low–Medium |
| 2 | **Repeated-work / context-growth clues**: surface prompt segment and tool-definition token estimates over a session, highlight repeated large static segments and changed hashes, and show cache read/write alongside prompt volume. | Prompt segments/tool defs include source, estimates and hashes; calls include cache data. Phrase as “large/repeated context” evidence, not “waste” or “bad cache,” because estimates and provider semantics vary. | High | High for recorded sizes; Medium for interpretation | Medium | Medium |
| 3 | **Failure and incomplete-run inbox**: filter turns/calls/tool calls by explicit error or stopped status/end signal; distinguish error, user stop, and missing/unknown status; show final finish reason and the sequence preceding it. | Status/end-signal and finish-reason fields exist, and trace inspection is a core pattern in Phoenix/Langfuse. Only emit a failure diagnosis when explicit status supports it. | High | High | Low with strict unknown handling | Low–Medium |
| 4 | **Tool-loop / tool-time inspection**: show per-turn call count, repeated tool names, cumulative tool latency, status and approximate output size; flag exact repeated calls as a review cue, not proof of looping. | Tool calls already retain name, status, latency and estimated output tokens. Coding harness tools specifically make tool behavior relevant (OpenLIT). | Medium–High | Medium–High | Medium (legitimate repeated reads/searches happen) | Medium |
| 5 | **Prompt/tool schema footprint and change comparison**: compare segment/tool-definition hashes and estimated tokens between sessions or turns to explain prompt growth. | Schema has hashes, source names and estimates; local deterministic comparison needs no account or judge. Useful once a baseline view exists. | Medium | High for hash/size changes; Medium for causal attribution | Low–Medium | Medium |

### Scoring caveat

Reliability means confidence that the cited sources support the general product pattern and that the stored fields support displaying evidence; it does **not** prove users rank that problem first. Avoid threshold-based “bad behavior” warnings until validated against representative, non-personal fixtures and reviewed examples. No performance, cost savings, or user demand is claimed.

## What not to build first

- Another generic daily/monthly cost dashboard: ccusage already handles local usage reports and cost breakdowns.
- LLM-as-judge quality scores, automatic “agent did the wrong thing” diagnoses, or opaque composite grades: they require buy-in/configuration and introduce cost, privacy and false-positive concerns.
- Account/cloud integrations, hosted ingestion, alerts, team/user billing, prompt management, guardrails or broad OTel export: useful in larger platforms, but contrary to the no-setup local-diagnostics goal.
- Hard-coded universal “optimal” token, cache-hit, latency, or tool-call thresholds. Providers, model pricing, workload, cache semantics and status completeness vary.
- Claims of causal waste based only on repeated prompt text, tool calls, cache counts, or cost estimates. Show raw evidence and uncertainty instead.

## Recommendation

Start with ranks 1 and 3: deterministic, low-risk ways to locate costly/slow and explicitly incomplete work. Add rank 2 as an evidence panel, not an automated verdict. Keep diagnostics explainable, link each one to its underlying turn/call/blob where available, and distinguish recorded values, estimates, and absent data.
