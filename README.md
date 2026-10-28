# agent-profiler

Local-first profiler for AI agent harnesses. Captures OpenInference OTLP traces
from OpenCode (and other harnesses), stores them in SQLite, and serves a
keyboard-driven web UI with evidence-led findings, recorded-error triage,
cache accounting, prompt inspection, and descriptive cross-harness comparison.

**Local development preview:** the improvements below, including `demo`, are
unpublished. The npm release does not yet include them. Run this checkout's
build to try them without replacing an installed collector.

### Try synthetic data without instrumentation

```bash
bun install
bun run build
bun packages/cli/dist/index.js demo
```

This opens a temporary loopback collector with ordinary, recorded-error, and
missing-usage examples. No agent, account, model call, or API key is required.
Your real database and daemon are unchanged. Press Ctrl+C to stop and delete
the disposable demo database. Add `--no-open` to print the URL without opening
a browser.

## Install

```bash
npx @josephhaaga/agent-profiler start
```

No clone or cloud account is required. `npx` downloads the CLI, collector,
and dashboard. **The collector currently requires Bun on your PATH**; the CLI
itself is Node-compatible. If Bun is missing, the command reports how to install
it rather than silently downloading another runtime.

The server starts as a background daemon on `http://localhost:7070`. Its data
persists in `~/.agent-profiler/`. A PID file does not restart a process after
reboot; automatic startup requires an OS service (provided by the author's
dotfiles deployment).

## Quickstart

### 1. Start the server

```bash
npx @josephhaaga/agent-profiler start
# agent-profiler started (PID 12345) — http://localhost:7070
#   log: ~/.agent-profiler/agent-profiler.log
```

### 2. Install the OpenCode plugin

Add one line to your `opencode.json` (project-level or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-agent-profiler"]
}
```

This integration targets **OpenCode V2 (2.2.0 or newer)**. V1 plugin releases
(including `opencode-agent-profiler@0.3.0`) cannot run in V2; use a release
containing the V2 port, or build this checkout and configure its absolute
`integrations/opencode` directory as the plugin package.

OpenCode installs package plugins automatically. Traces flow to
`http://localhost:7070/v1/traces` after the plugin loads.

The plugin warns in the server log if the collector is unreachable at startup.
It never blocks the agent.

### 3. Open the UI

```bash
npx @josephhaaga/agent-profiler open
```

## CLI reference

```
agent-profiler start       Start the server as a background daemon
agent-profiler stop        Stop the background daemon
agent-profiler status      Show running/stopped, PID, and health
agent-profiler logs        Print the last 100 lines of server logs
agent-profiler logs -f     Tail server logs (follow mode)
agent-profiler open        Open the web UI in your browser
agent-profiler import opencode   Import historical OpenCode V2 sessions
agent-profiler demo [--no-open]  Explore disposable synthetic data (local preview)
```

### Import existing OpenCode sessions

With the collector and OpenCode service running:

```bash
agent-profiler import opencode
# Or import just one session:
agent-profiler import opencode --session ses_...
```

The importer reads OpenCode's session export API, not its SQLite tables. It
pages through active and archived sessions and groups records under the **original OpenCode
session ID**. Repeating an import is safe. Live and imported calls share source
message/tool IDs, and live prompt evidence is preserved.

Use `--endpoint http://127.0.0.1:7070` to select a collector (base URL, not
`/v1/traces`). By default the CLI discovers and authenticates to the local
OpenCode service without starting it. Use `--opencode-url URL` for an explicit
service, with `OPENCODE_TOKEN` if it requires bearer authentication. Both the
CLI and collector must be upgraded to a version supporting import.

Imported history is labeled **partial**:

- Recorded input/output/reasoning tokens, cache reads/writes, cost, model,
  assistant output, and assistant tool inputs/results are retained when present.
- Unknown metrics are `null` in the REST API and shown as **Unknown** in the UI;
  recorded zeros stay zero. Aggregate metrics are unknown if any contributing
  call lacks that metric. Incomplete sessions are excluded from numeric
  recommendations and comparisons rather than treated as zero.
- OpenCode V2 input excludes cache tokens; profiler prompt input includes input
  plus cache reads and writes. Cached-input share is cache reads divided by that
  prompt total, not a diagnosis of provider-side cache misses.
- Exact outgoing prompts, provider retries, historical tool inventories, and
  detailed network timing are not reconstructed. Recorded cost is not necessarily
  billed spend, especially with subscription/OAuth providers.
- Older collector records without retained source message IDs cause that session
  to be **explicitly skipped**; matching by text or timing would risk duplicates.

The collector stores a lossless exported-session snapshot, referenced by
`session.capture.sourceRef`, including synthetic/metadata messages that do not
appear as model calls. Import includes unredacted saved content and does **not**
apply the live plugin's content-redaction settings. Keep the collector and its
database private. OpenCode's source database is never modified. A session is
written atomically; if a later session fails, earlier successful imports remain
and rerunning the command resumes safely through deduplication.

