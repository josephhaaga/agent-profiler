# E2E Test Harness

Hermetic end-to-end testing for the OpenCode V2 `opencode-agent-profiler` plugin.
Requires OpenCode 2.2.0 or newer on `PATH`.

## Overview

The harness spins up a fully isolated environment:

1. **Sandbox `$HOME`** (`mktemp -d`) — opencode state, config, and plugin logs go here; never touches your real opencode install.
2. **Stub LLM** (`test/harness/stub-llm.ts`) — an OpenAI-compatible HTTP server serving canned scenario responses. Offline, deterministic, no API keys.
3. **Agent-profiler server** — a fresh server on an ephemeral port with a temp SQLite DB.
4. **Sandbox opencode config** — loads the integration package directory and its local `dist/` build. OpenCode runs with `--standalone`, isolated XDG paths, and a copied fake workspace.

The harness asserts collector-side session, turn, LLM, and tool counts and stored
prompt/response/tool bodies. A zero-exit CLI with missing telemetry fails the test.
Hook events and exported spans are captured to NDJSON for diagnostics.

`src/v2.test.ts` tests V2 event correlation, concurrent sessions, interruption,
privacy flags, and provider latency. The older `trace-builder.replay.test.ts`
intentionally retains V1 recordings as regression coverage for the shared span
builder. Do not overwrite its `tool-call-then-text` fixture with V2 recordings.

## Quick start

```bash
# Build workspace dependencies and the plugin first
bun run build

# Run one e2e session (stub mode, tool-call-then-text scenario)
bun run --cwd integrations/opencode test:e2e "Say the word PING and nothing else."

# Record V2 diagnostics under a distinct name
bun run --cwd integrations/opencode test:e2e --record v2-tool-loop "Say the word PING and nothing else."

# Run fast correlation and exporter tests
bun test integrations/opencode/src
```

## Options

| Flag | Description |
|---|---|
| `--scenario <name>` | Stub LLM scenario (default: `tool-call-then-text`) |
| `--mode stub\|real\|local` | LLM provider mode (default: `stub`) |
| `--model <id>` | Model ID for `real`/`local` mode (e.g. `anthropic/claude-opus-4-5`) |
| `--base-url <url>` | Base URL for `local` mode (e.g. `http://localhost:11434/v1`) |
| `--record <name>` | Copy captured logs to `test/fixtures/<name>/` |
| `--keep` | Keep sandbox dir after run (for debugging) |
| `--timeout <ms>` | Max ms to wait for opencode to finish (default: `60000`) |

## LLM modes

### `stub` (default)

A local Bun HTTP server serves deterministic canned responses from a scenario file in `test/harness/scenarios/`. Offline, no API keys, runs in CI.

Available scenarios:
- `tool-call-then-text` — turn 1: tool call (`shell echo hello`), turn 2: text response. Tests multi-LLM-call handling.
- `text-only` — single text response. Simple baseline.

### `local`

Point the stub provider at a local OpenAI-compatible model server (Ollama, LM Studio, etc.):

```bash
bun run --cwd integrations/opencode test:e2e \
  --mode local \
  --model local/llama3.2 \
  --base-url http://localhost:11434/v1 \
  "Say the word PING."
```

### `real`

Use a real provider (requires API key in env). Useful for re-recording fixtures against authentic event shapes after an opencode update:

```bash
ANTHROPIC_API_KEY=sk-... bun run --cwd integrations/opencode test:e2e \
  --mode real \
  --model anthropic/claude-haiku-4-5 \
  --record tool-call-real \
  "Say the word PING."
```

## Fixture format

Each fixture is a directory under `test/fixtures/<name>/`:

| File | Contents |
|---|---|
| `hooks.ndjson` | V2 request-context and durable-event snapshots: `{ ts, hook, input }` |
| `spans.ndjson` | One JSON line per OTLP export batch: `{ ts, spans: [...] }` |
| `expected-sessions.json` | Server's normalized session view at end of run |
| `meta.json` | Recording metadata: timestamp, mode, scenario, model, prompt |

Fixtures are committed to the repo so replay tests run in CI without opencode.

## Replay tests

`src/trace-builder.replay.test.ts` feeds `hooks.ndjson` directly to `TraceBuilder` using `InMemorySpanExporter`. This catches ordering regressions in milliseconds.

Replay tests run automatically as part of `bun test`.

## Recording new fixtures

Record V2 diagnostics under a new name; the V1 replay fixture is historical:

```bash
# Re-record with stub (deterministic, safe for CI)
bun run --cwd integrations/opencode test:e2e --record v2-tool-loop "Say the word PING."

# Re-record with a real provider to capture authentic shapes
ANTHROPIC_API_KEY=sk-... bun run --cwd integrations/opencode test:e2e --record v2-real \
  --mode real --model anthropic/claude-haiku-4-5 "Say the word PING."
```

Review and redact real-provider recordings before committing them. V2 diagnostic
recordings are not consumed by the legacy replay test.

## Adding new scenarios

1. Create `test/harness/scenarios/<name>.json` with `model` and `turns` fields (see existing files for schema).
2. Run `test:e2e --scenario <name> --record <fixture-name>` to generate the fixture.
3. Add matching V2 assertions to `src/v2.test.ts` and the E2E harness.
