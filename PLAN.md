# Harness Profiler — v1 Plan

A local-first, web-based profiler for AI **agent harnesses** (dev tools like OpenCode
and VS Code Copilot) and, later, deployed agents. It is the "Datadog APM for agents,"
but the v1 wedge is the **local harness developer**: someone iterating on prompts,
tools, MCPs, and model choices who needs to see *why* one harness underperforms another.

It replaces Arize Phoenix / Raindrop Workshop as the analysis surface for the traces
emitted by `opencode-openinference`, with a faster, prettier, keyboard-driven UI and
**statistical / classical-ML profiling** (no LLM-as-judge in the hot path).

---

## 0. Decisions locked from Q&A

| Decision | Choice |
|---|---|
| Ingestion | **Own OTLP/HTTP collector + own embedded store** (no Phoenix dependency). Pluggable source adapters later. |
| Stack | **TypeScript everywhere** — Bun server (OTLP + REST/SSE), React + Vite SPA, embedded analytical DB. |
| Plugin scope | **Extend capture** via a new `@harness-profiler/opencode` capability, but keep the profiler **decoupled behind a documented schema** so it degrades gracefully without it. |
| v1 analyses | All six: session/turn explorer, latency+token attribution, prompt-cache efficiency, system-prompt composition/bloat, model right-sizing, cross-harness comparison. |

---

## 1. What we already have (verified)

`opencode-openinference` (sibling repo) already emits a correlated **OpenInference**
span tree over OTLP/HTTP-proto:

```
CHAIN session <id>           session.id, agent.name, user.id
  └ CHAIN turn <messageID>    input.value (user), output.value (assistant), metadata{messageID,agent,model}
       ├ LLM chat <model>     llm.input_messages[], llm.output_messages[],
       │                      llm.token_count.{prompt,completion,total,
       │                        completion_details.reasoning,
       │                        prompt_details.cache_read, prompt_details.cache_write},
       │                      llm.cost.total, llm.model_name, llm.provider,
       │                      llm.invocation_parameters (JSON)
       ├ TOOL read            tool.name, tool.id(callID), input.value(args),
       │                      output.value, tag.tags=["tool","tool:read"]
       ├ TOOL datadog_search… tag.tags=["mcp","mcp:datadog"]
       └ TOOL skill:graphify  tag.tags=["skill","skill:graphify"]
```

This gives us, **today**, for free: per-turn/per-session latency & token/cost,
cache-read/write counts, per-tool/MCP/skill attribution, the assembled system prompt
text (as `input_messages.0`), and full prompts/responses/tool I/O.

### What it does NOT capture today (the gaps the headline features need)

Confirmed by reading OpenCode source:

1. **Tool/MCP definitions** (the JSON schemas + descriptions sent to the model).
   `resolveTools()` builds them (`session/llm/request.ts:174`) but **no plugin hook
   exposes them.** Required for "tool defs bloat the system prompt / break caching."
2. **True per-source system-prompt provenance.** The system chunks
   (`agent.prompt` / `SystemPrompt.provider`, `input.system`, `user.system`) are
   `.join("\n")`-ed into **one string before** `experimental.chat.system.transform`
   fires (`session/llm/request.ts:58-78`). The hook sees `system: string[]` already
   collapsed — so "which plugin/skill contributed which bytes" is **not cleanly
   recoverable from the public hook surface.**
3. **The final on-the-wire prompt** (after provider transforms). Available only inside
   OpenCode's LM middleware `transformParams(args)` (`session/llm.ts:330`,
   `args.params.prompt`).

**Implication:** the differentiating analyses (tool-def bloat, prompt provenance) need a
capture mechanism deeper than today's hooks. See §4.

---

## 2. Architecture

```
┌──────────────── emitters (harnesses) ────────────────┐
│  OpenCode + opencode-openinference (OTLP today)       │
│  OpenCode + @harness-profiler/opencode (richer)       │
│  VS Code Copilot  ── (no token/prompt API) ──┐        │
└───────────────────────────────────────────────┼──────┘
        │ OTLP/HTTP-proto (/v1/traces)           │ HTTP(S)
        ▼                                        ▼
┌──────────────────── harness-profiler (Bun) ──────────────────┐
│  Ingest                                                       │
│   • OTLP/HTTP collector (proto + json)  → normalize → store   │
│   • Provider proxy (records real LLM HTTP req/resp) ──┐       │
│   • Source adapters (Phoenix import, OpenCode native) │later  │
│  Store: embedded analytical DB (DuckDB primary; SQLite fallbk)│
│  Profiling engine (classical stats/ML, runs on ingest+demand) │
│   cache · prompt-composition · model-rightsizing · attribution│
│  API: REST (query) + SSE (live tail)                          │
└───────────────┬───────────────────────────────────────────────┘
                │ REST/SSE
                ▼
   React + Vite SPA  (Cmd-K omnibar, explorer, profiles, compare)
```

