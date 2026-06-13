# agent-profiler

Local-first profiler for AI agent harnesses. The "Datadog APM for agents" — but the v1
wedge is the **local harness developer** iterating on prompts, tools, MCPs, and model
choices who needs to see *why* one harness underperforms another.

Replaces Arize Phoenix / Raindrop Workshop as the analysis surface for OpenInference
OTLP traces, with a faster, keyboard-driven UI and **statistical / classical-ML
profiling** (no LLM-as-judge in the hot path).

## Quickstart

```bash
# Start the server (OTLP collector + REST API + web UI on one port)
bun dev

# Open the UI
open http://localhost:7070

# Point opencode-openinference at the OTLP endpoint
# In your opencode config: OPENINFERENCE_COLLECTOR_ENDPOINT=http://localhost:7070
```

## What it does

- **Ingests** OpenInference OTLP/HTTP-JSON traces from any harness
- **Normalizes** spans into a structured SQLite schema (sessions → turns → LLM calls + tool calls)
- **Profiles** every session automatically with five classical analyzers:
  - **Cache efficiency** — hit ratio, prefix-volatility score, cache-busting change detection
  - **Latency & token attribution** — per-tool, per-model rollups with p50/p95
  - **Prompt composition** — segment treemap, tool-def bloat detection, duplicate detection
  - **Model right-sizing** — under/over-powered turn flags (corrective messages, error finishes, cost z-scores)
  - **Cross-harness comparison** — metric deltas with 95% bootstrap confidence intervals
- **Streams** live events over SSE as traces arrive
- **Serves** a keyboard-driven React SPA on the same port

## Packages

```
packages/
  schema/    Shared TypeScript types (SessionRecord, TurnRecord, LlmCallRecord, …)
  store/     SQLite DAL — 8-table schema, all CRUD + analytics queries
  ingest/    OTLP/HTTP-JSON collector + span normalizer
  profiler/  Five classical analyzers → typed Insight objects
  proxy/     Provider proxy: captures exact on-wire prompts + usage (works with VS Code Copilot)
  server/    Bun HTTP: mounts ingest + REST/SSE API + serves SPA
  web/       React + Vite SPA — sessions explorer, turn waterfall, cache panel,
             prompt inspector, compare view, ⌘K omnibar, SSE live tail

integrations/
  opencode/  @harness-profiler/opencode — LM-middleware capture for richer span attributes
             (tool definitions, prompt segments, static-prefix hash)
```

## Architecture

```
opencode + opencode-openinference
        │ OTLP/HTTP-JSON  (/v1/traces)
        ▼
  agent-profiler server  (:7070)
  ├─ ingest → normalize → SQLite store
  ├─ profiler (runs on ingest + on-demand POST /api/sessions/:id/profile)
  ├─ REST API  /api/sessions  /api/turns/:id  /api/llm-calls/:id/segments  …
  ├─ SSE tail  /api/stream
  └─ static SPA
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/traces` | OTLP/HTTP-JSON trace ingest |
| `GET` | `/api/sessions` | List sessions (`?limit=`) |
| `GET` | `/api/sessions/:id` | Session detail |
| `GET` | `/api/sessions/:id/turns` | Turns for a session |
| `GET` | `/api/sessions/:id/insights` | Profiler insights for a session |
| `POST` | `/api/sessions/:id/profile` | Run profilers on demand |
| `GET` | `/api/turns/:id` | Turn detail |
| `GET` | `/api/turns/:id/llm-calls` | LLM calls for a turn |
| `GET` | `/api/turns/:id/tool-calls` | Tool calls for a turn |
| `GET` | `/api/llm-calls/:id/segments` | Prompt segments for an LLM call |
| `GET` | `/api/blobs/:ref` | Retrieve stored prompt/tool body |
| `GET` | `/api/insights` | Insights (`?scopeType=&scopeId=`) |
| `GET` | `/api/compare` | Cross-harness metrics + bootstrap CIs (`?harnesses=`) |
| `GET` | `/api/stream` | SSE live tail |
| `GET` | `/healthz` | Health check |

## Enriched capture (optional)

The profiler degrades gracefully on base OpenInference spans. Richer analyses
(prompt-segment treemap, cache-busting diffs) unlock when spans include:

```
prompt.segments           JSON: [{ord, source_kind, source_name, char_len, sha256, token_est, is_static}]
llm.tools.definitions     JSON: [{name, kind, schema, description}]
prompt.static_prefix.sha256
prompt.static_prefix.tokens
```

Use `@harness-profiler/opencode` (LM-middleware capture, zero upstream dependency) or
`@agent-profiler/proxy` (provider proxy, also captures VS Code Copilot) to emit these.

## Development

```bash
bun install          # install workspace deps
bun run build        # build all packages
bun run typecheck    # typecheck all packages
bun test             # run tests (47 tests across store, ingest, profiler)
bun dev              # start server in dev mode (hot reload)
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_PROFILER_PORT` | `7070` | Server port |
| `AGENT_PROFILER_DB_PATH` | `./agent-profiler.sqlite` | SQLite database path |
