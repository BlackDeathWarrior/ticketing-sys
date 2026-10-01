import { Inject, Injectable } from '@nestjs/common';
import {
  CHANNEL_CONFIG_SCHEMAS,
  type ChannelKind,
  type ChannelSettingsView,
  type ConnectionTestResult,
  type EmailChannelConfig,
  emailChannelConfigSchema,
  type KnownSecretKey,
  SECRET_KEYS,
  type SarvamChannelConfig,
  sarvamChannelConfigSchema,
  type WhatsappChannelConfig,
  whatsappChannelConfigSchema,
} from '@tms/shared';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { verifyPhoneNumber } from '../channels/whatsapp/meta-api';
import { explainMetaError } from '../channels/whatsapp/meta-errors';
import type { RequestCtx } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import { AppSettingsService } from './app-settings.service';
import { SecretsService } from './secrets.service';

export interface ResolvedWhatsappConfig extends WhatsappChannelConfig {
  accessToken: string | null;
  /** Where the Graph API lives and which version to call. */
  graph: { baseUrl: string; version: string };
}

export interface ResolvedEmailConfig extends EmailChannelConfig {
  imapPassword: string;
  smtpPassword: string | null;
  source: 'settings' | 'environment';
}

const lastTestSchema = z.object({ ok: z.boolean(), at: z.string(), error: z.string().optional() });
const TEST_TIMEOUT_MS = 10_000;

const configKey = (kind: ChannelKind) => `channel.${kind}`;
const lastTestKey = (kind: ChannelKind) => `channel.${kind}.last_test`;
const secretKeysFor = (kind: ChannelKind) =>
  (Object.keys(SECRET_KEYS) as KnownSecretKey[]).filter((k) => SECRET_KEYS[k].channel === kind);

/**
 * Channel settings, from the Settings page first and environment variables
 * second. Passwords and tokens come from SecretsService.
 */
