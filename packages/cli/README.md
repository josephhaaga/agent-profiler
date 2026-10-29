# Agent Profiler

Local-first agent observability: SQLite history and a keyboard-driven workbench
with recorded-error triage, cache accounting, and prompt inspection.

Requires Bun for the collector. The CLI itself is Node-compatible.

```sh
bun add --global @josephhaaga/agent-profiler@0.3.1
agent-profiler start
agent-profiler import opencode
agent-profiler open
```

No accounts, access tokens, login screen, or model-provider credentials are required.

Import requires a running OpenCode V2 service. Active and archived sessions are
read through its supported export API; repeat imports deduplicate by source ID.
Missing metrics remain Unknown. Historical prompts/tool schemas cannot be recreated.
Use `opencode-agent-profiler@0.4.3` for titled live sessions.

## Privacy

The collector binds loopback by default. Keep it local; do not expose it publicly.
Imported history includes unredacted content regardless of live plugin settings.
Existing history is not retroactively redacted; protect your OS account and backups.

Run `agent-profiler demo` for disposable synthetic data, `agent-profiler status`
for health, or `agent-profiler --version` for the installed version.

Source, changelog and releases: <https://github.com/josephhaaga/agent-profiler>.
