/**
 * opencode-agent-profiler: OpenCode plugin that ships traces to agent-profiler.
 *
 * Ships OpenInference-compliant OTLP spans (content + token/cost metrics) from
 * OpenCode sessions to a running agent-profiler instance. Pings /healthz at
 * startup and warns if the endpoint is unreachable — but never blocks the agent.
 *
 * Usage (in your opencode.json):
 *
 *   {
 *     "$schema": "https://opencode.ai/config.json",
 *     "plugin": ["opencode-agent-profiler"]
 *   }
 *
 * With a custom endpoint (e.g. remote server):
 *
 *   {
 *     "plugin": [["opencode-agent-profiler", { "endpoint": "http://my-server:7070/v1/traces" }]]
 *   }
 *
 * Environment variables (all optional):
 *   AGENT_PROFILER_ENDPOINT   — OTLP traces URL (overrides default + options)
 *   OI_CAPTURE_CONTENT        — "false" to stop capturing prompt/response text
 *   OI_DISABLED               — "true" to disable the plugin entirely
 *
 * See packages/server/src/index.ts for the OTLP ingest route (/v1/traces) and
 * the health check (/healthz) this plugin targets.
 */
import type { Plugin, Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { resolveConfig } from "./config.js";
import { initOtel } from "./otel.js";
import { applyRedactionEnv } from "./redaction.js";
import { TraceBuilder } from "./trace-builder.js";
import { sanitizeMcpKey } from "./mcp.js";
import type {
  AssistantMessage,
  Message,
  OpencodeClientLike,
  OpencodeEvent,
  Part,
  UserMessage,
} from "./types.js";

const SERVICE = "opencode-agent-profiler";

export const AgentProfilerPlugin: Plugin = async (
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks> => {
  const config = resolveConfig(options as Record<string, unknown> | undefined);
  const client = input.client as unknown as OpencodeClientLike;

  const log = (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    try {
      void client.app?.log?.({ body: { service: SERVICE, level, message, extra } });
    } catch {
      /* never throw from logging */
    }
  };

  if (config.disabled) {
    log("info", "opencode-agent-profiler disabled via config");
    return {};
  }

  // Health-check: warn if the agent-profiler endpoint is unreachable.
  // Derive the base URL from the traces endpoint (strip /v1/traces suffix).
  const healthUrl = config.endpoint.replace(/\/v1\/traces\/?$/, "") + "/healthz";
  try {
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      log("warn", `agent-profiler health check failed (HTTP ${res.status}) at ${healthUrl} — traces will be dropped until the server is running`);
    } else {
      log("info", `agent-profiler active → ${config.endpoint} (project=${config.projectName})`);
    }
  } catch {
    log("warn", `agent-profiler unreachable at ${healthUrl} — traces will be dropped until the server is running. Start it with: bun dev`);
  }

  applyRedactionEnv(config);

  const otel = initOtel(config);
  if (!otel) {
    log("error", "OpenTelemetry init failed; tracing disabled (plugin is a no-op)");
    return {};
  }

  const builder = new TraceBuilder({
    tracer: otel.tracer,
    config,
    userId: undefined,
  });

  // Discover configured MCP servers once so "<server>_<tool>" splits reliably.
  void discoverMcpServers(client)
    .then((servers) => {
      if (servers) builder.setMcpServers(servers);
    })
    .catch(() => {});

  // Resolve git author email as user.id (optional, content-gated).
  if (config.captureContent && !config.hideInputs) {
    void resolveGitUser(input.$)
      .then((email) => builder.setUserId(email))
      .catch(() => {});
  }

  // Leak sweeper: force-close spans older than maxSpanAgeMs.
  const sweeper = setInterval(() => {
    safe(() => builder.sweep());
  }, config.sweepIntervalMs);
  if (typeof sweeper.unref === "function") sweeper.unref();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweeper);
    safe(() => builder.closeAll());
    await otel.shutdown().catch(() => {});
  };

  const onExit = () => {
    void shutdown();
  };
  process.once("beforeExit", onExit);
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);

  /**
   * Wrap a hook body so it can never throw into OpenCode.
   */
  const guard =
    (name: string, fn: (input: any, output: any) => void) =>
    async (...args: any[]): Promise<void> => {
      try {
        fn(args[0], args[1]);
      } catch (err) {
        log("warn", `hook ${name} failed`, { error: String(err) });
      }
    };

  const hooks: Hooks = {
    dispose: shutdown,

    event: guard("event", (arg: { event: OpencodeEvent }) => {
      const ev = arg?.event;
      if (!ev) return;
      switch (ev.type) {
        case "message.updated": {
          const info = ev.properties?.info as Message | undefined;
          if (info) builder.onMessageUpdated(info);
          break;
        }
        case "message.part.updated": {
          const part = ev.properties?.["part"] as Part | undefined;
          if (part) builder.onMessagePartUpdated(part);
          break;
        }
        case "session.idle":
        case "session.error": {
          const sessionID =
            (ev.properties?.["sessionID"] as string | undefined) ??
            (ev.properties?.["sessionId"] as string | undefined);
          if (sessionID) builder.endSession(sessionID, ev.type === "session.error");
          break;
        }
        case "session.deleted": {
          const sessionID = ev.properties?.["sessionID"] as string | undefined;
          if (sessionID) builder.endSession(sessionID, false);
          break;
        }
        case "server.instance.disposed": {
          void shutdown();
          break;
        }
        default:
          break;
      }
    }),

    "chat.message": guard(
      "chat.message",
      (
        i: {
          sessionID: string;
          messageID?: string;
          agent?: string;
          model?: { providerID: string; modelID: string };
        },
        o: { message: UserMessage; parts: Part[] },
      ) => {
        builder.onChatMessage(i, o);
      },
    ),

    "chat.params": guard(
      "chat.params",
      (
        i: {
          sessionID: string;
          agent: string;
          model: { id: string; providerID: string; [k: string]: unknown };
          provider: { info: { id: string } };
          message: UserMessage;
        },
        o: {
          temperature?: number;
          topP?: number;
          topK?: number;
          maxOutputTokens?: number;
          options?: Record<string, unknown>;
        },
      ) => {
        builder.onChatParams(
          {
            sessionID: i.sessionID,
            agent: i.agent,
            model: { modelID: i.model?.id ?? "" },
            provider: { info: { id: i.provider?.info?.id ?? i.model?.providerID ?? "" } },
            message: i.message,
          },
          o,
        );
      },
    ),

    "experimental.chat.system.transform": guard(
      "system.transform",
      (i: { sessionID?: string }, o: { system: string[] }) => {
        builder.onSystemTransform(i?.sessionID, o?.system ?? []);
      },
    ),

    "experimental.chat.messages.transform": guard(
      "messages.transform",
      (_i: unknown, o: { messages: { info: Message; parts: Part[] }[] }) => {
        builder.onMessagesTransform(o?.messages ?? []);
      },
    ),

    "tool.execute.before": guard(
      "tool.execute.before",
      (i: { tool: string; sessionID: string; callID: string }, o: { args: unknown }) => {
        builder.onToolBefore(i, o);
      },
    ),

    "tool.execute.after": guard(
      "tool.execute.after",
      (
        i: { tool: string; sessionID: string; callID: string; args: unknown },
        o: { title?: string; output?: string; metadata?: unknown },
      ) => {
        builder.onToolAfter(i, o);
      },
    ),
  };

  return hooks;
};

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* swallow */
  }
}

