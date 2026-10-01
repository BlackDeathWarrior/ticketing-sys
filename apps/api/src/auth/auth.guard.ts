import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@tms/shared';
import type { FastifyRequest } from 'fastify';
import { API_KEY_AUTH, IS_PUBLIC, REQUIRED_PERMISSIONS } from '../common/request-context';
import { looksLikeApiKey } from '../integrations/api-key.util';
import { ApiKeysService } from '../integrations/api-keys.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

/**
 * Global guard: every route needs a valid access token unless marked
 * @Public(). Routes marked @ApiKeyAuth() take an integration's API key
 * instead, and only that (ADR 0022).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    const forApiKeys = this.reflector.getAllAndOverride<boolean>(API_KEY_AUTH, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (forApiKeys) {
      if (!token) throw new UnauthorizedException('Missing API key');
      if (!looksLikeApiKey(token)) throw new UnauthorizedException('This route needs an API key');
      req.apiKey = await this.apiKeys.authenticate(token, req.ip);
      return true;
    }
    if (!token) throw new UnauthorizedException('Missing access token');
    if (looksLikeApiKey(token)) throw new ForbiddenException('API keys cannot call this route');

    const payload = await this.auth.verifyAccessToken(token);
    if (!payload) throw new UnauthorizedException('Invalid or expired access token');

    const user = await this.users.getAuthContext(payload.sub);
    if (!user) throw new UnauthorizedException('Account is disabled');
    req.user = user;
    return true;
  }
}

/**
 * Global guard: enforces @RequirePermission() after AuthGuard has loaded the
 * user, or the API key, whose scopes count as its permissions.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndMerge<Permission[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const held = req.user?.permissions ?? req.apiKey?.scopes ?? [];
    const missing = required.filter((p) => !held.includes(p));
    if (missing.length) {
      const what = req.apiKey ? 'This API key lacks the scope' : 'Missing permission';
      throw new ForbiddenException(`${what}: ${missing.join(', ')}`);
    }
    return true;
  }
}
