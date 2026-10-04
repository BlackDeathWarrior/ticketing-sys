import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TooManyRequestsException } from './rate-limit';

interface PgLikeError {
  code?: string;
  constraint?: string;
  detail?: string;
  cause?: unknown;
}

/** Finds the node-postgres error, which drizzle may wrap in its own query error. */
function pgError(err: unknown): PgLikeError | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
    const e = cur as PgLikeError;
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    cur = e.cause;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgError(err)?.code === '23505';
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload =
        typeof body === 'string'
          ? { statusCode: status, message: body }
          : { statusCode: status, ...body };
      if (exception instanceof TooManyRequestsException) {
        void reply.header('retry-after', String(exception.retryAfter));
      }
      void reply.status(status).send({ ...payload, requestId: req.id });
      return;
    }

    const pg = pgError(exception);
    if (pg?.code === '23505') {
      void reply.status(HttpStatus.CONFLICT).send({
        statusCode: 409,
        message: 'A record with the same unique value already exists',
        constraint: pg.constraint,
        requestId: req.id,
      });
      return;
    }
    if (pg?.code === '23503') {
      void reply.status(HttpStatus.BAD_REQUEST).send({
        statusCode: 400,
        message: 'A referenced record does not exist',
        constraint: pg.constraint,
        requestId: req.id,
      });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    void reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: 500,
      message: 'Internal server error',
      requestId: req.id,
    });
  }
}
