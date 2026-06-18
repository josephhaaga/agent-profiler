# E2E Test Harness

Hermetic end-to-end testing for the `opencode-agent-profiler` plugin.

## Overview

The harness spins up a fully isolated environment:

1. **Sandbox `$HOME`** (`mktemp -d`) — opencode state, config, and plugin logs go here; never touches your real opencode install.
2. **Stub LLM** (`test/harness/stub-llm.ts`) — an OpenAI-compatible HTTP server serving canned scenario responses. Offline, deterministic, no API keys.
3. **Agent-profiler server** — a fresh server on an ephemeral port with a temp SQLite DB.
4. **Sandbox opencode config** — loads the plugin from the local `dist/` build via an absolute path; no npm publish, no cache warm-up.

Hook events and exported spans are captured to NDJSON. Use `--record <name>` to commit them as fixtures. The replay test (`src/trace-builder.replay.test.ts`) loads these fixtures and feeds them to `TraceBuilder` without any network I/O or opencode dependency — making the inner test loop milliseconds fast.

## Quick start

```bash
# Build the plugin first
bun run --cwd integrations/opencode build

# Run one e2e session (stub mode, tool-call-then-text scenario)
bun run --cwd integrations/opencode test:e2e "Say the word PING and nothing else."

# Re-record fixtures after changing the plugin or stub scenario
bun run --cwd integrations/opencode test:e2e:record tool-call-then-text "Say the word PING and nothing else."

# Run replay tests (fast, no network)
bun test integrations/opencode/src/trace-builder.replay.test.ts
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
- `tool-call-then-text` — turn 1: tool call (`bash echo hello`), turn 2: text response. Tests multi-LLM-call handling.
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
| `hooks.ndjson` | One JSON line per hook invocation: `{ ts, hook, input, output }` |
| `spans.ndjson` | One JSON line per OTLP export batch: `{ ts, spans: [...] }` |
| `expected-sessions.json` | Server's normalized session view at end of run |
| `meta.json` | Recording metadata: timestamp, mode, scenario, model, prompt |

Fixtures are committed to the repo so replay tests run in CI without opencode.

## Replay tests

`src/trace-builder.replay.test.ts` feeds `hooks.ndjson` directly to `TraceBuilder` using `InMemorySpanExporter`. This catches ordering regressions in milliseconds.

Replay tests run automatically as part of `bun test`.

## Recording new fixtures

When opencode updates its hook event shapes or ordering, re-record the affected fixtures:

```bash
# Re-record with stub (deterministic, safe for CI)
bun run --cwd integrations/opencode test:e2e:record tool-call-then-text "Say the word PING."

# Re-record with a real provider to capture authentic shapes
ANTHROPIC_API_KEY=sk-... bun run --cwd integrations/opencode test:e2e:record tool-call-then-text \
  --mode real --model anthropic/claude-haiku-4-5 "Say the word PING."
```

Commit the updated NDJSON files. The replay tests will use the new fixture on next run.

## Adding new scenarios

1. Create `test/harness/scenarios/<name>.json` with `model` and `turns` fields (see existing files for schema).
2. Run `test:e2e --scenario <name> --record <fixture-name>` to generate the fixture.
3. Add a `describe` block to `src/trace-builder.replay.test.ts` for the new fixture.
