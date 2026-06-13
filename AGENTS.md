# AGENTS.md

## Runtime & package manager

- **Bun only** — runtime, test runner, package manager, and script runner. Do not use Node or npm.
- Install: `bun install`
- Package manager declared: `"packageManager": "bun@1.2.0"` in root `package.json`.

## Build

Build order is strict — packages depend on each other in this sequence:

```
schema → store → ingest → profiler → proxy → server → web → integrations/opencode
```

Run everything: `bun run build` (root script handles ordering).

To build a single package: `bun run --cwd packages/<name> build`

The `packages/web` build is a Vite SPA (`bun run --cwd packages/web build`). The server serves the resulting `dist/` as static files. After changing web code, rebuild web before testing through the server.

## Typecheck

`bun run typecheck` runs `bunx tsc --noEmit` across all packages in the same strict order as build.

Root `tsconfig.base.json` is the shared baseline. Each package extends it. The web package uses `moduleResolution: "Bundler"` and `jsx: "react-jsx"`.

## Tests

`bun test` — Bun's built-in runner, no config file. Test files live alongside source:
- `packages/store/src/index.test.ts`
- `packages/ingest/src/index.test.ts`
- `packages/profiler/src/index.test.ts`

Tests use `bun:test` imports (`import { describe, expect, test, beforeEach } from "bun:test"`). No vitest, no jest.

No linter or formatter is configured (no eslint, prettier, biome).

## Dev server

`bun dev` starts the Bun HTTP server at `packages/server/src/index.ts` on port 7070 (default). The server hot-reloads via Bun; the SPA does **not** hot-reload unless you also run `bun run --cwd packages/web dev` (Vite dev server on port 5173) separately.

Seed test data: `python3 scripts/seed-fixtures.py [--endpoint http://localhost:7070]`

## Architecture

Monorepo with Bun workspaces. All packages are under `packages/` and `integrations/`. Internal deps use `workspace:*` protocol.

Key boundaries:
- `packages/schema` — shared TypeScript types only (`SessionRecord`, `TurnRecord`, `LlmCallRecord`, `ToolCallRecord`, `Insight`, `LiveTailEvent`, etc.). No runtime deps.
- `packages/store` — SQLite DAL via `bun:sqlite`. `Store` class with inline `migrate()` that creates the 8-table schema on first use. DB path defaults to `./agent-profiler.sqlite` (gitignored).
- `packages/ingest` — OTLP/HTTP-JSON collector and span normalizer. Calls into `store`.
- `packages/profiler` — five analyzers (`analyzeCacheEfficiency`, `analyzeAttribution`, `analyzeComposition`, `analyzeRightsizing`, `analyzeCompare`). Reads from `store`.
- `packages/server` — single Bun HTTP entrypoint that mounts ingest route, REST API, SSE live tail (`/api/stream`), and static SPA serving.
- `packages/web` — React 19 + Vite + Tailwind v4 + Radix UI SPA. All UI lives in `src/App.tsx` (single large file, ~1730 lines). Path alias `@/` → `src/`.
- `packages/proxy` — optional provider proxy for capturing VS Code Copilot traffic.
- `integrations/opencode` — LM-middleware for richer span attributes (prompt segments, tool defs, static prefix hash).

## Web SPA routing

Hash router is implemented directly in `packages/web/src/App.tsx` — no React Router or external library.

Key functions (around line 1511–1540):
- `viewToHash(v: View): string` — view state → URL hash
- `hashToView(hash: string): View` — URL hash → view state

URL scheme:
```
#/sessions                                    → sessions list
#/sessions/:id                                → session detail
#/sessions/:sessionId/turns/:id               → turn detail
#/sessions/:sessionId/cache                   → cache panel
#/sessions/:sessionId/prompt/:llmCallId       → prompt inspector
#/compare                                     → compare view
```

`navigate(next: View)` calls `window.history.pushState` and updates React state. `popstate` listener handles browser back/forward. Initial view is parsed from `window.location.hash` at component mount.

Keyboard shortcuts: `j`/`k` navigate prev/next turn within a session; `⌘K` opens the omnibar.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `AGENT_PROFILER_PORT` | `7070` | Server listen port |
| `AGENT_PROFILER_DB_PATH` | `./agent-profiler.sqlite` | SQLite file path |
