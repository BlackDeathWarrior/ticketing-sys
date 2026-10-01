/*
 * Adapted from whatsapp-crm (a fork of ArnasDon/wacrm), src/lib/whatsapp/meta-error-explain.ts
 * at commit 47100ad. MIT License, Copyright (c) 2026 Arnas Donauskas.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changed for TMS: the original explains the connect flow. This version also
 * explains failed sends (from the API call or a later `failed` status) and
 * says whether trying again can help.
 */

/** Meta's error fields, from a `MetaApiError` or a status webhook's `errors[]`. */
export interface MetaErrorLike {
  message: string;
  code?: number | null;
  subcode?: number | null;
  type?: string | null;
  fbtraceId?: string | null;
  httpStatus?: number | null;
  details?: string | null;
}

export interface MetaErrorExplanation {
  /** Plain words an agent or admin can act on. */
  summary: string;
  /** True when the same request may work later (rate limits, Meta outages). */
  retryable: boolean;
  code: number | null;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056]);
const TEMPORARY_CODES = new Set([1, 2, 131000, 131016, 133004, 133016]);

const TOKEN_HINT =
  'Create a permanent token for a System User in Meta Business Settings, with the ' +
  'whatsapp_business_messaging and whatsapp_business_management permissions, and save it in ' +
  'Settings → Channels → WhatsApp.';

/** Known error codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes */
const BY_CODE: Record<number, string> = {
  33: 'Meta cannot find the phone number ID or WhatsApp Business account ID, or the access token does not own it. Copy the IDs from Meta → WhatsApp → API setup.',
  368: 'Meta has temporarily blocked this account for a policy violation. See Meta Business Manager → Account quality.',
  130472: "Meta did not deliver this message: the customer's number is part of a Meta experiment.",
  130497: 'Meta does not allow this business to message customers in that country.',
  131005: 'Meta denied access: the access token cannot use this phone number.',
  131008: 'Meta rejected the message: a required field is missing.',
  131009: 'Meta rejected the message: a field has a value it does not accept.',
  131021: "The message was addressed to the business's own number.",
  131026:
    'WhatsApp could not deliver the message. The number may not be on WhatsApp, or the customer has not accepted the latest WhatsApp terms.',
  131030:
    "The customer's number is not on the allowed list of Meta's test number. Add it in Meta → WhatsApp → API setup.",
  131031: 'Meta has restricted or locked this WhatsApp Business account. See Account quality.',
  131042: 'Meta blocked the message because of a payment problem on the WhatsApp Business account.',
  131045: 'The phone number is not registered with the WhatsApp Cloud API.',
  131047:
    "More than 24 hours have passed since the customer's last message. Send an approved template to restart the conversation.",
  131049:
    'Meta chose not to deliver this message, to limit how many marketing messages the customer gets. Try again later.',
  131050: 'The customer has stopped marketing messages from this business.',
  131051: 'WhatsApp does not support this kind of message.',
  131052: 'Meta could not download the media the customer sent.',
  131053: 'Meta could not upload the media in this message.',
  132000: 'The number of values does not match the number of variables in the template.',
  132001: 'The template does not exist in that language, or Meta has not approved it.',
  132005: 'The template text is too long once its variables are filled in.',
  132007: 'Meta rejected the template text for breaking its content policy.',
  132012: 'A template variable has the wrong format.',
  132015: 'Meta paused this template because of low quality. Pick another one.',
  132016: 'Meta disabled this template because of low quality. Pick another one.',
  133010: 'The phone number is not registered with the WhatsApp Cloud API.',
};

function isMetaErrorLike(err: unknown): err is MetaErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string' &&
    ('code' in err || 'fbtraceId' in err || 'httpStatus' in err)
  );
}

/**
 * Explains an error from talking to Meta. Anything that isn't Meta's error
 * envelope (a timeout, DNS, a dropped connection) counts as retryable.
 */
export function explainMetaError(err: unknown): MetaErrorExplanation {
  if (!isMetaErrorLike(err)) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      summary: `Could not reach the Meta Graph API: ${message}`,
      retryable: true,
      code: null,
    };
  }

  const code = err.code ?? null;
  const subcode = err.subcode ?? null;
  const metaMessage = err.details ? `${err.message} (${err.details})` : err.message;
  const fixed = (summary: string): MetaErrorExplanation => ({ summary, retryable: false, code });

  if (code === 190 || (code === null && err.type === 'OAuthException')) {
    const why =
      subcode === 463
        ? 'The WhatsApp access token has expired.'
        : subcode === 460 || subcode === 467
          ? 'The WhatsApp access token has been invalidated.'
          : 'Meta rejected the WhatsApp access token.';
    return fixed(`${why} Temporary tokens last 24 hours. ${TOKEN_HINT}`);
  }

  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return fixed(`The WhatsApp access token is not allowed to do this. ${TOKEN_HINT}`);
  }

  if (code !== null && RATE_LIMIT_CODES.has(code)) {
    return { summary: 'Meta is rate-limiting this WhatsApp account.', retryable: true, code };
  }
  if (code !== null && TEMPORARY_CODES.has(code)) {
    return { summary: `Meta had a temporary problem (code ${code}).`, retryable: true, code };
  }

  if (code !== null && BY_CODE[code]) return fixed(BY_CODE[code]);

  if (code === 100) {
    if (subcode === 33 || /unsupported (get|post) request|does not exist/i.test(err.message)) {
      return fixed(BY_CODE[33]!);
    }
    return fixed(`Meta rejected a value in the request: ${metaMessage}`);
  }

  const trace = err.fbtraceId ? ` Trace id ${err.fbtraceId}.` : '';
  const codeText = code !== null ? ` (code ${code}${subcode !== null ? `/${subcode}` : ''})` : '';
  return {
    summary: `Meta returned an error${codeText}: ${metaMessage}.${trace}`,
    // Without a code we only have the HTTP status to go on.
    retryable: code === null && (err.httpStatus ?? 0) >= 500,
    code,
  };
}

/** One entry of a failed status's `errors` array, as Meta sends it. */
export interface MetaStatusError {
  code: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

/** Why a message that Meta accepted was not delivered. */
export function explainStatusError(error: MetaStatusError | undefined): string {
  if (!error) return 'WhatsApp could not deliver the message.';
  return explainMetaError({
    message: error.title ?? error.message ?? 'Delivery failed',
    code: error.code,
    details: error.error_data?.details ?? null,
  }).summary;
}
