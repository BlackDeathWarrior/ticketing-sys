import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { context as otel, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { stopTracing } from './tracing';

/**
 * One server span per HTTP request, active while the handler runs: whatever
 * the handler writes to the outbox carries the trace on (ADR 0021). Continues
 * a caller's trace when the request brings a `traceparent` header.
 */
@Injectable()
export class TracingInterceptor implements NestInterceptor, OnApplicationShutdown {
  /** Sends the spans still waiting in the batch before the process exits. */
  async onApplicationShutdown(): Promise<void> {
    await stopTracing();
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const res = ctx.switchToHttp().getResponse<FastifyReply>();
    // The route pattern, not the URL: ids and tokens in paths stay out of traces.
    const route = req.routeOptions?.url ?? 'unknown';
    // Health probes arrive every few seconds and say nothing.
    if (route.includes('/health/')) return next.handle();
    const parent = propagation.extract(otel.active(), req.headers);
    const span = trace.getTracer('tms').startSpan(
      `${req.method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': req.method,
          'http.route': route,
          'tms.request_id': String(req.id),
        },
      },
      parent,
    );
    const active = trace.setSpan(parent, span);
    return new Observable((subscriber) => {
      const finish = (error?: Error) => {
        // On an error the reply isn't written yet (the exception filter does that next).
        const status = error
          ? ((error as { getStatus?: () => number }).getStatus?.() ?? 500)
          : res.statusCode;
        span.setAttribute('http.response.status_code', status);
        // A refused request (4xx) is the caller's mistake, not a failure of ours.
        if (error && status >= 500) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        }
        span.end();
      };
      const subscription = otel.with(active, () =>
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (err: Error) => {
            finish(err);
            subscriber.error(err);
          },
          complete: () => {
            finish();
            subscriber.complete();
          },
        }),
      );
      return () => subscription.unsubscribe();
    });
  }
}
