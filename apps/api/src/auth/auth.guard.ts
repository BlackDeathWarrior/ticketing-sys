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
import { IS_PUBLIC, REQUIRED_PERMISSIONS } from '../common/request-context';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

/** Global guard: every route needs a valid access token unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly users: UsersService,
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
    if (!token) throw new UnauthorizedException('Missing access token');

    const payload = await this.auth.verifyAccessToken(token);
    if (!payload) throw new UnauthorizedException('Invalid or expired access token');

    const user = await this.users.getAuthContext(payload.sub);
    if (!user) throw new UnauthorizedException('Account is disabled');
    req.user = user;
    return true;
  }
}

/** Global guard: enforces @RequirePermission() after AuthGuard has loaded the user. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndMerge<Permission[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest<FastifyRequest>().user;
    const missing = required.filter((p) => !user?.permissions.includes(p));
    if (missing.length) {
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    }
    return true;
  }
}
