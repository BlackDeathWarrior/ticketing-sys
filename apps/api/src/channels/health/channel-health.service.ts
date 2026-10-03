import { Inject, Injectable } from '@nestjs/common';
import { type ChannelHealth, WORKER_HEARTBEAT_KEY } from '@tms/shared';
import Redis from 'ioredis';
import { ConversationsService } from '../../conversations/conversations.service';
import { REDIS } from '../../infra/tokens';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { ChannelSignalsService } from '../../settings/channel-signals.service';
import { SecretsService } from '../../settings/secrets.service';
import {
  emailHealth,
  mergeActivity,
  NO_ACTIVITY,
  voiceHealth,
  webchatHealth,
  webFormHealth,
  whatsappHealth,
} from './health-rules';

/** A worker heartbeat older than this counts as "not running". */
const WORKER_STALE_MS = 60_000;

/**
 * The status lights in Settings → Channels (ADR 0016). Reading them is
 * cheap: stored settings, a few Redis facts and one query over recent
 * messages. Nothing here calls a mail server or Meta; `probe` does that.
 */
@Injectable()
export class ChannelHealthService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly channels: ChannelConfigService,
    private readonly secrets: SecretsService,
    private readonly signals: ChannelSignalsService,
    private readonly conversations: ConversationsService,
  ) {}

  /** `visitors` and `lines` are what only the API process knows: open chats and live calls. */
  async all(
    opts: { visitors?: number | null; lines?: { active: number; max: number } | null } = {},
  ): Promise<ChannelHealth[]> {
    const now = new Date();
    const [
      email,
      whatsapp,
      sarvam,
      activity,
      workerUp,
      emailSignals,
      waSignals,
      voiceSignals,
      phone,
      phoneSignals,
    ] = await Promise.all([
      this.channels.email(),
      this.channels.whatsapp(),
      this.channels.sarvam(),
      this.conversations.channelActivity(),
      this.workerUp(now),
      this.signals.get('email'),
      this.signals.get('whatsapp'),
      this.signals.get('sarvam'),
      this.channels.phone(),
      this.signals.get('phone'),
    ]);
    const has = async (key: string) => (await this.secrets.has(key)).set;
    const [accessToken, appSecret, verifyToken, sarvamKey] = await Promise.all([
      has('whatsapp.access_token'),
      has('whatsapp.app_secret'),
      has('whatsapp.verify_token'),
      has('sarvam.api_key'),
    ]);

    const emailState = emailHealth({
      config: email ? { enabled: email.enabled, address: email.address } : null,
      poller: emailSignals.poller,
      probe: emailSignals.probe,
      workerUp,
      activity: mergeActivity(activity.email, {
        ...(activity.web_form ?? NO_ACTIVITY),
        // A form submission is not an email arriving in the mailbox.
        lastInboundAt: null,
      }),
      now,
    });
    return [
      emailState,
      whatsappHealth({
        config: whatsapp
          ? {
              enabled: whatsapp.enabled,
              phoneNumberId: whatsapp.phoneNumberId,
              wabaId: whatsapp.wabaId,
            }
          : null,
        secrets: { accessToken, appSecret, verifyToken },
        probe: waSignals.probe,
        webhookAt: waSignals.webhookAt,
        handshakeAt: waSignals.handshakeAt,
        workerUp,
        activity: activity.whatsapp ?? NO_ACTIVITY,
        now,
      }),
      webchatHealth({
        workerUp,
        visitors: opts.visitors ?? null,
        activity: activity.webchat ?? NO_ACTIVITY,
      }),
      webFormHealth({
        workerUp,
        email: emailState.state,
        activity: {
          ...(activity.web_form ?? NO_ACTIVITY),
          // Failed sends are counted under email, where they can be fixed.
          failed24h: 0,
          lastFailure: null,
        },
      }),
      voiceHealth({
        enabled: sarvam ? sarvam.enabled : null,
        keySaved: sarvamKey,
        probe: voiceSignals.probe,
        lines: opts.lines ?? null,
        phone: phone
          ? {
              enabled: phone.enabled,
              keySaved: !!phone.apiKey,
              tokenSaved: !!phone.hookToken,
              probe: phoneSignals.probe,
              lastHookAt: phoneSignals.webhookAt ?? null,
            }
          : null,
        activity: activity.voice ?? NO_ACTIVITY,
      }),
    ];
  }

  /**
   * Runs the live checks for the channels that are switched on and returns
   * what they found. Sarvam is left out: its check is a paid API call, so it
   * only runs when an admin presses "Test connection".
   */
  async probe(): Promise<void> {
    const [email, whatsapp] = await Promise.all([this.channels.email(), this.channels.whatsapp()]);
    await Promise.all([
      email?.enabled ? this.channels.probe('email') : undefined,
      whatsapp?.enabled && whatsapp.accessToken ? this.channels.probe('whatsapp') : undefined,
    ]);
  }

  private async workerUp(now: Date): Promise<boolean> {
    const beat = await this.redis.get(WORKER_HEARTBEAT_KEY).catch(() => null);
    return !!beat && now.getTime() - Number(beat) < WORKER_STALE_MS;
  }
}
