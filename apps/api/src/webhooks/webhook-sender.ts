import { Inject, Injectable } from '@nestjs/common';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookPayload,
} from '@tms/shared';
import { assertPublicUrl, UnsafeUrlError } from '../common/url-fetch';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import { buildSignatureHeader } from './webhook-sign';

export interface SendOutcome {
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  /** A short reason, never the receiver's response body. */
  error: string | null;
  /** Retrying can't fix it (an address we refuse to call). */
  permanent: boolean;
}

/**
 * Sends one signed webhook. The address is checked on every send: a public
 * https address, or a host listed in WEBHOOK_PRIVATE_HOSTS. Redirects are
 * refused, so a receiver can't point us somewhere else.
 */
@Injectable()
export class WebhookSender {
  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Why this address can't be a webhook target, or null when it can. */
  async refusal(rawUrl: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return 'Not a valid URL';
    }
    const trusted = this.env.WEBHOOK_PRIVATE_HOSTS.includes(url.hostname.toLowerCase());
    if (url.protocol !== 'https:' && !trusted) return 'Webhook addresses must use https';
    try {
      await assertPublicUrl(rawUrl, trusted);
      return null;
    } catch (err) {
      if (err instanceof UnsafeUrlError) return err.message;
      // A name that doesn't resolve right now: let the delivery try and fail.
      return null;
    }
  }

  async send(url: string, secret: string, payload: WebhookPayload): Promise<SendOutcome> {
    const started = Date.now();
    const done = (o: Omit<SendOutcome, 'durationMs'>): SendOutcome => ({
      ...o,
      durationMs: Date.now() - started,
    });

    const refused = await this.refusal(url);
    if (refused) return done({ ok: false, httpStatus: null, error: refused, permanent: true });

    const body = JSON.stringify(payload);
    try {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.env.WEBHOOK_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'TMS-Webhooks/1.0',
          [WEBHOOK_EVENT_HEADER]: payload.type,
          [WEBHOOK_DELIVERY_HEADER]: payload.id,
          [WEBHOOK_SIGNATURE_HEADER]: buildSignatureHeader(
            body,
            secret,
            Math.floor(Date.now() / 1000),
          ),
        },
        body,
      });
      // We only need the status; don't hold the connection for a body.
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) {
        return done({ ok: true, httpStatus: res.status, error: null, permanent: false });
      }
      const redirect = res.status >= 300 && res.status < 400;
      return done({
        ok: false,
        httpStatus: res.status,
        error: redirect ? 'The receiver answered with a redirect' : `HTTP ${res.status}`,
        permanent: false,
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const error =
        e.name === 'TimeoutError'
          ? `No answer within ${this.env.WEBHOOK_TIMEOUT_MS} ms`
          : e.cause?.code
            ? `Could not connect (${e.cause.code})`
            : 'Could not connect';
      return done({ ok: false, httpStatus: null, error, permanent: false });
    }
  }
}
