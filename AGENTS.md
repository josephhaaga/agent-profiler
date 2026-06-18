# AGENTS.md

## Runtime & package manager

- **Bun only** — runtime, test runner, package manager. Do not use Node or npm for dev tasks.
- Install: `bun install`
- CI uses `bun install --frozen-lockfile`. Commit `bun.lock` after adding new workspace packages or CI fails.
- Package manager: `"packageManager": "bun@1.2.0"` in root `package.json`.

## Build

Build order is strict — packages depend on each other in this sequence:

```
schema → store → ingest → profiler → proxy → server → web → integrations/opencode → cli
```

Run everything: `bun run build`

To build a single package: `bun run --cwd packages/<name> build`

**Important**: `packages/cli/build.ts` hard-fails if `packages/web/dist/` does not exist. Always build `web` before `cli` when building packages individually. The root `build` script handles this automatically.

The CLI build (`packages/cli/build.ts`) is a custom Bun script — not a plain `tsc` invocation. It:
1. Compiles `src/` with `tsc` (Node-compatible ESM → `dist/index.js`) and prepends `#!/usr/bin/env node`
2. Bundles `packages/server/src/index.ts` with `Bun.build()` → `dist/server/index.js` (target: `bun`)
3. Copies `packages/web/dist/` → `dist/web/`

## Typecheck

`bun run typecheck` — same strict order as build.

Root `tsconfig.base.json` baseline. The CLI package overrides to `module: "NodeNext"` / `moduleResolution: "NodeNext"` and `types: ["node"]` (not `bun-types`) so it targets Node. The web package uses `moduleResolution: "Bundler"` and `jsx: "react-jsx"`.

## Tests

`bun test` — Bun's built-in runner, no config file. Test files live alongside source:
- `packages/store/src/index.test.ts`
- `packages/ingest/src/index.test.ts`
- `packages/profiler/src/index.test.ts`

Tests use `bun:test` imports. No vitest, no jest. No linter or formatter (no eslint, prettier, biome).

## Dev server

`bun dev` — starts the Bun HTTP server at `packages/server/src/index.ts` on port 7070. The SPA does **not** hot-reload from here; run `bun run --cwd packages/web dev` separately (Vite on port 5173) for that.

Seed test data: `python3 scripts/seed-fixtures.py [--endpoint http://localhost:7070]`

## Architecture

Monorepo with Bun workspaces under `packages/` and `integrations/`. Internal deps use `workspace:*`.

| Package | npm name | Published |
|---|---|---|
| `packages/schema` | `@agent-profiler/schema` | no |
| `packages/store` | `@agent-profiler/store` | no — uses `bun:sqlite` |
| `packages/ingest` | `@agent-profiler/ingest` | no |
| `packages/profiler` | `@agent-profiler/profiler` | no |
| `packages/server` | `@agent-profiler/server` | no |
| `packages/web` | `@agent-profiler/web` (private) | no |
| `packages/proxy` | — | no |
| `packages/cli` | `@josephhaaga/agent-profiler` | **yes** |
| `integrations/opencode` | `opencode-agent-profiler` | **yes** |

**CLI runtime split**: `packages/cli/dist/index.js` is a Node-compatible ESM script (no Bun APIs). It spawns the server as `bun run dist/server/index.js`. The server bundle is Bun-only and cannot be started with Node.

**Server SPA path**: The server reads `AGENT_PROFILER_WEB_DIST` env to locate static files. The CLI sets this to its own bundled `dist/web/` when spawning the daemon. In dev (running server directly), it falls back to `../../web/dist` relative to `src/index.ts`.

**DB path**: `~/.agent-profiler/agent-profiler.sqlite` (not `./agent-profiler.sqlite` — that was the old local dev default).

**Daemon state**: `~/.agent-profiler/agent-profiler.pid` and `agent-profiler.log`.

## Web SPA routing

Custom hash router in `packages/web/src/App.tsx` (single file, ~1730 lines). No React Router.

- `viewToHash(v)` / `hashToView(hash)` at ~line 1513–1539
- `navigate(next)` uses `window.history.pushState`

```
#/sessions                                    → sessions list
#/sessions/:id                                → session detail
#/sessions/:sessionId/turns/:id               → turn detail
#/sessions/:sessionId/cache                   → cache panel
#/sessions/:sessionId/prompt/:llmCallId       → prompt inspector
#/compare                                     → compare view
```

Keyboard shortcuts: `j`/`k` prev/next turn; `⌘K` omnibar.

## Publishing

Both published packages have `"version": "0.0.0-dev"` checked in. **Never bump the version in `package.json`** — CI stamps it transiently from the git tag during publish.

| Package | Tag format | Workflow |
|---|---|---|
| `@josephhaaga/agent-profiler` | `agent-profiler@1.2.3` | `.github/workflows/publish-cli.yml` |
| `opencode-agent-profiler` | `opencode-agent-profiler@1.2.3` | `.github/workflows/publish.yml` |

Both workflows use npm OIDC Trusted Publishing (no `NODE_AUTH_TOKEN`). They upgrade npm to latest before publishing because Trusted Publishing requires npm ≥ 11.5.1. Both use `--workspaces=false` on `npm version` and `npm publish` — omitting this flag causes npm to fail with `ENOWORKSPACES`.

To release: `git tag agent-profiler@X.Y.Z && git push origin agent-profiler@X.Y.Z`

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `AGENT_PROFILER_PORT` | `7070` | Server listen port |
| `AGENT_PROFILER_DB_PATH` | `~/.agent-profiler/agent-profiler.sqlite` | SQLite file path |
| `AGENT_PROFILER_WEB_DIST` | (monorepo fallback in dev) | CLI sets this when spawning daemon |
| `BUN_PATH` | (auto-detected) | Override Bun binary path for CLI |
| `AGENT_PROFILER_ENDPOINT` | `http://localhost:7070/v1/traces` | OpenCode plugin only |
| `AGENT_PROFILER_DISABLED` | `false` | OpenCode plugin only |