**Single distributable:** `bunx @harness-profiler/server` boots collector + API + serves
the built SPA on one port (e.g. `http://localhost:7070`). The user repoints
`opencode-openinference`'s `endpoint` at it. Zero external services.

### 2.1 Why our own OTLP collector + store
- Removes the buggy Phoenix/Raindrop dependency (the stated goal).
- Lets us own a **profiling-shaped schema** (flat fact tables for sessions/turns/llm-calls/
  tools + a derived `prompt_segments` table) instead of fighting Phoenix's generic span
  store — critical for fast statistical queries.
- Works for **any** OpenInference OTLP emitter, not just OpenCode.

### 2.2 Storage choice
- **DuckDB** (embedded, columnar, superb analytical aggregates, `bun:ffi`/node binding)
  as primary; raw spans archived as Parquet/NDJSON for replay & reprocessing.
- Spike DuckDB-under-Bun first; **SQLite (bun:sqlite, built in) is the guaranteed
  fallback** if the DuckDB binding is rough. Schema written DB-agnostic via a thin DAL.

### 2.3 Data model (normalized at ingest)
```
session(id, harness, agent, model, project, user, started_at, ended_at,
        turn_count, llm_call_count, tool_call_count,
        tokens_*, cost_total, end_reason)
turn(id, session_id, idx, user_text, assistant_text, started_at, ended_at,
     llm_round_trips, tokens_*, cost, status, end_signal)        -- end_signal: completed|user_stopped|error
llm_call(id, turn_id, session_id, model, provider, params_json,
         prompt_tokens, completion_tokens, reasoning_tokens,
         cache_read_tokens, cache_write_tokens, cost,
         latency_ms, finish_reason, input_messages_ref, output_ref)
tool_call(id, turn_id, session_id, name, kind, server, skill,
          args_ref, output_ref, latency_ms, tokens_out_est, status)
prompt_segment(llm_call_id, ord, source_kind, source_name, char_len,
               token_est, sha256, is_static, contributed_by)      -- enriched capture (§4)
tool_def(session_id, name, kind, schema_json, schema_tokens_est, sha256) -- enriched capture (§4)
blob(ref, mime, bytes)   -- large prompt/tool bodies kept out of fact tables
```
`*_ref`/`blob` keep big text out of the hot path; the SPA fetches bodies lazily.

---

## 3. The profiling engine (classical, no LLM in the hot path)

Each analyzer is a pure function over the normalized tables, run incrementally on
ingest and on-demand. Every finding is a typed `Insight{ severity, scope, evidence,
metric, suggestion }` so the UI renders them uniformly and they're testable.

