import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { MessageEnvelope } from '@tms/shared';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';

/** A chat visitor's session, carried in a signed token the widget keeps. */
export interface ChatSession {
  sid: string;
  name?: string;
  email?: string;
  /** True when a host website vouched for the email/externalId via an identity token. */
  verified: boolean;
  externalId?: string;
}

interface SessionClaims extends ChatSession {
  typ: 'chat';
}

const SESSION_TTL = '30d';
const ISSUER = 'tms';
const AUDIENCE = 'tms-chat';

@Injectable()
export class ChatSessionService {
  private readonly logger = new Logger(ChatSessionService.name);

  constructor(
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Resumes a session from its token, or starts a new one from the handshake. */
  async open(auth: {
    token?: string;
    identityToken?: string;
    name?: string;
    email?: string;
  }): Promise<{ session: ChatSession; token: string }> {
    if (auth.token) {
      const resumed = await this.verifySession(auth.token);
      if (resumed) return { session: resumed, token: auth.token };
    }
    const identity = auth.identityToken ? await this.verifyIdentity(auth.identityToken) : null;
    const session: ChatSession = identity
      ? { sid: randomUUID(), ...identity, verified: true }
      : { sid: randomUUID(), name: auth.name, email: auth.email, verified: false };
    return { session, token: await this.sign(session) };
  }

  /**
   * Who the message is from. A vouched-for identity links to the existing
   * customer; otherwise the chat session is the identity and a typed email is
   * only attached if no other customer already owns it.
   */
  sender(s: ChatSession): MessageEnvelope['from'] {
    const session = { type: 'webchat_session' as const, value: s.sid, verified: true };
    if (s.verified && s.externalId) {
      return {
        identity: { type: 'external_id', value: s.externalId },
        displayName: s.name,
        extraIdentities: [
          session,
          ...(s.email ? [{ type: 'email' as const, value: s.email, verified: true }] : []),
        ],
      };
    }
    if (s.verified && s.email) {
      return {
        identity: { type: 'email', value: s.email },
        displayName: s.name,
        extraIdentities: [session],
      };
    }
    return {
      identity: { type: 'webchat_session', value: s.sid },
      displayName: s.name || s.email || undefined,
      extraIdentities: s.email ? [{ type: 'email', value: s.email, verified: false }] : [],
    };
  }

  private sign(session: ChatSession): Promise<string> {
    const claims: SessionClaims = { ...session, typ: 'chat' };
    return this.jwt.signAsync(claims, {
      secret: this.env.JWT_SECRET,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: SESSION_TTL,
    });
  }

  private async verifySession(token: string): Promise<ChatSession | null> {
    try {
      const c = await this.jwt.verifyAsync<SessionClaims>(token, {
        secret: this.env.JWT_SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (c.typ !== 'chat' || !c.sid) return null;
      return {
        sid: c.sid,
        name: c.name,
        email: c.email,
        verified: !!c.verified,
        externalId: c.externalId,
      };
    } catch {
      return null;
    }
  }

  /** Identity tokens are HS256 JWTs signed by the host site with CHAT_IDENTITY_SECRET. */
  private async verifyIdentity(token: string) {
    if (!this.env.CHAT_IDENTITY_SECRET) {
      this.logger.warn('identity token ignored: CHAT_IDENTITY_SECRET is not set');
      return null;
    }
    try {
      const c = await this.jwt.verifyAsync<{ sub?: string; email?: string; name?: string }>(token, {
        secret: this.env.CHAT_IDENTITY_SECRET,
        algorithms: ['HS256'],
      });
      if (!c.sub && !c.email) return null;
      return { externalId: c.sub, email: c.email?.toLowerCase(), name: c.name };
    } catch (err) {
      this.logger.warn(`invalid chat identity token: ${(err as Error).message}`);
      return null;
    }
  }
}
