import { Inject, Injectable } from '@nestjs/common';
import {
  CHANNEL_CONFIG_SCHEMAS,
  type ChannelKind,
  type ChannelSettingsView,
  type ConnectionTestResult,
  type EmailChannelConfig,
  emailChannelConfigSchema,
  type KnownSecretKey,
  type CallsChannelConfig,
  type ElevenlabsChannelConfig,
  elevenlabsChannelConfigSchema,
  callsChannelConfigSchema,
  type PhoneChannelConfig,
  phoneChannelConfigSchema,
  SECRET_KEYS,
  type SarvamChannelConfig,
  sarvamChannelConfigSchema,
  type WhatsappChannelConfig,
  whatsappChannelConfigSchema,
} from '@tms/shared';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { getSubscribedApps, verifyPhoneNumber } from '../channels/whatsapp/meta-api';
import { explainMetaError } from '../channels/whatsapp/meta-errors';
import type { RequestCtx } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import { AppSettingsService } from './app-settings.service';
import { ChannelSignalsService, type ProbeResult } from './channel-signals.service';
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
    private readonly signals: ChannelSignalsService,
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

  /** Where the Graph API lives (only different behind a proxy). */
  get graphBaseUrl(): string {
    return this.env.WHATSAPP_GRAPH_URL;
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

  /**
   * Phone calls through Sarvam's Voice Agent (ADR 0039). Read fresh: a hook
   * that arrives right after the channel is switched on must not be refused.
   */
  async phone(): Promise<
    (PhoneChannelConfig & { apiKey: string | null; hookToken: string | null }) | null
  > {
    const saved = await this.settings.get(configKey('phone'), phoneChannelConfigSchema, {
      fresh: true,
    });
    if (!saved) return null;
    return {
      ...saved,
      apiKey: await this.secrets.get('phone.sarvam_api_key'),
      hookToken: await this.secrets.get('phone.hook_token'),
    };
  }

  /**
   * Phone calls answered by an ElevenLabs agent (ADR 0040). Read fresh, like
   * `phone()`. `baseUrl` is the API of the workspace's region.
   */
  async elevenlabs(): Promise<
    | (ElevenlabsChannelConfig & {
        apiKey: string | null;
        hookToken: string | null;
        webhookSecret: string | null;
        baseUrl: string;
      })
    | null
  > {
    const saved = await this.settings.get(configKey('elevenlabs'), elevenlabsChannelConfigSchema, {
      fresh: true,
    });
    if (!saved) return null;
    return {
      ...saved,
      apiKey: await this.secrets.get('elevenlabs.api_key'),
      hookToken: await this.secrets.get('elevenlabs.hook_token'),
      webhookSecret: await this.secrets.get('elevenlabs.webhook_secret'),
      baseUrl:
        saved.region === 'default'
          ? this.env.ELEVENLABS_API_URL
          : `https://api.${saved.region}.residency.elevenlabs.io`,
    };
  }

  /**
   * What holds for phone calls whichever provider takes them (ADR 0040). Until
   * that card is saved, calling hours and the link template are the ones saved
   * on the Sarvam card, where they used to live.
   */
  async calls(): Promise<CallsChannelConfig> {
    const saved = await this.settings.get(configKey('calls'), callsChannelConfigSchema, {
      fresh: true,
    });
    if (saved) return saved;
    const phone = await this.settings.get(configKey('phone'), phoneChannelConfigSchema, {
      fresh: true,
    });
    return callsChannelConfigSchema.parse({
      callingHours: phone?.callingHours ?? false,
      linkTemplate: phone?.linkTemplate ?? null,
    });
  }

  /** Where Sarvam's Voice Agents API lives. */
  get sarvamAgentsUrl(): string {
    return this.env.SARVAM_AGENTS_URL;
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
    // Not saved yet: show what is in force, so saving the card changes nothing by accident.
    if (!saved && kind === 'calls') config = await this.calls();
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
    let parsed = new ZodPipe(CHANNEL_CONFIG_SCHEMAS[kind]).transform(config);
    if (kind === 'phone') {
      // The Sarvam card no longer shows calling hours and the link template. While the
      // general card is unsaved they are still read from here, so saving this card keeps them.
      const before = await this.settings.get(configKey('phone'), phoneChannelConfigSchema, {
        fresh: true,
      });
      const given = (config ?? {}) as Record<string, unknown>;
      parsed = {
        ...parsed,
        ...(before && !('callingHours' in given) ? { callingHours: before.callingHours } : {}),
        ...(before && !('linkTemplate' in given) ? { linkTemplate: before.linkTemplate } : {}),
      };
    }
    await this.settings.set(ctx, configKey(kind), parsed);
    return this.view(kind);
  }

  /**
   * Checks the saved credentials against the real service and remembers the
   * outcome for the status lights. Changes nothing, so it is not audited; the
   * worker runs it on a timer and "Check now" runs it on demand.
   */
  async probe(kind: ChannelKind): Promise<ProbeResult> {
    let result: ProbeResult;
    try {
      const { detail, facts } = await withTimeout(this.runTest(kind), TEST_TIMEOUT_MS);
      result = { ok: true, at: new Date().toISOString(), detail, facts };
    } catch (err) {
      result = {
        ok: false,
        at: new Date().toISOString(),
        error: (err as Error).message.slice(0, 500),
        facts: err instanceof ProbeError ? err.facts : undefined,
      };
    }
    await this.signals.set(kind, 'probe', result);
    return result;
  }

  /** "Test connection": a probe an admin asked for, recorded in the audit log. */
  async test(ctx: RequestCtx, kind: ChannelKind): Promise<ConnectionTestResult> {
    const started = Date.now();
    const probe = await this.probe(kind);
    const lastTest = {
      ok: probe.ok,
      at: probe.at,
      ...(probe.error ? { error: probe.error.slice(0, 300) } : {}),
    };
    await this.settings.set(ctx, lastTestKey(kind), lastTest, {
      action: 'channel_tested',
      kind,
      ok: probe.ok,
    });
    return {
      ok: probe.ok,
      latencyMs: Date.now() - started,
      ...(probe.ok ? { detail: probe.detail } : { error: probe.error }),
    };
  }

  private async runTest(kind: ChannelKind): Promise<{ detail: string; facts: Facts }> {
    if (kind === 'email') return this.testEmail();
    if (kind === 'calls') throw new Error('These settings have nothing to test');
    if (kind === 'elevenlabs') {
      const c = await this.elevenlabs();
      if (!c) throw new Error('The ElevenLabs settings are not saved');
      if (!c.apiKey) throw new Error('The ElevenLabs API key is not set');
      // Listing the workspace's agents costs nothing and proves the key and the region.
      const res = await fetch(new URL('/v1/convai/agents?page_size=100', c.baseUrl), {
        headers: { 'xi-api-key': c.apiKey },
      });
      if (!res.ok) throw new Error(`ElevenLabs answered HTTP ${res.status}`);
      const body = (await res.json()) as { agents?: unknown[]; has_more?: boolean };
      const n = body.agents?.length ?? 0;
      return {
        detail: `ElevenLabs lists ${n}${body.has_more ? '+' : ''} agent${n === 1 ? '' : 's'}`,
        facts: {},
      };
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
      return { detail: `Sarvam detected ${body.language_code ?? 'a language'}`, facts: {} };
    }
    if (kind === 'phone') {
      const c = await this.phone();
      if (!c) throw new Error('Phone calls are not configured');
      if (!c.apiKey) throw new Error('The Voice Agents API key is not set');
      // Listing the workspace's deployments costs nothing and proves the key and both ids.
      const path = `/api/app-authoring/v1/orgs/${encodeURIComponent(c.orgId)}/workspaces/${encodeURIComponent(c.workspaceId)}/deployments`;
      const res = await fetch(new URL(path, this.env.SARVAM_AGENTS_URL), {
        headers: { 'X-API-Key': c.apiKey },
      });
      if (!res.ok) throw new Error(`Sarvam answered HTTP ${res.status}`);
      const body = (await res.json()) as { total?: number };
      const n = body.total ?? 0;
      return { detail: `Sarvam lists ${n} deployment${n === 1 ? '' : 's'}`, facts: {} };
    }
    return this.testWhatsapp();
  }

  /** Reading (IMAP) and sending (SMTP) are checked separately, so a failure names its half. */
  private async testEmail(): Promise<{ detail: string; facts: Facts }> {
    const c = await this.email();
    if (!c) throw new Error('Email is not configured');
    const attempt = async (fn: () => Promise<void>) => {
      try {
        await fn();
        return 'ok';
      } catch (err) {
        return (err as Error).message || 'failed';
      }
    };
    const imap = await attempt(async () => {
      const client = new ImapFlow({
        host: c.imapHost,
        port: c.imapPort,
        secure: c.imapSecure,
        auth: { user: c.imapUser, pass: c.imapPassword },
        logger: false,
      });
      await client.connect();
      await client.logout().catch(() => undefined);
    });
    const smtp = await attempt(async () => {
      const transport = nodemailer.createTransport({
        host: c.smtpHost,
        port: c.smtpPort,
        secure: c.smtpSecure,
        auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPassword ?? '' } : undefined,
      });
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
    });
    const facts = { imap, smtp };
    if (imap !== 'ok' || smtp !== 'ok') {
      const parts = [
        ...(imap !== 'ok' ? [`IMAP ${c.imapHost}:${c.imapPort}: ${imap}`] : []),
        ...(smtp !== 'ok' ? [`SMTP ${c.smtpHost}:${c.smtpPort}: ${smtp}`] : []),
      ];
      throw new ProbeError(parts.join('. '), facts);
    }
    return {
      detail: `IMAP ${c.imapHost}:${c.imapPort} and SMTP ${c.smtpHost}:${c.smtpPort} accepted the login`,
      facts,
    };
  }

  private async testWhatsapp(): Promise<{ detail: string; facts: Facts }> {
    const c = await this.whatsapp();
    if (!c) throw new Error('WhatsApp is not configured');
    if (!c.accessToken) throw new Error('The WhatsApp access token is not set');
    const credentials = { graph: c.graph, accessToken: c.accessToken };
    let info: Awaited<ReturnType<typeof verifyPhoneNumber>>;
    try {
      info = await verifyPhoneNumber({ ...credentials, phoneNumberId: c.phoneNumberId });
    } catch (err) {
      throw new Error(explainMetaError(err).summary);
    }
    // Whether Meta sends this account's webhooks to an app at all. Not knowing is not a failure.
    let subscribed: boolean | null = null;
    if (c.wabaId) {
      subscribed = await getSubscribedApps({ ...credentials, wabaId: c.wabaId })
        .then((apps) => apps.length > 0)
        .catch(() => null);
    }
    const hook = await this.whatsappWebhook();
    const missing = [
      ...(hook.appSecret ? [] : ['app secret']),
      ...(hook.verifyToken ? [] : ['webhook verify token']),
    ];
    return {
      detail: [
        `Connected to ${info.display_phone_number ?? c.phoneNumberId}`,
        info.verified_name ? ` (${info.verified_name})` : '',
        info.quality_rating ? `, quality ${info.quality_rating.toLowerCase()}` : '',
        missing.length
          ? `. Incoming messages are rejected until you set the ${missing.join(' and ')}.`
          : '',
      ].join(''),
      facts: {
        displayPhoneNumber: info.display_phone_number ?? null,
        verifiedName: info.verified_name ?? null,
        quality: info.quality_rating ?? null,
        subscribed,
      },
    };
  }
}

type Facts = Record<string, unknown>;

/** A failed check that still learned something (which half of email failed). */
class ProbeError extends Error {
  constructor(
    message: string,
    readonly facts: Facts,
  ) {
    super(message);
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
