# Release checklist: opencode-agent-profiler

Steps to publish the `opencode-agent-profiler` npm package and verify the end-to-end
installation experience. Work through these in order; each section depends on the previous.

---

## 1. Configure npm Trusted Publishing (one-time setup)

Trusted Publishing uses OIDC — GitHub Actions exchanges a short-lived identity token
for an npm publish token automatically. No secret is stored in GitHub or npm.

The package must exist on npm before a Trusted Publisher can be registered against it,
so a one-time manual publish is required to claim the name first.

- [x] Log in at https://www.npmjs.com
- [x] Publish the package manually to claim the name:
  - Your account has `auth-and-writes` 2FA, so the token in `~/.npmrc` must have
    **Bypass two-factor authentication** enabled. To generate one:
    1. Go to https://www.npmjs.com → avatar → **Access Tokens → Generate New Token**
    2. Give it a name (e.g. `agent-profiler one-time publish`)
    3. Check **Bypass two-factor authentication**
    4. Under **Packages and scopes → Permissions**, select **Read and write**
    5. Under **Select Packages**, choose **All Packages** (the package doesn't exist yet
       so you can't select it by name)
    6. Set an expiration of 1 day
    7. Generate, copy the token, and install it:
       ```bash
       npm config set //registry.npmjs.org/:_authToken <your-token>
       ```
    8. Publish from the package directory with `--workspaces=false` to prevent npm from
       refusing because the repo root declares workspaces:
       ```bash
       cd integrations/opencode && npm publish --access public --workspaces=false
       ```
    9. The token expires in 1 day — no need to revoke it manually
- [ ] In npm, go to the package page → **Settings → Publishing → Trusted Publishers**
- [ ] Click **Add a publisher** and fill in:
  - **Repository owner**: your GitHub username or org
  - **Repository name**: `agent-profiler`
  - **Workflow filename**: `publish.yml`
  - **Environment** (optional): leave blank unless you add a GitHub environment
- [ ] Save

After this, the workflow can publish by exchanging the GitHub Actions OIDC token —
no `NPM_TOKEN` secret needed in GitHub, no long-lived credentials anywhere.

---

## 2. Verify the package before each release

- [ ] Run the full build and test suite locally:
  ```bash
  bun install
  bun run build
  bun run typecheck
  bun test
  ```
- [ ] Inspect what will be published (should only be `dist/`, `README.md`, `LICENSE`):
  ```bash
  cd integrations/opencode && npm pack --dry-run --workspaces=false
  ```
- [ ] Confirm the output shows the correct `name`, `version`, and `main: dist/index.js`

---

## 3. Tag and publish via CI

- [ ] Commit any outstanding changes and push to `main`
- [ ] Create and push the release tag — the publish workflow fires on this:
  ```bash
  git tag opencode-agent-profiler@<version>
  git push origin opencode-agent-profiler@<version>
  ```
- [ ] In GitHub, go to **Actions → Publish opencode-agent-profiler** and confirm the
  workflow run passes all steps (install → build → typecheck → test → npm publish)
- [ ] Verify the package is live:
  ```bash
  npm show opencode-agent-profiler
  ```

---

## 4. Test installation without a running server

This simulates a new user who installs the plugin before starting agent-profiler.

- [ ] Open OpenCode in any project (do **not** start `bun dev` yet)
- [ ] Add the plugin to `~/.config/opencode/opencode.json`:
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["opencode-agent-profiler"]
  }
  ```
- [ ] Restart OpenCode and send any prompt
- [ ] Check the opencode log output — you should see a **warn** from `opencode-agent-profiler`:
  ```
  agent-profiler unreachable at http://localhost:7070/healthz — traces will be dropped
  until the server is running. Start it with: bun dev
  ```
- [ ] Confirm OpenCode continues to work normally (the plugin must not block or error the agent)

---

## 5. Test end-to-end with a running server

- [ ] Start the agent-profiler server:
  ```bash
  bun dev
  ```
- [ ] Restart OpenCode (same config as step 4)
- [ ] Check the opencode log — you should see:
  ```
  agent-profiler active → http://localhost:7070/v1/traces (project=opencode)
  ```
- [ ] Send a prompt in OpenCode
- [ ] Open http://localhost:7070 and confirm the session appears in the UI
- [ ] Verify the session has:
  - [ ] At least one turn
  - [ ] LLM calls with token counts
  - [ ] Tool calls (if any tools were used)
  - [ ] Prompt segments (enriched capture working)

---

## 6. Test the custom endpoint option

- [ ] Update `opencode.json` to use the tuple form with a custom endpoint:
  ```json
  {
    "plugin": [
      ["opencode-agent-profiler", { "endpoint": "http://localhost:7070/v1/traces" }]
    ]
  }
  ```
- [ ] Restart OpenCode and confirm it still works (same log message as step 5)
- [ ] Test with a wrong port to confirm the unreachable warning fires:
  ```json
  { "endpoint": "http://localhost:9999/v1/traces" }
  ```

---

## 7. Post-release

- [ ] Create a GitHub Release from the tag with a short changelog in the release notes
- [ ] Update `integrations/opencode/package.json` version to `<next>-dev` on `main` so
  the next release tag is unambiguous
