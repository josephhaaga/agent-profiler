# agent-profiler

Local-first profiler for AI agent harnesses. The "Datadog APM for agents" — but the v1
wedge is the **local harness developer** iterating on prompts, tools, MCPs, and model
choices who needs to see *why* one harness underperforms another.

Replaces Arize Phoenix / Raindrop Workshop as the analysis surface for OpenInference
OTLP traces, with a faster, keyboard-driven UI and **statistical / classical-ML
profiling** (no LLM-as-judge in the hot path).

## Quickstart

### 1. Start the server

```bash
bun dev
# Listening on http://localhost:7070
#   OTLP endpoint: http://localhost:7070/v1/traces
#   Web UI:        http://localhost:7070/
```

### 2. Install the OpenCode plugin

Add one line to your `opencode.json` (project or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-agent-profiler"]
}
```

OpenCode auto-installs the plugin from npm on next startup. Restart OpenCode and traces
will start flowing to `http://localhost:7070/v1/traces`.

The plugin warns via `client.app.log` if the server is not reachable at startup — it
never blocks the agent.

### 3. Open the UI

```bash
open http://localhost:7070
```

### Options

Point the plugin at a non-default host (e.g. a shared team server):

```json
{
  "plugin": [["opencode-agent-profiler", { "endpoint": "http://my-server:7070/v1/traces" }]]
}
```

Or set the env var before launching OpenCode:

```bash
AGENT_PROFILER_ENDPOINT=http://my-server:7070/v1/traces opencode
```

| Option | Env var | Default | Description |
|--------|---------|---------|-------------|
| `endpoint` | `AGENT_PROFILER_ENDPOINT` | `http://localhost:7070/v1/traces` | OTLP traces URL |
| `captureContent` | `OI_CAPTURE_CONTENT` | `true` | Capture prompt/response text |
| `disabled` | `AGENT_PROFILER_DISABLED` | `false` | Disable the plugin entirely |
| `projectName` | — | `opencode` | Label traces by project in the UI |
| `hideInputs` | `OPENINFERENCE_HIDE_INPUTS` | `false` | Redact all input content |
| `hideOutputs` | `OPENINFERENCE_HIDE_OUTPUTS` | `false` | Redact all output content |

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
  opencode/  opencode-agent-profiler — OpenCode plugin: ships OpenInference OTLP traces
             to agent-profiler. Includes enriched span attributes (tool definitions,
             prompt segments, static-prefix hash) via the opencode plugin hook surface.
```

## Architecture

```
opencode + opencode-agent-profiler (npm plugin)
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

Use `opencode-agent-profiler` (the OpenCode plugin) to emit these — it is included
automatically when the plugin is active. The `@agent-profiler/proxy` (provider proxy)
also captures VS Code Copilot traffic.

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
