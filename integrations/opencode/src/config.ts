/**
 * Plugin configuration: resolves from PluginOptions (opencode.json tuple) →
 * environment variables → defaults. See DESIGN.md §6.8.
 */

export interface ResolvedConfig {
  /** OTLP/HTTP-proto traces endpoint. */
  endpoint: string;
  /** Phoenix project name (routes traces). */
  projectName: string;
  /** Master switch for capturing prompt/response/tool content. */
  captureContent: boolean;
  /** Capture request headers (may contain auth) — off by default. */
  captureHeaders: boolean;
  /** Hard cap on any single attribute string; longer values are truncated. */
  maxAttrChars: number;
  /** Force-close spans older than this (ms) to prevent leaks on missed hooks. */
  maxSpanAgeMs: number;
  /** Periodic sweep interval (ms) for the leak sweeper. */
  sweepIntervalMs: number;
  /** Tool names (exact match) whose outputs are dropped. */
  redactToolOutputs: string[];
  /** Hard off switch — when true, the plugin no-ops. */
  disabled: boolean;
  /** Emit a turn-level CHAIN span between session and LLM/tool spans. */
  emitTurnSpans: boolean;
  /** OpenInference hide flags (mirrored to env for openinference-core). */
  hideInputs: boolean;
  hideOutputs: boolean;
  hideInputMessages: boolean;
  hideOutputMessages: boolean;
  /**
   * If set, every OTLP export batch is appended as a newline-delimited JSON
   * record to this file path. Useful for capturing real traces as test fixtures.
   * Also controllable via AGENT_PROFILER_TRACE_LOG env var.
   */
  traceLog: string | undefined;
  /**
   * If set, every hook invocation is appended as a newline-delimited JSON
   * record to this file path. Records have shape:
   *   { ts, hook, input, output }
   * Useful for capturing real hook event sequences as test fixtures.
   * Also controllable via AGENT_PROFILER_HOOK_LOG env var.
   */
  hookLog: string | undefined;
}

const DEFAULTS: ResolvedConfig = {
  endpoint: "http://localhost:7070/v1/traces",
  projectName: "opencode",
  captureContent: true,
  captureHeaders: false,
  maxAttrChars: 32_000,
  maxSpanAgeMs: 600_000,
  sweepIntervalMs: 30_000,
  redactToolOutputs: [],
  disabled: false,
  emitTurnSpans: true,
  hideInputs: false,
  hideOutputs: false,
  hideInputMessages: false,
  hideOutputMessages: false,
  traceLog: undefined,
  hookLog: undefined,
};

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || v.toLowerCase() === "true";
}

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pick<T>(...vals: (T | undefined)[]): T | undefined {
  for (const v of vals) if (v !== undefined) return v;
  return undefined;
}

/**
 * Resolve effective config. `options` comes from the opencode.json
 * `[name, options]` tuple. Env vars override defaults but are themselves
 * overridden by explicit options.
 */
export function resolveConfig(options?: Record<string, unknown>): ResolvedConfig {
  const o = options ?? {};

  const endpoint =
    pick(
      o["endpoint"] as string | undefined,
      process.env["AGENT_PROFILER_ENDPOINT"],
      process.env["PHOENIX_OTLP_ENDPOINT"],
      process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"],
      // Generic OTLP base endpoint: append the traces path if provided.
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
        ? joinTracesPath(process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]!)
        : undefined,
    ) ?? DEFAULTS.endpoint;

  const projectName =
    pick(
      o["projectName"] as string | undefined,
      process.env["PHOENIX_PROJECT_NAME"],
    ) ?? DEFAULTS.projectName;

  const cfg: ResolvedConfig = {
    endpoint,
    projectName,
    captureContent:
      pick(o["captureContent"] as boolean | undefined, envBool("OI_CAPTURE_CONTENT")) ??
      DEFAULTS.captureContent,
    captureHeaders:
      pick(o["captureHeaders"] as boolean | undefined) ?? DEFAULTS.captureHeaders,
    maxAttrChars:
      pick(o["maxAttrChars"] as number | undefined, envNum("OI_MAX_ATTR_CHARS")) ??
      DEFAULTS.maxAttrChars,
    maxSpanAgeMs:
      pick(o["maxSpanAgeMs"] as number | undefined, envNum("OI_MAX_SPAN_AGE_MS")) ??
      DEFAULTS.maxSpanAgeMs,
    sweepIntervalMs:
      pick(o["sweepIntervalMs"] as number | undefined) ?? DEFAULTS.sweepIntervalMs,
    redactToolOutputs:
      (o["redactToolOutputs"] as string[] | undefined) ?? DEFAULTS.redactToolOutputs,
    disabled:
      pick(o["disabled"] as boolean | undefined, envBool("AGENT_PROFILER_DISABLED"), envBool("OI_DISABLED")) ??
      DEFAULTS.disabled,
    emitTurnSpans:
      pick(o["emitTurnSpans"] as boolean | undefined, envBool("OI_EMIT_TURN_SPANS")) ??
      DEFAULTS.emitTurnSpans,
    hideInputs:
      pick(o["hideInputs"] as boolean | undefined, envBool("OPENINFERENCE_HIDE_INPUTS")) ??
      DEFAULTS.hideInputs,
    hideOutputs:
      pick(o["hideOutputs"] as boolean | undefined, envBool("OPENINFERENCE_HIDE_OUTPUTS")) ??
      DEFAULTS.hideOutputs,
    hideInputMessages:
      pick(
        o["hideInputMessages"] as boolean | undefined,
        envBool("OPENINFERENCE_HIDE_INPUT_MESSAGES"),
      ) ?? DEFAULTS.hideInputMessages,
    hideOutputMessages:
      pick(
        o["hideOutputMessages"] as boolean | undefined,
        envBool("OPENINFERENCE_HIDE_OUTPUT_MESSAGES"),
      ) ?? DEFAULTS.hideOutputMessages,
    traceLog:
      pick(o["traceLog"] as string | undefined, process.env["AGENT_PROFILER_TRACE_LOG"]) ??
      DEFAULTS.traceLog,
    hookLog:
      pick(o["hookLog"] as string | undefined, process.env["AGENT_PROFILER_HOOK_LOG"]) ??
      DEFAULTS.hookLog,
  };

  return cfg;
}

function joinTracesPath(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/traces")) return trimmed;
  return `${trimmed}/v1/traces`;
}

export { DEFAULTS as CONFIG_DEFAULTS };
