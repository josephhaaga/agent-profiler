/**
 * OpenTelemetry bootstrap. NodeTracerProvider + BatchSpanProcessor +
 * OTLP/HTTP-JSON exporter (not proto — the agent-profiler server only accepts
 * application/json).
 *
 * Exposes a single module-scoped provider per plugin load and a `shutdown()`
 * that force-flushes batched spans — critical for short CLI sessions.
 */
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { trace, type Tracer } from "@opentelemetry/api";
import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions";
import { appendFileSync } from "fs";
import type { ResolvedConfig } from "./config.js";

const TRACER_NAME = "opencode-openinference";
const TRACER_VERSION = "0.1.0";

export interface OtelHandle {
  tracer: Tracer;
  shutdown: () => Promise<void>;
  forceFlush: () => Promise<void>;
}

/**
 * Wraps a SpanExporter to also append each batch as a newline-delimited JSON
 * record to a log file. Useful for capturing real traces as test fixtures.
 * Never throws — logging failures are silently swallowed.
 */
class LoggingSpanExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly logPath: string,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: { code: number }) => void): void {
    try {
      const record = {
        ts: new Date().toISOString(),
        spans: spans.map((s) => ({
          traceId: s.spanContext().traceId,
          spanId: s.spanContext().spanId,
          parentSpanId: (s as unknown as { parentSpanId?: string }).parentSpanId,
          name: s.name,
          kind: s.kind,
          startTimeUnixNano: hrTimeToNano(s.startTime),
          endTimeUnixNano: hrTimeToNano(s.endTime),
          attributes: s.attributes,
          status: s.status,
        })),
      };
      appendFileSync(this.logPath, JSON.stringify(record) + "\n", "utf8");
    } catch {
      // never let logging break the exporter
    }
    this.inner.export(spans, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush?(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

function hrTimeToNano(hrTime: [number, number]): string {
  return (BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1])).toString();
}

/**
 * Initialize OTel. Returns `null` if initialization throws (e.g. a runtime
 * incompatibility), so callers can degrade to a no-op plugin instead of
 * crashing the agent.
 */
export function initOtel(config: ResolvedConfig): OtelHandle | null {
  try {
    const otlpExporter = new OTLPTraceExporter({ url: config.endpoint });
    const exporter: SpanExporter = config.traceLog
      ? new LoggingSpanExporter(otlpExporter, config.traceLog)
      : otlpExporter;

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
