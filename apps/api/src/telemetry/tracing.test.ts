import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  currentTrace,
  currentTraceId,
  SpanKind,
  startTracingWith,
  stopTracing,
  withSpan,
} from './tracing';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('tracing switched off', () => {
  it('runs the work and hands nothing on', async () => {
    expect(currentTrace()).toBeNull();
    const result = await withSpan('work', {}, async () => {
      expect(currentTrace()).toBeNull();
      return 42;
    });
    expect(result).toBe(42);
    await expect(
      withSpan('work', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('tracing switched on', () => {
  const exporter = new InMemorySpanExporter();

  // Started here, not while the file is collected: the "off" tests above run first.
  beforeAll(() => startTracingWith('tms-test', new SimpleSpanProcessor(exporter)));
  beforeEach(() => exporter.reset());
  afterAll(() => stopTracing());

  const span = (name: string) => exporter.getFinishedSpans().find((s) => s.name === name)!;

  it('makes the span the active one for everything the work awaits', async () => {
    await withSpan(
      'request',
      { kind: SpanKind.SERVER, attributes: { route: '/tickets' } },
      async () => {
        const before = currentTrace();
        expect(before).toMatch(TRACEPARENT);
        await pause(5);
        // Still the same span after an await.
        expect(currentTrace()).toBe(before);
        expect(currentTraceId()).toBe(TRACEPARENT.exec(before!)![1]);
      },
    );
    expect(currentTrace()).toBeNull();
    expect(span('request').attributes).toEqual({ route: '/tickets' });
    expect(span('request').kind).toBe(SpanKind.SERVER);
  });

  it('nests work started inside a span under it', async () => {
    await withSpan('outer', {}, async () => {
      await withSpan('inner', {}, async () => pause(1));
    });
    const outer = span('outer');
    const inner = span('inner');
    expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
  });

  it('continues a trace handed over from another process', async () => {
    // The API side: what it writes next to the outbox event.
    let handedOver = '';
    await withSpan('POST /tickets', {}, async () => {
      handedOver = currentTrace()!;
    });
    // The worker side, later and elsewhere: no active span, only the stored value.
    expect(currentTrace()).toBeNull();
    await withSpan(
      'event ticket.created',
      { parent: handedOver, kind: SpanKind.CONSUMER },
      async () => {
        await withSpan('llm chat classifier', { kind: SpanKind.CLIENT }, async () => undefined);
      },
    );
    const api = span('POST /tickets');
    const event = span('event ticket.created');
    const llm = span('llm chat classifier');
    expect(event.spanContext().traceId).toBe(api.spanContext().traceId);
    expect(event.parentSpanContext?.spanId).toBe(api.spanContext().spanId);
    expect(llm.spanContext().traceId).toBe(api.spanContext().traceId);
    expect(llm.parentSpanContext?.spanId).toBe(event.spanContext().spanId);
  });

  it('starts a new trace when nothing was handed over', async () => {
    await withSpan('event sla.sweep', { parent: null }, async () => undefined);
    await withSpan('event other', { parent: 'not-a-traceparent' }, async () => undefined);
    expect(span('event sla.sweep').parentSpanContext).toBeUndefined();
    expect(span('event other').parentSpanContext).toBeUndefined();
  });

  it('records a failure on the span and passes the error on', async () => {
    await expect(
      withSpan('failing', {}, async () => {
        throw new Error('Model unavailable');
      }),
    ).rejects.toThrow('Model unavailable');
    const failed = span('failing');
    expect(failed.status).toEqual({ code: SpanStatusCode.ERROR, message: 'Model unavailable' });
    expect(failed.events[0]!.name).toBe('exception');
  });
});
