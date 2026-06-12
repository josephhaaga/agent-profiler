# agent-profiler

Local-first profiling for agent harnesses and deployed agents.

V1 goals:

- ingest traces directly over OTLP/HTTP
- store and query sessions / turns / calls locally
- inspect prompts, tool use, cache behavior, and model right-sizing
- support a keyboard-driven web UI with `Cmd+K`

The `opencode` integration is designed to grow into `@agent-profiler/opencode`.
