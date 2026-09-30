import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Actor, CurrentUser, Permission } from '@tms/shared';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user?: CurrentUser;
  }
}

/** Who is acting and where the request came from; passed into services for audit and events. */
export interface RequestCtx {
  actor: Actor;
  user?: CurrentUser;
  requestId?: string;
  ip?: string;
}

export const IS_PUBLIC = 'tms:isPublic';
export const REQUIRED_PERMISSIONS = 'tms:permissions';

/** Skips authentication (login, health, channel webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Requires every listed permission. */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

export function ctxFromRequest(req: FastifyRequest): RequestCtx {
  return {
    actor: req.user ? { type: 'user', id: req.user.id } : { type: 'system', id: null },
    user: req.user,
    requestId: String(req.id),
    ip: req.ip,
  };
}

export const Ctx = createParamDecorator((_: unknown, context: ExecutionContext): RequestCtx =>
  ctxFromRequest(context.switchToHttp().getRequest<FastifyRequest>()),
);

export const User = createParamDecorator(
  (_: unknown, context: ExecutionContext): CurrentUser | undefined =>
    context.switchToHttp().getRequest<FastifyRequest>().user,
);

export const SYSTEM_CTX: RequestCtx = { actor: { type: 'system', id: null } };

/** The AI agent acting: audit rows and events carry actor type `ai`. */
export const AI_CTX: RequestCtx = { actor: { type: 'ai', id: null } };
