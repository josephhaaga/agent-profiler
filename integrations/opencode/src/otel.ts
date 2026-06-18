/**
 * OpenTelemetry bootstrap. Mirrors the validated M0 spike: NodeTracerProvider +
 * BatchSpanProcessor + OTLP/HTTP-proto exporter, which runs cleanly under Bun.
 *
 * Exposes a single module-scoped provider per plugin load and a `shutdown()`
 * that force-flushes batched spans — critical for short CLI sessions.
 */
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { trace, type Tracer } from "@opentelemetry/api";
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions";
import type { ResolvedConfig } from "./config.js";

const TRACER_NAME = "opencode-openinference";
const TRACER_VERSION = "0.1.0";

export interface OtelHandle {
  tracer: Tracer;
  shutdown: () => Promise<void>;
  forceFlush: () => Promise<void>;
}

/**
 * Initialize OTel. Returns `null` if initialization throws (e.g. a runtime
 * incompatibility), so callers can degrade to a no-op plugin instead of
 * crashing the agent.
 */
export function initOtel(config: ResolvedConfig): OtelHandle | null {
  try {
    const exporter = new OTLPTraceExporter({ url: config.endpoint });

    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [SEMRESATTRS_PROJECT_NAME]: config.projectName,
        "service.name": config.projectName,
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });

    // Register so trace.getTracer(...) resolves to this provider. We avoid
    // setting global context managers we do not need.
    provider.register();

    const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);

    return {
      tracer,
      forceFlush: () => provider.forceFlush(),
      shutdown: async () => {
        await provider.forceFlush().catch(() => {});
        await provider.shutdown().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}
