/** OpenCode V2 plugin. All telemetry is observational and fail-open. */
import { Plugin } from "@opencode/plugin";
import { resolveConfig } from "./config.js";
import { initOtel } from "./otel.js";
import { TraceBuilder } from "./trace-builder.js";
import { V2Adapter } from "./v2.js";
import { safeJson } from "./attributes.js";
import { sanitizeMcpKey } from "./mcp.js";
import { appendFileSync } from "node:fs";

export default Plugin.define({
  id: "opencode-agent-profiler",
  async setup(ctx) {
    const config = resolveConfig(ctx.options);
    if (config.disabled) return;
    const otel = initOtel(config);
    if (!otel) {
      console.error("[agent-profiler] OpenTelemetry initialization failed");
      return;
    }
    const builder = new TraceBuilder({ tracer: otel.tracer, config, project: ctx.location.project.canonical });
    const adapter = new V2Adapter(builder, config);
    const guard = <T>(fn: (event: T) => void) => (event: T) => {
      try { fn(event); } catch (error) { console.error("[agent-profiler] capture failed", String(error)); }
    };
    const controller = new AbortController();
    let disposed = false;
    const logHook = (hook: string, input: unknown) => {
      if (!config.hookLog) return;
      try { appendFileSync(config.hookLog, safeJson({ ts: Date.now(), hook, input }) + "\n", { mode: 0o600 }); } catch { /* optional diagnostics */ }
    };
    try {
      builder.setMcpServers(new Set((await ctx.mcp.list()).data.map((server) => sanitizeMcpKey(server.name))));
    } catch { /* MCP discovery must not disable session tracing. */ }
    try {
      await ctx.session.hook("context", async (event) => {
        try {
          logHook("context", event);
          // Read admitted history, not the prompt hook: queued prompts have not
          // started a turn yet, and resumed sessions may predate plugin loading.
          const messages = await ctx.session.context({ sessionID: event.sessionID });
          const user = [...messages].reverse().find((message) => message.type === "user");
          if (user?.type === "user") adapter.onUser(event.sessionID, user);
          adapter.onContext(event);
        } catch (error) { console.error("[agent-profiler] request capture failed", String(error)); }
      });
      await ctx.tool.hook("execute.before", guard((event) => builder.onToolBefore({
        sessionID: event.sessionID, tool: event.tool, callID: event.id,
      }, { args: event.input })));
      await ctx.tool.hook("execute.after", guard((event) => builder.onToolAfter({
        sessionID: event.sessionID, tool: event.tool, callID: event.id, args: event.input,
      }, {
        output: event.status === "completed" ? safeJson(event.result.content) : safeJson(event.error),
        errored: event.status === "error",
      })));
    } catch (error) {
      await otel.shutdown();
      throw error;
    }
    const consume = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal, types: [
          "session.step.started", "session.step.streamed", "session.step.ended", "session.step.failed", "session.text.ended",
          "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.deleted",
        ] })) {
          // Every loaded location gets a plugin runtime; do not count other locations twice.
          if (event.location?.directory !== ctx.location.directory) continue;
          logHook("event", event);
          guard((value: typeof event) => adapter.onEvent(value))(event);
        }
      } catch (error) {
        if (!disposed) console.error("[agent-profiler] event subscription failed", String(error));
      }
    })();
    const sweeper = setInterval(() => builder.sweep(), config.sweepIntervalMs);
    sweeper.unref();
    void fetch(config.endpoint.replace(/\/v1\/traces\/?$/, "") + "/healthz", {
      signal: AbortSignal.timeout(2000),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch(() => console.error("[agent-profiler] collector unreachable; start agent-profiler before using OpenCode"));
    return async () => {
      disposed = true;
      controller.abort();
      clearInterval(sweeper);
      await consume;
      builder.closeAll();
      await otel.shutdown();
    };
  },
});