@Injectable()
export class ChannelConfigService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly settings: AppSettingsService,
    private readonly secrets: SecretsService,
  ) {}

  async email(): Promise<ResolvedEmailConfig | null> {
    const saved = await this.settings.get(configKey('email'), emailChannelConfigSchema);
    if (saved) {
      const imapPassword =
        (await this.secrets.get('email.imap_password')) ?? this.env.EMAIL_IMAP_PASSWORD ?? '';
      const smtpPassword =
        (await this.secrets.get('email.smtp_password')) ?? this.env.EMAIL_SMTP_PASSWORD ?? null;
      return { ...saved, imapPassword, smtpPassword, source: 'settings' };
    }
    const e = this.env;
    if (!e.EMAIL_ADDRESS || !e.EMAIL_IMAP_HOST || !e.EMAIL_SMTP_HOST) return null;
    return {
      enabled: e.EMAIL_ENABLED,
      address: e.EMAIL_ADDRESS,
      fromName: e.EMAIL_FROM_NAME,
      imapHost: e.EMAIL_IMAP_HOST,
      imapPort: e.EMAIL_IMAP_PORT,
      imapSecure: e.EMAIL_IMAP_SECURE,
      imapUser: e.EMAIL_IMAP_USER ?? e.EMAIL_ADDRESS,
      imapMailbox: e.EMAIL_IMAP_MAILBOX,
      pollSeconds: e.EMAIL_POLL_SECONDS,
      smtpHost: e.EMAIL_SMTP_HOST,
      smtpPort: e.EMAIL_SMTP_PORT,
      smtpSecure: e.EMAIL_SMTP_SECURE,
      smtpUser: e.EMAIL_SMTP_USER ?? null,
      imapPassword: e.EMAIL_IMAP_PASSWORD ?? '',
      smtpPassword: e.EMAIL_SMTP_PASSWORD ?? null,
      source: 'environment',
    };
  }

  /**
   * Read fresh every time: a webhook that arrives right after the channel is
   * switched on must not be dropped because of a cached "off".
   */
  async whatsapp(): Promise<ResolvedWhatsappConfig | null> {
    const saved = await this.settings.get(configKey('whatsapp'), whatsappChannelConfigSchema, {
      fresh: true,
    });
    if (!saved) return null;
    return {
      ...saved,
      accessToken: await this.secrets.get('whatsapp.access_token'),
      graph: { baseUrl: this.env.WHATSAPP_GRAPH_URL, version: saved.graphVersion },
    };
  }

  /** What the public webhook checks requests against. Null values mean "reject everything". */
  async whatsappWebhook(): Promise<{ appSecret: string | null; verifyToken: string | null }> {
    return {
      appSecret: await this.secrets.get('whatsapp.app_secret'),
      verifyToken: await this.secrets.get('whatsapp.verify_token'),
    };
  }

  async sarvam(): Promise<(SarvamChannelConfig & { apiKey: string | null }) | null> {
    const saved = await this.settings.get(configKey('sarvam'), sarvamChannelConfigSchema);
    const apiKey = await this.secrets.get('sarvam.api_key');
    if (!saved && !apiKey) return null;
    return { ...(saved ?? sarvamChannelConfigSchema.parse({ enabled: true })), apiKey };
  }

  async view(kind: ChannelKind): Promise<ChannelSettingsView> {
    const saved = await this.settings.get(configKey(kind), CHANNEL_CONFIG_SCHEMAS[kind]);
    let config: Record<string, unknown> | null = saved;
    let source: ChannelSettingsView['source'] = saved ? 'settings' : 'none';
    if (!saved && kind === 'email') {
      const fromEnv = await this.email();
      if (fromEnv) {
        const { imapPassword: _i, smtpPassword: _s, source: _src, ...rest } = fromEnv;
        config = rest;
        source = 'environment';
      }
    }
    const secrets = await Promise.all(
      secretKeysFor(kind).map(async (key) => ({
        key,
        label: SECRET_KEYS[key].label,
        ...(await this.secrets.has(key)),
      })),
    );
    return {
      kind,
      source,
      config,
      secrets,
      lastTest: await this.settings.get(lastTestKey(kind), lastTestSchema),
    };
  }

  async save(ctx: RequestCtx, kind: ChannelKind, config: unknown): Promise<ChannelSettingsView> {
    const parsed = new ZodPipe(CHANNEL_CONFIG_SCHEMAS[kind]).transform(config);
    await this.settings.set(ctx, configKey(kind), parsed);
    return this.view(kind);
  }

  /** Checks the saved credentials against the real service. Audited through the settings write. */
  async test(ctx: RequestCtx, kind: ChannelKind): Promise<ConnectionTestResult> {
    const started = Date.now();
    let result: ConnectionTestResult;
    try {
      const detail = await withTimeout(this.runTest(kind), TEST_TIMEOUT_MS);
      result = { ok: true, latencyMs: Date.now() - started, detail };
    } catch (err) {
      result = { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
    }
    const lastTest = {
      ok: result.ok,
      at: new Date().toISOString(),
      ...(result.error ? { error: result.error.slice(0, 300) } : {}),
    };
    await this.settings.set(ctx, lastTestKey(kind), lastTest, {
      action: 'channel_tested',
      kind,
      ok: result.ok,
    });
    return result;
  }

  private async runTest(kind: ChannelKind): Promise<string> {
    if (kind === 'email') {
      const c = await this.email();
      if (!c) throw new Error('Email is not configured');
      const imap = new ImapFlow({
        host: c.imapHost,
        port: c.imapPort,
        secure: c.imapSecure,
        auth: { user: c.imapUser, pass: c.imapPassword },
        logger: false,
      });
      await imap.connect();
      await imap.logout().catch(() => undefined);
      const smtp = nodemailer.createTransport({
        host: c.smtpHost,
        port: c.smtpPort,
        secure: c.smtpSecure,
        auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPassword ?? '' } : undefined,
      });
      try {
        await smtp.verify();
      } finally {
        smtp.close();
      }
      return `IMAP ${c.imapHost}:${c.imapPort} and SMTP ${c.smtpHost}:${c.smtpPort} accepted the login`;
    }
    if (kind === 'sarvam') {
      const c = await this.sarvam();
      if (!c?.apiKey) throw new Error('The Sarvam API key is not set');
      const res = await fetch(new URL('/text-lid', this.env.SARVAM_API_URL), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-subscription-key': c.apiKey },
        body: JSON.stringify({ input: 'नमस्ते, मुझे मदद चाहिए' }),
      });
      if (!res.ok) throw new Error(`Sarvam answered HTTP ${res.status}`);
      const body = (await res.json()) as { language_code?: string };
      return `Sarvam detected ${body.language_code ?? 'a language'}`;
    }
    const c = await this.whatsapp();
    if (!c) throw new Error('WhatsApp is not configured');
    if (!c.accessToken) throw new Error('The WhatsApp access token is not set');
    let info: Awaited<ReturnType<typeof verifyPhoneNumber>>;
    try {
      info = await verifyPhoneNumber({
        graph: c.graph,
        accessToken: c.accessToken,
        phoneNumberId: c.phoneNumberId,
      });
    } catch (err) {
      throw new Error(explainMetaError(err).summary);
    }
    const hook = await this.whatsappWebhook();
    const missing = [
      ...(hook.appSecret ? [] : ['app secret']),
      ...(hook.verifyToken ? [] : ['webhook verify token']),
    ];
    return [
      `Connected to ${info.display_phone_number ?? c.phoneNumberId}`,
      info.verified_name ? ` (${info.verified_name})` : '',
      info.quality_rating ? `, quality ${info.quality_rating.toLowerCase()}` : '',
      missing.length
        ? `. Incoming messages are rejected until you set the ${missing.join(' and ')}.`
        : '',
    ].join('');
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`No answer within ${ms / 1000}s`)), ms),
    ),
  ]);
}
