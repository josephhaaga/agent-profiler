# OpenCode Agent Profiler

OpenCode V2 observational tracing plugin for the local Agent Profiler collector.
Requires OpenCode 2.2.0 or newer.

Add to `~/.config/opencode/opencode.json`, preserving unrelated settings:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-agent-profiler@0.4.3"]
}
```

The default endpoint is `http://localhost:7070/v1/traces`. Start the collector with
`agent-profiler start`, then use `agent-profiler open`. No accounts, access tokens,
or model-provider credentials are required by the profiler.

## Content capture

Content capture is enabled by default. Set `captureContent: false` in plugin options
to capture usage without prompt/response content. `captureHeaders` defaults to false.
`hideInputs`, `hideOutputs`, `hideInputMessages`, `hideOutputMessages` and
`redactToolOutputs` provide additional controls.

Output hiding also suppresses conversation-input capture and prompt enrichment:
historical tool messages do not always retain reliable identities, and a hidden
result must not reappear inside a later captured prompt. This conservative policy
favors privacy over prompt inspection. Hook diagnostics contain names, not content;
trace diagnostics can contain captured content and must remain private.

Redaction changes affect future traces, not previously saved history. Historical
imports retain unredacted saved exports independently of these options.
Keep the collector and its history local; do not expose them publicly.

Source, changelog and releases: <https://github.com/josephhaaga/agent-profiler>.
