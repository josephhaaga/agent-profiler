# Changelog

## Agent Profiler 0.3.0 / OpenCode plugin 0.4.2

### Workbench

- Graphite, keyboard-first session review, command search, property inspection,
  recorded-error triage, and original evidence navigation.
- Persistent ASCII ocean backgrounds with sharks, rays, seahorses, and jellyfish;
  pause and reduced-motion support retain still artwork.
- Load every session page instead of only the latest 200. Stable cursor pagination
  handles sessions with identical start times.
- Refresh prompt and comparison evidence on live updates and reconnects.
- Disposable `agent-profiler demo` with synthetic examples; no account required.
- `agent-profiler --version` reports the installed CLI version; `agent-profiler open`
  opens the local UI without accounts, credentials, or a login screen.

### Data integrity

- Atomic ingestion, validated usage, sparse replay preservation, exact-ID import
  reparenting, and explicit accepted-data/failed-analysis responses.
- Reconcile stable current findings instead of accumulating duplicate warnings.
- Live events invalidate authoritative reads; event snapshots never accumulate as
  usage deltas. Preserve stale reads and expose reconnect/error state.
- Preserve unknown imported usage, including missing tool-output estimates. Recorded
  costs are not billed spend; comparisons do not infer winners from unmatched tasks.

### Privacy and dependencies

- Fix tool-output hiding so a hidden result cannot reappear in a later captured
  conversation. The conservative policy suppresses conversation-input capture and
  prompt enrichment while output hiding is active.
- Hook diagnostics record names rather than raw hook content. Trace diagnostic
  files containing captured content use restricted permissions.
- Update vulnerable dependencies, retaining the Bun lockfile for reproducible builds.
- Include installation/privacy documentation in both npm packages and attach this
  changelog to GitHub releases after successful npm publication.

### Upgrade

1. Install `@josephhaaga/agent-profiler@0.3.0` and restart the collector.
2. Use `opencode-agent-profiler@0.4.2` for the latest live-capture privacy fix.
3. Run `agent-profiler import opencode` to backfill active and archived history.
4. Run `agent-profiler open` to open the UI.

No new authentication or networking configuration is required. The collector still
binds loopback by default. Imports retain unredacted saved history independently of
live-capture settings; keep the database private. Redaction affects new captures,
not existing history. Do not expose the collector publicly.

## Earlier releases

- CLI 0.2.1: follow OpenCode pagination cursors and retain session titles.
- CLI 0.2.0: backfill OpenCode history with stable identities and explicit unknown usage.
- OpenCode plugin 0.4.1: OpenCode V2 tracing integration.
