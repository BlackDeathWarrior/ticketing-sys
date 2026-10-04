import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * Tracing (ADR 0021): one trace follows a request from the API, through the
 * outbox into the worker's handlers and AI turns, to the model call that
 * LiteLLM makes. Spans are created by hand at those hand-over points rather
 * than by patching libraries, so there is nothing to load before everything
 * else and nothing happens at all when no collector is configured.
 */
let provider: NodeTracerProvider | undefined;

/** Starts exporting spans to an OTLP/HTTP collector. Without an endpoint, tracing stays off. */
export function startTracing(service: string, endpoint: string | undefined): void {
  if (!endpoint) return;
  startTracingWith(
    service,
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    ),
  );
}

/** As `startTracing`, with the span processor given (tests collect spans in memory). */
export function startTracingWith(service: string, processor: SpanProcessor): void {
  if (provider) return;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': service }),
    spanProcessors: [processor],
  });
  // Registers the W3C trace-context propagator and an AsyncLocalStorage context manager.
  provider.register();
}

export async function stopTracing(): Promise<void> {
  const p = provider;
  provider = undefined;
  await p?.shutdown().catch(() => undefined);
}

/**
 * The active span as a W3C `traceparent` value, to hand to whoever continues
 * the work (an outbox event, a queued job, an outgoing request). Null when
 * tracing is off or nothing is being traced.
 */
export function currentTrace(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

export function currentTraceId(): string | null {
  return trace.getSpan(context.active())?.spanContext().traceId ?? null;
}

export interface SpanOptions {
  /** A `traceparent` from another process; the span continues that trace. */
  parent?: string | null;
  kind?: SpanKind;
  attributes?: Attributes;
}

/**
 * Runs `fn` inside a span. The span is the active one for everything `fn`
 * awaits, ends when it settles, and records a thrown error.
 */
export async function withSpan<T>(
  name: string,
  opts: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = opts.parent
    ? propagation.extract(context.active(), { traceparent: opts.parent })
    : context.active();
  const span = trace
    .getTracer('tms')
    .startSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attributes }, parent);
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export { SpanKind };
