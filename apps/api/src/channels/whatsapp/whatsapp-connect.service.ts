import { BadRequestException, Injectable } from '@nestjs/common';
import type { HealthCheck, ParsedWhatsappConnect, WhatsappConnectResult } from '@tms/shared';
import type { RequestCtx } from '../../common/request-context';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { SecretsService } from '../../settings/secrets.service';
import {
  describeWabaPhoneMismatch,
  listWabaPhoneNumbers,
  type MetaPhoneInfo,
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from './meta-api';
import { explainMetaError } from './meta-errors';

/**
 * "Connect WhatsApp": one form, checked against Meta before anything is
 * saved, so a mistyped ID or an expired token never replaces settings that
 * work. Follows the connect flow of whatsapp-crm (ADR 0015, ADR 0016).
 */
@Injectable()
export class WhatsAppConnectService {
  constructor(
    private readonly channels: ChannelConfigService,
    private readonly secrets: SecretsService,
  ) {}

  async connect(ctx: RequestCtx, input: ParsedWhatsappConnect): Promise<WhatsappConnectResult> {
    const steps: HealthCheck[] = [];
    const failed = (): WhatsappConnectResult => ({ connected: false, steps, number: null });

    const accessToken = input.accessToken ?? (await this.secrets.get('whatsapp.access_token'));
    if (!accessToken) {
      throw new BadRequestException('Enter the access token from Meta → WhatsApp → API setup');
    }
    const credentials = {
      graph: { baseUrl: this.channels.graphBaseUrl, version: input.graphVersion },
      accessToken,
    };

    // 1. The token works and the phone number ID is real.
    let info: MetaPhoneInfo;
    try {
      info = await verifyPhoneNumber({ ...credentials, phoneNumberId: input.phoneNumberId });
    } catch (err) {
      steps.push({
        key: 'number',
        label: 'Token and phone number',
        state: 'down',
        detail: explainMetaError(err).summary,
      });
      return failed();
    }
    const display = info.display_phone_number ?? input.phoneNumberId;
    steps.push({
      key: 'number',
      label: 'Token and phone number',
      state: 'ok',
      detail: `Meta accepts the token for ${display}${info.verified_name ? ` (${info.verified_name})` : ''}`,
    });

    // 2. The number lives under the business account that was typed.
    try {
      const numbers = await listWabaPhoneNumbers({ ...credentials, wabaId: input.wabaId });
      if (!numbers.some((n) => n.id === input.phoneNumberId)) {
        steps.push({
          key: 'account',
          label: 'Business account',
          state: 'down',
          detail: describeWabaPhoneMismatch(numbers, input.phoneNumberId, input.wabaId),
        });
        return failed();
      }
    } catch (err) {
      steps.push({
        key: 'account',
        label: 'Business account',
        state: 'down',
        detail: explainMetaError(err).summary,
      });
      return failed();
    }
    steps.push({
      key: 'account',
      label: 'Business account',
      state: 'ok',
      detail: 'The number belongs to this WhatsApp Business account',
    });

    // The values are right: save them. Each write is audited by its service.
    await this.channels.save(ctx, 'whatsapp', {
      enabled: true,
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      graphVersion: input.graphVersion,
    });
    for (const [key, value] of [
      ['whatsapp.access_token', input.accessToken],
      ['whatsapp.app_secret', input.appSecret],
      ['whatsapp.verify_token', input.verifyToken],
    ] as const) {
      if (value) await this.secrets.set(ctx, key, value);
    }

    // 3. Register the number, when a PIN was given. Test numbers come registered.
    if (input.pin) {
      try {
        const { alreadyRegistered } = await registerPhoneNumber({
          ...credentials,
          phoneNumberId: input.phoneNumberId,
          pin: input.pin,
        });
        steps.push({
          key: 'register',
          label: 'Number registration',
          state: 'ok',
          detail: alreadyRegistered ? 'Already registered' : 'Registered with the Cloud API',
        });
      } catch (err) {
        steps.push({
          key: 'register',
          label: 'Number registration',
          state: 'warning',
          detail: explainMetaError(err).summary,
        });
      }
    }

    // 4. Ask Meta to send this account's messages to the app the token belongs to.
    try {
      await subscribeWabaToApp({ ...credentials, wabaId: input.wabaId });
      steps.push({
        key: 'subscription',
        label: 'Webhook subscription',
        state: 'ok',
        detail: "Meta will send this account's messages to your app",
      });
    } catch (err) {
      steps.push({
        key: 'subscription',
        label: 'Webhook subscription',
        state: 'warning',
        detail: explainMetaError(err).summary,
      });
    }

    // 5. Whether our side will accept what Meta sends.
    const hook = await this.channels.whatsappWebhook();
    steps.push(
      hook.appSecret && hook.verifyToken
        ? {
            key: 'security',
            label: 'Webhook security',
            state: 'ok',
            detail: 'App secret and verify token are saved',
          }
        : {
            key: 'security',
            label: 'Webhook security',
            state: 'warning',
            detail: !hook.appSecret
              ? 'Incoming messages are refused until the app secret is saved'
              : 'Meta cannot verify the webhook address until a verify token is saved',
          },
    );

    // Refresh the status light straight away.
    await this.channels.probe('whatsapp');
    return {
      connected: true,
      steps,
      number: {
        display,
        name: info.verified_name ?? null,
        quality: info.quality_rating ?? null,
      },
    };
  }
}
