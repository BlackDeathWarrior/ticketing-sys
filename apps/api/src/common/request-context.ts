import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { Actor, CurrentUser, Permission } from '@tms/shared';
import type { FastifyRequest } from 'fastify';

/** The API key a request was made with, and the integration it belongs to (ADR 0022). */
export interface ApiKeyContext {
  id: string;
  name: string;
  prefix: string;
  /** Permission strings; checked by PermissionsGuard like a user's permissions. */
  scopes: string[];
  rateLimitPerMinute: number;
  integration: { id: string; slug: string; name: string };
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: CurrentUser;
    apiKey?: ApiKeyContext;
  }
}

/** Who is acting and where the request came from; passed into services for audit and events. */
export interface RequestCtx {
  actor: Actor;
  user?: CurrentUser;
  apiKey?: ApiKeyContext;
  requestId?: string;
  ip?: string;
}

export const IS_PUBLIC = 'tms:isPublic';
export const REQUIRED_PERMISSIONS = 'tms:permissions';
export const API_KEY_AUTH = 'tms:apiKeyAuth';

/** Skips authentication (login, health, channel webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Requires every listed permission. */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * The route is for integrations: it takes an API key and refuses staff access
 * tokens. Everywhere else an API key is refused, so a key can never reach
 * code written for a signed-in person.
 */
export const ApiKeyAuth = () => SetMetadata(API_KEY_AUTH, true);

export function ctxFromRequest(req: FastifyRequest): RequestCtx {
  return {
    actor: req.user
      ? { type: 'user', id: req.user.id }
      : req.apiKey
        ? { type: 'integration', id: req.apiKey.id }
        : { type: 'system', id: null },
    user: req.user,
    apiKey: req.apiKey,
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

/** The calling API key on an `@ApiKeyAuth()` route. */
export const ApiKey = createParamDecorator(
  (_: unknown, context: ExecutionContext): ApiKeyContext => {
    const key = context.switchToHttp().getRequest<FastifyRequest>().apiKey;
    if (!key) throw new UnauthorizedException('This route needs an API key');
    return key;
  },
);

export const SYSTEM_CTX: RequestCtx = { actor: { type: 'system', id: null } };

/** The AI agent acting: audit rows and events carry actor type `ai`. */
export const AI_CTX: RequestCtx = { actor: { type: 'ai', id: null } };
