# Local improvement cycles

Scope: improve immediate usefulness after installation. The initial cycles were
local-only. On 2026-10-28 the user authorized committing and pushing repository
changes, followed by a private OpenCode-history import and setup analysis. npm
publishing, global installation, dotfiles changes and production deployment are
not part of that authorization.

## Product constraints

- No account, cloud service, extra API key, or LLM judge required.
- Show measured evidence before recommendations; missing data is not zero.
- Make concurrent sessions understandable without reading a raw event stream.
- Preserve source session IDs, imported-history coverage, and existing capture.
- Prefer a few reliable diagnostics over many speculative warnings.

## Cycle 1 — Research and selection

Status: complete.

Primary-source research and an independent data-integrity audit will be saved
under `docs/research/`. Model routing failures will be recorded rather than
represented as successful cross-model review.

Completed research used OpenAI Luna (tooling/value gaps), Astra (observability
UX), and Sol (diagnostic trust). The advertised Terra route was unsupported by
the connected account; Anthropic rejected its configured key. Neither failed
attempt is counted as a completed review.

Evidence: [value gaps](research/harness-value-gaps.md),
[UX patterns](research/observability-ux-patterns.md), and
[trust audit](research/diagnostic-trust-audit.md).

Select work by immediate user value, available evidence, setup cost, false-positive
risk, implementation size, and compatibility. Reject features that require
unrecorded information or add adoption burden without a clear benefit.

## Cycle 2 — Implement the selected core

Status: complete locally; unpublished.

The groomed implementation order is:

1. Reconcile current findings, deduplicate analysis per batch, suppress invalid
   prompt percentages, and distinguish observations from diagnosed causes.
2. Correct late-span accounting and preserve explicit OTLP error evidence.
3. Replace the raw default tail with session-grouped activity and truthful
   connection/retention state; refresh authoritative session data on reconnect.
4. Make recorded failures and finding evidence directly inspectable without a
   new account or a judge. Keep user stops distinct from errors.
5. Correct incompatible comparison measures and improve first-event/error states.

The CLI/server runtime claims in the README were also corrected: the current
collector needs Bun, and a PID file does not provide automatic startup.

Preserve the existing uncommitted chart-color, cache-sort, and command-palette
fixes. Use an isolated collector and synthetic fixtures for browser checks.
Exercise collector behavior through public APIs and run the existing Bun suite.

## Cycle 3 — Adversarial review and refinement

Status: complete for this pass; unpublished.

Challenge the implementation with duplicate and out-of-order events, concurrent
sessions, unknown metrics, stale/resolved findings, reconnects, empty states,
high-volume bursts, keyboard-only use, and long sessions. Fix demonstrated
defects, then repeat the focused review and validation.

### Implemented refinements

- Finding identities now include distinct tool kinds. Standard OTLP model errors
  and errors awaiting a parent turn produce inspectable findings. Reconciliation
  retires their session-scoped placeholders when the actual parent arrives.
- Sparse replays preserve known outcomes, content references, classification,
  latency and live provenance. Explicit user stops survive OTLP UNSET. Invalid
  usage and malformed envelopes reject the entire request without partial writes
  or SSE; hashing and the SQLite transaction run synchronously.
- Exact OpenCode message/tool IDs resolve imported parent relationships while
  preserving live request evidence. Older retained parent groups are disclosed
  as association conflicts and excluded from comparison rather than guessed away.
- Browser adversarial checks reproduced snapshot loss on failed reads and
  insertion-order eviction of recently active groups. Failed reads now preserve
  last successful values with visible stale/error/retry state; eviction uses the
  least recently received group without reordering survivors.
- `demo [--no-open]` runs synthetic ordinary, recorded-error and missing-usage
  examples in a private temporary database on an ephemeral loopback port. The UI
  labels it as disposable synthetic data. Signal cleanup stops only its child and
  removes its own temporary directory.

### Verification — 2026-10-27

- Full `bun run build` and `bun run typecheck` pass. `bun test`: **165 tests,
  724 assertions**, across 18 files. The tightened HTTP-400 regressions also pass
  independently (5 tests, 58 assertions). `git diff --check` is clean.
- HTTP/CLI regressions cover stable findings, retirement, changed-only SSE,
  late spans, sparse replay, standard error statuses, user stops, orphan errors,
  exact-ID parent resolution, input-only comparisons, atomic rejection, usage
  validation, import compatibility and demo cleanup.
- Browser review against disposable data confirmed duplicate-event totals do not
  accumulate, pause/resume works, and unknown metrics remain Unknown. Final
  browser reproduction confirms failed reads retain title/counts/cost and expose
  failure before expansion. At 101 groups, the recently updated first group
  survives, the oldest idle group is evicted, and surviving order is unchanged.
- Rendered cache detail shows an explicit unknown middle-turn gap; demo renders
  three labeled examples and the disposable-data banner. Inspected both the
  regular and narrow browser layouts; full mobile-device coverage is not claimed.
- Impeccable detector reports one warning for the incumbent Inter font. Retained
  intentionally: this pass refines the existing interface rather than rebranding.

### Remaining limits

Activity is a bounded browser receipt ledger, not durable replay or execution
chronology. The list loads 200 sessions; comparisons inspect 1000, exclude missing
measurements/unresolved associations, and are not matched experiments. Full
request composition, provider retries and billed spend are not reconstructed.
No automatic model right-sizing conclusion is emitted from execution errors.

After commit, analysis failures return HTTP 202 with `accepted: true` and
`analysis: "failed"`; invalid ingestion returns HTTP 400. The accepted-data error
branch is implemented but has not been fault-injected in this pass.

At the end of these initial cycles, research and implementation were uncommitted.
No npm publishing, git push, global install, dotfiles deployment or production
collector change was performed during those cycles. The subsequent repository
commit/push authorization does not publish packages or deploy the collector.

## Deferred unless evidence changes the priority

Cloud dashboards, provider-side cache-miss diagnoses, synthetic billing estimates,
mandatory benchmarks, agent judges, decorative redesign, and new harness adapters
that require custom instrumentation before they produce value.
