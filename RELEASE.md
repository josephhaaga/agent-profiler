# Release checklist

This repo publishes two npm packages. Each has its own tag convention and workflow.

| Package | Tag format | Workflow |
|---|---|---|
| `agent-profiler` (CLI + server) | `agent-profiler@<version>` | `publish-cli.yml` |
| `opencode-agent-profiler` (OpenCode plugin) | `opencode-agent-profiler@<version>` | `publish.yml` |

Both workflows stamp `package.json` from the tag at CI time — you never edit `package.json` manually.

---

## Releasing `agent-profiler` (CLI)

### 1. One-time npm Trusted Publishing setup

Must be done once before the first CI publish. The package must exist on npm first
(Trusted Publishers are registered against an existing package).

- [ ] Manually publish to claim the name using a granular token with **Bypass 2FA** enabled:
  ```bash
  cd packages/cli
  npm version <version> --no-git-tag-version
  npm publish --access public --workspaces=false
  ```
- [ ] On npmjs.com → package → **Settings → Publishing → Trusted Publishers → Add**:
  - Repository owner: `josephhaaga`
  - Repository name: `agent-profiler`
  - Workflow filename: `publish-cli.yml`
- [ ] Revert the version bump in `package.json` (it should stay at `0.0.0-dev` on `main`)

### 2. Verify before each release

```bash
bun install && bun run build && bun run typecheck && bun test
cd packages/cli && npm pack --dry-run --workspaces=false
```

`dist/` should contain: `index.js` (CLI), `server/index.js` (bundled server), `web/` (SPA assets).

### 3. Tag and publish

```bash
git tag agent-profiler@<version>
git push origin agent-profiler@<version>
```

Watch **Actions → Publish agent-profiler** pass, then verify:

```bash
npm show agent-profiler
npx agent-profiler status
```

---

## Releasing `opencode-agent-profiler` (OpenCode plugin)

### 1. One-time npm Trusted Publishing setup

- [x] Manually published `0.2.0` to claim the name (granular token with Bypass 2FA)
- [x] Trusted Publisher configured: org=`josephhaaga`, repo=`agent-profiler`, workflow=`publish.yml`

### 2. Verify before each release

```bash
bun install && bun run build && bun run typecheck && bun test
cd integrations/opencode && npm pack --dry-run --workspaces=false
```

### 3. Tag and publish

```bash
git tag opencode-agent-profiler@<version>
git push origin opencode-agent-profiler@<version>
```

Watch **Actions → Publish opencode-agent-profiler** pass, then verify:

```bash
npm show opencode-agent-profiler
```

---

## End-to-end smoke test (both packages)

### Without a running server (should warn, not fail)

- [ ] Add plugin to `~/.config/opencode/opencode.json`, do **not** start the server
- [ ] Start OpenCode — confirm warn log: `agent-profiler unreachable … traces will be dropped`
- [ ] Confirm OpenCode works normally

### With a running server

- [ ] `npx agent-profiler start`
- [ ] Restart OpenCode — confirm log: `agent-profiler active → http://localhost:7070/v1/traces`
- [ ] Send a prompt, open `http://localhost:7070`, confirm session appears with turns + LLM calls
- [ ] `npx agent-profiler status` → `running PID … healthy`
- [ ] `npx agent-profiler logs` → shows server startup lines
- [ ] `npx agent-profiler stop` → `stopped`
- [ ] `npx agent-profiler status` → `stopped`

---

## Known pitfalls

- **npm Trusted Publishing requires npm ≥ 11.5.1** — Node 22 ships with npm 10.9.8.
  Both publish workflows add `npm install -g npm@latest` after `setup-node` to fix this.
- **`--workspaces=false` is required** on all `npm publish` calls — the repo root declares
  workspaces and npm will error without this flag.
- **The tag must point at a commit where the build succeeds** — create the tag after pushing
  `main`, never before.
- **`NPM_TOKEN` env var is silently ignored by npm** — auth goes through `~/.npmrc` via
  `npm config set //registry.npmjs.org/:_authToken`.