/** Resolve git author email as a best-effort user.id. Never throws. */
async function resolveGitUser(
  $: PluginInput["$"],
): Promise<string | undefined> {
  try {
    const res: unknown = await ($ as any)`git config user.email`.quiet().nothrow();
    const r = res as { text?: () => string; stdout?: unknown };
    const text = typeof r?.text === "function" ? r.text() : String(r?.stdout ?? "");
    const email = text.trim();
    return email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

async function discoverMcpServers(
  client: OpencodeClientLike,
): Promise<ReadonlySet<string> | undefined> {
  try {
    const res = await client.config?.get?.();
    if (!res) return undefined;
    const cfg = (res as { data?: { mcp?: Record<string, unknown> } }).data ??
      (res as { mcp?: Record<string, unknown> });
    const mcp = cfg?.mcp;
    if (!mcp || typeof mcp !== "object") return undefined;
    const set = new Set<string>();
    for (const key of Object.keys(mcp)) set.add(sanitizeMcpKey(key));
    return set;
  } catch {
    return undefined;
  }
}

// Default export so `plugin: ["opencode-agent-profiler"]` resolves either way.
// NOTE: export ONLY the Plugin factory. OpenCode's loader treats every module
// export as a candidate plugin and invokes it; exporting anything else (e.g. a
// class) makes the loader call it and fail.
export default AgentProfilerPlugin;