### 3.1 Prompt-cache efficiency
- **Cache hit ratio** per llm_call/turn/session = `cache_read / prompt_tokens`.
- **Cold-prefix detector:** compare the `sha256` of the *static* prompt prefix
  (system + tool_defs, from §4) across consecutive calls in a session. A changed prefix
  hash with low `cache_read` ⇒ flag "cache-busting prefix change" and **diff what changed**
  (which segment's hash moved). This is the quantified version of the VS Code Copilot finding.
- **Volatility score:** % of calls whose prefix differs from the prior call.
- Stats: rolling ratios, simple change-point on the prefix-hash stream; thresholds with
  hysteresis to avoid noise. No model needed.

### 3.2 System-prompt composition & bloat
- Render the **full system prompt**, segmented by `source_kind`/`source_name`
  (instructions, agent prompt, each tool/MCP definition, skills) — requires §4 enriched
  capture; **degrades** to "whole-prompt view, unattributed" on base spans.
- Per-segment **token estimate** (offline tokenizer, e.g. `tiktoken`/`@dqbd/tiktoken`;
  ~character heuristic fallback). Treemap of "who owns the context window."
- **Bloat flags:** tool-definition tokens as a share of prompt; duplicate/near-duplicate
  segments (hashing + shingled Jaccard); segments that are large *and* static-but-late
  (placed after volatile content, hurting cache).

### 3.3 Latency & token attribution
- Roll up latency/tokens/cost by tool, MCP server, skill, model, agent, turn.
- Round-trips per turn; slowest/most-expensive contributors; p50/p95 per dimension.
- "Tax" view: tokens spent on tool *definitions* and tool *outputs* vs. actual reasoning.

### 3.4 Model right-sizing (over/under-powered)
Heuristic signals combined into a per-turn/session score:
- **Under-powered signals:** `end_signal=user_stopped` (premature stop / runaway),
  a follow-up user turn that looks corrective (short, negmunged — detected with a small
  rules/lexicon classifier on the *user's* text, not an LLM), many round-trips with
  repeated tool retries, error finishes.
- **Over-powered signals:** task **succeeded** (no correction, no stop) but token/cost is a
  statistical outlier for that task class — robust z-score / IQR on cost per
  comparable turn (grouped by agent + rough task embedding via cheap TF-IDF clustering,
  *not* an LLM).
- Output: "consider a smaller/cheaper model here" / "consider a stronger model here,"
  with the evidence (the stop, the correction, or the cost outlier).
- All techniques: z-score/IQR outliers, TF-IDF + k-means clustering, a tiny rules-based
  corrective-message detector. Explicitly **no LLM-as-judge** in v1 (could be an opt-in
  enrichment later).

### 3.5 Cross-harness comparison
- Tag sessions with `harness` (`opencode`, `vscode-copilot`, …).
- Compare aggregate cache-hit ratio, tokens/turn, cost/turn, latency/turn, prompt-bloat,
  success proxy across harnesses on comparable tasks.
- Report deltas **with uncertainty** (mean diff + bootstrap CI), echoing how mature teams
  report evals (the gist's "Δ = −5.1%, 95% CI"). This is the "why does dev.vsix
  underperform" answer, quantified.

---

## 4. Enriched capture — `@harness-profiler/opencode` + provider proxy

Two complementary mechanisms; the profiler consumes whatever is present.

### 4.1 Extended OpenInference schema (documented, optional)
New span attributes the profiler reads if available, ignores if absent:
- `prompt.segments` (JSON array): `[{ord, source_kind, source_name, char_len, sha256}]`.
- `llm.tools.definitions` (JSON): the tool/MCP schemas+descriptions actually sent.
- `prompt.static_prefix.sha256`, `prompt.static_prefix.tokens` (for cache analysis).
Publishing this schema **decouples** profiler progress from plugin progress.

### 4.2 Capture mechanism — pick one (DECISION NEEDED, see §8)
Because tool-defs + final prompt aren't on the public hooks, choose how to get them:

- **(A) Upstream hook in OpenCode** — add `experimental.chat.request.transform({prompt,
  tools})`. Cleanest, but gated on merging into OpenCode; timeline risk.
- **(B) Local LM-middleware capture** — a plugin/module that wraps the language model
  (mirroring `wrapLanguageModel` at `session/llm.ts:325`) and records `args.params.prompt`
  + `prepared.tools`. No upstream dependency; OpenCode-specific; some internal coupling.
- **(C) Provider proxy** (recommended to build regardless) — a localhost OTLP-adjacent
  HTTP proxy that OpenCode/Copilot point their provider base-URL at; records the **exact**
  request body (final prompt, full tool defs) and response (usage incl. cache). 
  - **Only mechanism that also works for VS Code Copilot** — the gist confirms `vscode.lm`
    exposes **no** token/prompt/cache data to extensions, so a proxy is the *sole* way to
    observe Copilot. This directly serves the cross-harness goal.
  - Harness-agnostic, captures ground truth (what's billed/cached), but adds TLS/auth
    plumbing and per-provider request shaping.

**Recommendation:** ship **(C) the proxy as the harness-agnostic ground-truth path** AND
keep **(B)** as the zero-config OpenCode-native path; pursue **(A)** upstream
opportunistically. The profiler treats all three as feeders of the §4.1 schema.

---

## 5. The web UI

React + Vite SPA, local-first, designed for speed and keyboard control.

### 5.1 Cmd-K Omnibar (first-class)
- Global `⌘K` opens a command palette (e.g. `cmdk`): jump to any session/turn, run any
  analyzer, switch harness/compare mode, filter by model/agent/tool/MCP/skill, copy the
  full system prompt, toggle live tail, open settings. Every page/action is reachable
  from the omnibar.

### 5.2 Core views
1. **Sessions/Turns Explorer** (table-stakes): virtualized table of sessions → turns,
   sortable/filterable by tokens, cost, cache-hit, latency, end-signal, harness, model.
   Drill into a turn → span-tree timeline (waterfall) + full prompt/response/tool I/O.
3. **System-Prompt Inspector:** the full assembled prompt with a **provenance gutter**
   (color-coded by source) + per-segment token treemap + bloat/duplication flags
   (degrades gracefully without §4 data).
4. **Cache Panel:** hit-ratio over time, prefix-volatility, and a **prefix diff** between
   two calls highlighting the cache-busting change.
5. **Model Right-Sizing:** flagged turns (over/under-powered) with the evidence inline.
6. **Compare:** pick 2+ harnesses (or agents/models) → side-by-side metric deltas with CIs.
7. **Live tail:** SSE stream of incoming turns while a session runs.

### 5.3 Aesthetic
Dense, dark, monospace-leaning, fast (virtualization everywhere). Insights surfaced as
quiet badges, not modal noise.

---

## 6. Repo layout (monorepo, Bun workspaces)

```
harness-profiler/
├─ package.json                 # workspaces; root scripts (dev/build/test)
├─ packages/
│  ├─ schema/                   # shared TS types + the extended OpenInference schema (§4.1)
│  ├─ ingest/                   # OTLP collector (proto+json), normalizer → store
│  ├─ store/                    # DAL; DuckDB primary, SQLite fallback; migrations; blob store
│  ├─ profiler/                 # analyzers (cache, composition, rightsizing, attribution,
│  │                            #   compare); tokenizer; stats utils; Insight types
│  ├─ proxy/                    # provider proxy capture (§4.2 C) — harness-agnostic
│  ├─ server/                   # Bun HTTP: mounts ingest + REST/SSE API + serves web build
│  └─ web/                      # React+Vite SPA (omnibar, explorer, inspectors, compare)
└─ integrations/
   └─ opencode/                 # @harness-profiler/opencode (LM-middleware capture, §4.2 B)
```
`schema` is the contract shared by `opencode-openinference`/integrations and the profiler.

---

## 7. Milestones

- **M0 — Spikes / decision gates (½–1 day)**
  - DuckDB-under-Bun smoke (else commit to SQLite). 
  - OTLP/HTTP-proto ingest: accept one real `opencode-openinference` trace, persist it.
  - Provider-proxy feasibility: capture one real OpenCode→provider request body + usage.
- **M1 — Ingest + store + Explorer (2–3 days)**
  - OTLP collector → normalize → store; REST query API; SSE live tail.
  - SPA shell + **Cmd-K omnibar** + Sessions/Turns Explorer + turn waterfall + body viewer.
  - *Deliverable:* point `opencode-openinference` at us; browse real sessions, no Phoenix.
- **M2 — Attribution + Cache analyzers (2 days)**
  - Latency/token attribution rollups; cache hit-ratio + prefix-volatility + prefix-diff.
  - Cache Panel + attribution views.
- **M3 — Enriched capture (2–3 days)**
  - `@harness-profiler/opencode` LM-middleware capture (B) + provider proxy (C) emit the
    §4.1 schema (tool-defs, prompt segments, static-prefix hash).
  - System-Prompt Inspector with provenance + bloat/duplication flags.
- **M4 — Model right-sizing + Compare (2–3 days)**
  - Corrective-message detector, cost-outlier (z/IQR), TF-IDF task clustering;
    right-sizing view. Cross-harness Compare with bootstrap CIs.
  - Capture a VS Code Copilot session **via the proxy** to validate cross-harness.
- **M5 — Hardening / DX (1–2 days)**
  - `bunx @harness-profiler/server` one-command start; docs; retention/pruning; redaction
    parity with the plugin; tests across packages.

---

## 8. Open decisions for you

1. **Enriched-capture mechanism (§4.2):** OK to build **proxy (C) + LM-middleware (B)** and
   treat upstream hook (A) as opportunistic? (Proxy is the only path that unlocks VS Code
   Copilot for cross-harness comparison.)
2. **Storage:** DuckDB-primary with SQLite fallback acceptable, or prefer SQLite-only for
   simplicity in v1?
3. **Cross-harness scope in v1:** is VS Code Copilot a *must-have* for v1 (drives proxy
   priority), or is OpenCode-only acceptable for v1 with Copilot in v2?
4. **Tokenizer dependency:** OK to vendor an offline tokenizer (`@dqbd/tiktoken`) for token
   estimates, accepting approximate counts for non-OpenAI models?
5. **Naming/packages:** confirm `@harness-profiler/*` scope and the integration package
   name `@harness-profiler/opencode`.
6. **"No LLM under the hood":** confirm LLM-as-judge stays fully out of v1 (optional opt-in
   enrichment only, clearly separated), per your preference for classical techniques.
```