## Plugin options

Point the plugin at a non-default host (e.g. a shared team server):

```json
{
  "plugins": [{ "package": "opencode-agent-profiler", "options": { "endpoint": "http://my-server:7070/v1/traces" } }]
}
```

Or via environment variable:

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

## Server environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_PROFILER_PORT` | `7070` | Server port |
| `AGENT_PROFILER_HOST` | `127.0.0.1` | Bind address; opt in explicitly to non-loopback access |
| `AGENT_PROFILER_DB_PATH` | `~/.agent-profiler/agent-profiler.sqlite` | SQLite database path |

## What it does

The unpublished UI redesign uses a graphite, keyboard-first workbench for reviewing
agent behavior before refining instructions, skills and tool definitions. Session
review leads to findings, turns and original evidence; it does not infer which
configuration caused an outcome. Press `?` for shortcuts, `⌘/Ctrl K` for search,
`G S` for session review, `G C` for comparison, `/` to filter, and `J/K` then
`Enter` to open a session. Persistent ASCII animal backgrounds appear on every
page. The header's **Background** control explores sharks, rays, seahorses and
jellyfish (or an ocean mix); scene preferences are saved locally. Pause and
reduced motion retain a still scene. Reading areas attenuate the background so
captured evidence stays legible.

- **Ingests** OpenInference OTLP/HTTP-JSON traces from any harness
- **Normalizes** spans into a structured SQLite schema (sessions → turns → LLM calls + tool calls)
- **Reconciles current findings** automatically; unchanged reruns do not accumulate
  warnings, and findings retire when corrected evidence no longer supports them.
- **Exposes recorded errors and coverage** with inspectable evidence; user stops
  remain distinct from failures. Errors do not establish model inadequacy.
- **Reports measured usage** and accumulated durations without inventing prompt
  percentages, cache-miss causes, or billing estimates. Comparisons use unmatched
  cohorts with input-token-weighted cache shares; no winner or confidence interval
  is inferred.
- **Groups live activity by session**, with authoritative totals, explicit stale
  reads, pause/raw views, reconnect state, and bounded retention. Events invalidate
  reads; their snapshots are never summed as usage deltas.
- **Serves** a keyboard-driven React SPA on the same port

Trace requests commit atomically. Invalid envelopes or negative/nonfinite usage
return HTTP 400 without partial writes or events. Successful ingestion returns
204; if data committed but automatic analysis failed, HTTP 202 explicitly reports
`accepted: true, analysis: "failed"`. Refresh findings to retry analysis.

The session list loads the latest 200 sessions; comparisons inspect the latest
1000. Activity retains 100 session groups and 200 raw receipts in browser memory,
not a durable replay log. See [local improvement cycles](docs/IMPROVEMENT-CYCLES.md)
for verification and remaining limits.

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
  cli/       agent-profiler CLI — start/stop/status/logs/open commands

integrations/
  opencode/  opencode-agent-profiler — OpenCode plugin: ships OpenInference OTLP traces
             to agent-profiler. Includes enriched span attributes (tool definitions,
             prompt segments, static-prefix hash) via the opencode plugin hook surface.
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/traces` | OTLP/HTTP-JSON trace ingest |
| `POST` | `/api/import/opencode` | Import a native V2 `{info, messages}` session export |
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

These are emitted automatically by `opencode-agent-profiler`.

### Capture scope and privacy

The V2 integration captures primary agent-loop LLM calls, admitted user turns,
assistant text, tool inputs/results/failures, and reported token/cache/cost
metrics. Request context and prompt segments are isolated by session, including
concurrent sessions and tool loops. Model latency ends at the provider response
boundary, not after its tools finish. Each loaded location has an independent
exporter that flushes when the plugin unloads.

Live capture starts when the plugin loads; use `agent-profiler import opencode`
to backfill earlier sessions separately.
Auxiliary title, compaction, and transient generation model calls are not yet
instrumented. Prompt token estimates in segments are character-based estimates,
not provider billing counts. Long content is bounded by `maxAttrChars`.

Content capture is enabled by default. Traces can contain confidential prompts,
source code, and tool output. Keep the collector private; do not expose port 7070
or enable a remote endpoint without reviewing the data policy. Use
`captureContent: false`, `hideInputs`, or `hideOutputs` to reduce captured content.
The plugin does not capture authentication headers.

## Development

```bash
bun install          # install workspace deps
bun run build        # build all packages (schema → store → … → web → cli)
bun run typecheck    # typecheck all packages
bun test             # run tests
bun dev              # start server in dev mode (hot reload, no daemon)
```

Seed test data after starting the dev server:

```bash
python3 scripts/seed-fixtures.py
```
