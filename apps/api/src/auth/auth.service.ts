import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type Database, refreshTokens } from '@tms/db';
import type { AuthTokens } from '@tms/shared';
import argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { RateLimiterService, tooManyRequests } from '../common/rate-limit';
import type { RequestCtx } from '../common/request-context';
import { type Env } from '../config/env';
import { DB, ENV } from '../infra/tokens';
import { UsersService } from '../users/users.service';

export interface AccessTokenPayload {
  sub: string;
  typ: 'access';
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Wrong passwords allowed for one account from one address before a pause. */
const LOGIN_FAILURES = 10;
const LOCKOUT_SECONDS = 15 * 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Verified against when the account doesn't exist, so login timing doesn't reveal that. */
  private readonly dummyHash = argon2.hash(randomBytes(16).toString('hex'));

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiterService,
  ) {}

  async login(ctx: RequestCtx, email: string, password: string): Promise<AuthTokens> {
    // Wrong passwords for one account from one address: after ten, wait.
    const who = `${createHash('sha256').update(email.toLowerCase()).digest('hex')}:${ctx.ip ?? '-'}`;
    if (this.limiter.enabled && (await this.limiter.count('login-failed', who)) >= LOGIN_FAILURES) {
      await this.audit.record(this.db, ctx, {
        action: 'auth.login_locked',
        targetType: 'user',
        data: { email },
      });
      throw tooManyRequests(LOCKOUT_SECONDS, 'failed sign-in attempts');
    }
    const user = await this.users.findByEmail(email);
    const ok = user?.passwordHash
      ? await argon2.verify(user.passwordHash, password)
      : await argon2.verify(await this.dummyHash, password).then(() => false);

    if (!user || !ok || !user.isActive) {
      await this.audit.record(this.db, ctx, {
        action: 'auth.login_failed',
        targetType: 'user',
        targetId: user?.id ?? null,
        data: { email },
      });
      if (this.limiter.enabled) {
        await this.limiter.hit('login-failed', who, LOGIN_FAILURES, LOCKOUT_SECONDS);
      }
      throw new UnauthorizedException('Email or password is incorrect');
    }
    await this.limiter.reset('login-failed', who);

    await this.users.touchLogin(user.id);
    await this.audit.record(
      this.db,
      { ...ctx, actor: { type: 'user', id: user.id } },
      {
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
      },
    );
    return this.issue(user.id);
  }

  /**
   * Rotates the refresh token. Presenting a token that was already rotated
   * revokes every session for that user, since it means the token leaked.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(refreshToken)));
    if (!row) throw new UnauthorizedException('Invalid refresh token');

    if (row.revokedAt) {
      if (row.replacedById) {
        this.logger.warn(
          `Refresh token reuse detected for user ${row.userId}; revoking all sessions`,
        );
        await this.revokeAll(row.userId);
      }
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (row.expiresAt < new Date()) throw new UnauthorizedException('Refresh token expired');

    const user = await this.users.getAuthContext(row.userId);
    if (!user) throw new UnauthorizedException('Account is disabled');

    const tokens = await this.issue(row.userId);
    const [next] = await this.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(tokens.refreshToken)));
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedById: next!.id })
      .where(eq(refreshTokens.id, row.id));
    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(refreshTokens.tokenHash, hashToken(refreshToken)), isNull(refreshTokens.revokedAt)),
      );
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
      return payload.typ === 'access' ? payload : null;
    } catch {
      return null;
    }
  }

  private async revokeAll(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  private async issue(userId: string): Promise<AuthTokens> {
    const payload: AccessTokenPayload = { sub: userId, typ: 'access' };
    const accessToken = await this.jwt.signAsync(payload);
    const decoded = this.jwt.decode<{ exp: number; iat: number }>(accessToken);
    const refreshToken = randomBytes(32).toString('base64url');
    await this.db.insert(refreshTokens).values({
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + this.env.JWT_REFRESH_TTL_DAYS * 86_400_000),
    });
    return { accessToken, refreshToken, expiresIn: decoded.exp - decoded.iat };
  }
}
