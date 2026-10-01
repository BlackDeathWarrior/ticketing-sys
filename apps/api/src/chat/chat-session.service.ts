import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { chatIdentitySecretKey, integrationExternalId, type MessageEnvelope } from '@tms/shared';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import { IntegrationsService } from '../integrations/integrations.service';
import { SecretsService } from '../settings/secrets.service';

/** A chat visitor's session, carried in a signed token the widget keeps. */
export interface ChatSession {
  sid: string;
  name?: string;
  email?: string;
  /** True when a host website vouched for the email/externalId via an identity token. */
  verified: boolean;
  externalId?: string;
  /** The integration whose site the widget is on (ADR 0026); its chats are its own tickets. */
  integrationId?: string;
  integrationSlug?: string;
}

/** The handshake names an integration that does not exist or is switched off. */
export class UnknownIntegrationError extends Error {
  constructor() {
    super('This chat is not set up correctly: unknown integration');
  }
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
    private readonly integrations: IntegrationsService,
    private readonly secrets: SecretsService,
  ) {}

  /**
   * Resumes a session from its token, or starts a new one from the handshake.
   * A session keeps the integration it started with; a token from another
   * integration's site starts a new session.
   */
  async open(auth: {
    token?: string;
    identityToken?: string;
    name?: string;
    email?: string;
    integration?: string;
  }): Promise<{ session: ChatSession; token: string }> {
    const integration = auth.integration
      ? await this.integrations.activeBySlug(auth.integration)
      : null;
    if (auth.integration && !integration) throw new UnknownIntegrationError();

    if (auth.token) {
      const resumed = await this.verifySession(auth.token);
      if (resumed && resumed.integrationId === integration?.id) {
        return { session: resumed, token: auth.token };
      }
    }
    const identity = auth.identityToken
      ? await this.verifyIdentity(auth.identityToken, integration?.slug)
      : null;
    const session: ChatSession = {
      sid: randomUUID(),
      ...(identity
        ? { ...identity, verified: true }
        : { name: auth.name, email: auth.email, verified: false }),
      ...(integration ? { integrationId: integration.id, integrationSlug: integration.slug } : {}),
    };
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
        identity: {
          type: 'external_id',
          // The same customer as the one the integration names through its API.
          value: s.integrationSlug
            ? integrationExternalId(s.integrationSlug, s.externalId)
            : s.externalId,
        },
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
        integrationId: c.integrationId,
        integrationSlug: c.integrationSlug,
      };
    } catch {
      return null;
    }
  }

  /**
   * Identity tokens are HS256 JWTs signed by the host site: with its
   * integration's own secret when it has one, else with CHAT_IDENTITY_SECRET.
   * A token that does not verify is ignored and the visitor stays anonymous.
   */
  private async verifyIdentity(token: string, integrationSlug?: string) {
    const own = integrationSlug
      ? await this.secrets.get(chatIdentitySecretKey(integrationSlug))
      : null;
    const secret = own ?? this.env.CHAT_IDENTITY_SECRET;
    if (!secret) {
      this.logger.warn('identity token ignored: no chat identity secret is set');
      return null;
    }
    try {
      const c = await this.jwt.verifyAsync<{ sub?: string; email?: string; name?: string }>(token, {
        secret,
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
