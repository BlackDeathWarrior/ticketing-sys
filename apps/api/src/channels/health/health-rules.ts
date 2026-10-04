import {
  type ChannelActivity,
  type ChannelHealth,
  HEALTH_CHANNEL_LABELS,
  type HealthChannel,
  type HealthCheck,
  type HealthState,
  worstState,
} from '@tms/shared';
import type { PollerSignal, ProbeResult } from '../../settings/channel-signals.service';

/**
 * Turns what we know about a channel into a status light and a list of
 * checks. Pure, so every rule can be tested without a mailbox or Meta.
 */

export const NO_ACTIVITY: ChannelActivity = {
  lastInboundAt: null,
  lastOutboundAt: null,
  failed24h: 0,
  lastFailure: null,
};

/** A poller signal older than this means the mailbox reader has gone quiet. */
const POLLER_STALE_MS = 90_000;

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function workerCheck(up: boolean): HealthCheck {
  return {
    key: 'worker',
    label: 'Background worker',
    state: up ? 'ok' : 'down',
    detail: up ? 'Running' : 'Not running. Nothing is received or sent until it is back.',
  };
}

function deliveriesCheck(activity: ChannelActivity, noun: string): HealthCheck {
  if (activity.failed24h === 0) {
    return {
      key: 'deliveries',
      label: 'Deliveries',
      state: 'ok',
      detail: 'Nothing failed in the last 24 hours',
    };
  }
  const n = activity.failed24h;
  return {
    key: 'deliveries',
    label: 'Deliveries',
    state: 'warning',
    detail:
      `${n} ${noun}${n === 1 ? '' : 's'} could not be delivered in the last 24 hours.` +
      (activity.lastFailure ? ` Latest: ${activity.lastFailure.reason}` : ''),
  };
}

function build(
  channel: HealthChannel,
  checks: HealthCheck[],
  activity: ChannelActivity,
  okSummary: string,
  checkedAt: string | null = null,
): ChannelHealth {
  const state = worstState(checks.map((c) => c.state));
  const worst = checks.find((c) => c.state === state);
  return {
    channel,
    label: HEALTH_CHANNEL_LABELS[channel],
    state,
    summary: state === 'ok' ? okSummary : (worst?.detail ?? ''),
    checks,
    activity,
    checkedAt,
  };
}

function off(
  channel: HealthChannel,
  summary: string,
  checks: HealthCheck[] = [],
  activity = NO_ACTIVITY,
): ChannelHealth {
  return {
    channel,
    label: HEALTH_CHANNEL_LABELS[channel],
    state: 'off',
    summary,
    checks,
    activity,
    checkedAt: null,
  };
}

// ---- Email ----

export interface EmailFacts {
  config: { enabled: boolean; address: string } | null;
  poller?: PollerSignal;
  probe?: ProbeResult;
  workerUp: boolean;
  /** Email and help-center mail go out through the same SMTP server. */
  activity: ChannelActivity;
  now: Date;
}

export function emailHealth(f: EmailFacts): ChannelHealth {
  if (!f.config) return off('email', 'Not set up');
  if (!f.config.enabled) return off('email', 'Switched off', [], f.activity);

  const imapProblem = f.probe?.facts?.imap;
  const pollerFresh =
    !!f.poller && f.now.getTime() - Date.parse(f.poller.at) < POLLER_STALE_MS ? f.poller : null;
  let reading: HealthCheck;
  if (typeof imapProblem === 'string' && imapProblem !== 'ok') {
    reading = { key: 'imap', label: 'Reading the mailbox', state: 'down', detail: imapProblem };
  } else if (pollerFresh?.state === 'watching') {
    reading = {
      key: 'imap',
      label: 'Reading the mailbox',
      state: 'ok',
      detail: `Watching ${f.config.address} for new mail`,
    };
  } else if (pollerFresh?.state === 'error') {
    reading = {
      key: 'imap',
      label: 'Reading the mailbox',
      state: 'down',
      detail: pollerFresh.detail ?? 'The mailbox connection failed',
    };
  } else {
    reading = {
      key: 'imap',
      label: 'Reading the mailbox',
      state: f.workerUp ? 'warning' : 'down',
      detail: f.workerUp
        ? 'The mailbox reader has not connected yet'
        : 'Waiting for the background worker',
    };
  }

  const smtp = f.probe?.facts?.smtp;
  const sending: HealthCheck = !f.probe
    ? {
        key: 'smtp',
        label: 'Sending email',
        state: 'warning',
        detail: 'Not checked yet. Click Check now.',
      }
    : smtp === 'ok'
      ? {
          key: 'smtp',
          label: 'Sending email',
          state: 'ok',
          detail: 'The mail server accepts our login',
        }
      : {
          key: 'smtp',
          label: 'Sending email',
          state: 'down',
          detail: typeof smtp === 'string' ? smtp : (f.probe.error ?? 'The mail server refused us'),
        };

  return build(
    'email',
    [workerCheck(f.workerUp), reading, sending, deliveriesCheck(f.activity, 'email')],
    f.activity,
    `Reading and sending as ${f.config.address}`,
    f.probe?.at ?? null,
  );
}

// ---- WhatsApp ----

export interface WhatsappFacts {
  config: { enabled: boolean; phoneNumberId: string; wabaId: string | null } | null;
  secrets: { accessToken: boolean; appSecret: boolean; verifyToken: boolean };
  probe?: ProbeResult;
  webhookAt?: string;
  handshakeAt?: string;
  workerUp: boolean;
  activity: ChannelActivity;
  now: Date;
}

export function whatsappHealth(f: WhatsappFacts): ChannelHealth {
  if (!f.config) return off('whatsapp', 'Not connected yet');
  if (!f.config.enabled) return off('whatsapp', 'Switched off', [], f.activity);

  const checks: HealthCheck[] = [workerCheck(f.workerUp)];
  const facts = f.probe?.facts ?? {};
  const number = [facts.displayPhoneNumber, facts.verifiedName ? `(${facts.verifiedName})` : null]
    .filter(Boolean)
    .join(' ');

  if (!f.secrets.accessToken) {
    checks.push({
      key: 'token',
      label: 'Access token',
      state: 'down',
      detail: 'Not saved. Messages cannot be sent.',
    });
  } else if (!f.probe) {
    checks.push({
      key: 'meta',
      label: 'Connection to Meta',
      state: 'warning',
      detail: 'Not checked yet. Click Check now.',
    });
  } else if (!f.probe.ok) {
    checks.push({
      key: 'meta',
      label: 'Connection to Meta',
      state: 'down',
      detail: f.probe.error ?? 'Meta refused the connection',
    });
  } else {
    checks.push({
      key: 'meta',
      label: 'Connection to Meta',
      state: 'ok',
      detail: number ? `Meta accepts the token for ${number}` : 'Meta accepts the token',
    });
    const quality = typeof facts.quality === 'string' ? facts.quality.toUpperCase() : null;
    if (quality && quality !== 'UNKNOWN') {
      checks.push({
        key: 'quality',
        label: 'Number quality',
        state: quality === 'GREEN' ? 'ok' : 'warning',
        detail:
          quality === 'GREEN'
            ? 'Green'
            : quality === 'YELLOW'
              ? 'Yellow: customers are blocking or reporting messages from this number'
              : 'Red: Meta may limit how many messages this number can send',
      });
    }
    if (facts.subscribed === false) {
      checks.push({
        key: 'subscription',
        label: 'Webhook subscription',
        state: 'down',
        detail:
          "Meta is not sending this account's messages to any app. Click Subscribe to webhooks.",
      });
    } else if (facts.subscribed === true) {
      checks.push({
        key: 'subscription',
        label: 'Webhook subscription',
        state: 'ok',
        detail: "Meta sends this account's messages to your app",
      });
    }
  }

  checks.push(
    !f.secrets.appSecret
      ? {
          key: 'security',
          label: 'Webhook security',
          state: 'down',
          detail: 'Incoming messages are refused until the app secret is saved',
        }
      : !f.secrets.verifyToken
        ? {
            key: 'security',
            label: 'Webhook security',
            state: 'warning',
            detail: 'Meta cannot verify the webhook address until a verify token is saved',
          }
        : {
            key: 'security',
            label: 'Webhook security',
            state: 'ok',
            detail: 'App secret and verify token are saved',
          },
  );

  const heard = f.webhookAt ?? f.activity.lastInboundAt;
  checks.push(
    heard
      ? {
          key: 'webhook',
          label: 'Messages from Meta',
          state: 'ok',
          detail: `Meta last called the webhook ${ago(heard, f.now)}`,
        }
      : f.handshakeAt
        ? {
            key: 'webhook',
            label: 'Messages from Meta',
            state: 'ok',
            detail: `Meta verified the webhook address ${ago(f.handshakeAt, f.now)}. No message has arrived yet.`,
          }
        : {
            key: 'webhook',
            label: 'Messages from Meta',
            state: 'warning',
            detail:
              'Meta has not called the webhook yet. Paste the webhook address and verify token into Meta → WhatsApp → Configuration.',
          },
  );
  checks.push(deliveriesCheck(f.activity, 'message'));

  return build(
    'whatsapp',
    checks,
    f.activity,
    number ? `Connected to ${number}` : 'Connected',
    f.probe?.at ?? null,
  );
}

// ---- Web chat, help-center form, voice ----

export function webchatHealth(f: {
  workerUp: boolean;
  visitors: number | null;
  activity: ChannelActivity;
}): ChannelHealth {
  const visitors =
    f.visitors === null
      ? ''
      : f.visitors === 1
        ? ', 1 visitor connected now'
        : `, ${f.visitors} visitors connected now`;
  return build(
    'webchat',
    [
      workerCheck(f.workerUp),
      {
        key: 'server',
        label: 'Chat server',
        state: 'ok',
        detail: `Accepting chats${visitors}`,
      },
      deliveriesCheck(f.activity, 'reply'),
    ],
    f.activity,
    `Accepting chats${visitors}`,
  );
}

export function webFormHealth(f: {
  workerUp: boolean;
  email: HealthState;
  activity: ChannelActivity;
}): ChannelHealth {
  const mail: HealthCheck =
    f.email === 'ok'
      ? {
          key: 'email',
          label: 'Acknowledgements and replies',
          state: 'ok',
          detail: 'Sent through the email channel',
        }
      : f.email === 'warning'
        ? {
            key: 'email',
            label: 'Acknowledgements and replies',
            state: 'warning',
            detail: 'They go out by email, and the email channel needs attention',
          }
        : {
            key: 'email',
            label: 'Acknowledgements and replies',
            state: f.email === 'down' ? 'down' : 'warning',
            detail:
              f.email === 'down'
                ? 'Email is not working, so customers get no acknowledgement and agents cannot reply'
                : 'Email is off, so customers get no acknowledgement and agents cannot reply',
          };
  return build(
    'web_form',
    [
      workerCheck(f.workerUp),
      { key: 'form', label: 'Request form', state: 'ok', detail: 'Open to customers at /help/' },
      mail,
    ],
    f.activity,
    'Open to customers',
  );
}

export interface VoiceFacts {
  /** Null when voice was never set up; calls need it switched on and a key. */
  enabled: boolean | null;
  keySaved: boolean;
  /** The last "Test connection": the check is a paid call, so it never runs by itself. */
  probe?: ProbeResult;
  /** Calls in progress on this server, and how many it takes at once. */
  lines: { active: number; max: number } | null;
  /** Phone calls through Sarvam's Voice Agent (ADR 0039); null when never set up. */
  phone?: {
    enabled: boolean;
    keySaved: boolean;
    tokenSaved: boolean;
    probe?: ProbeResult;
    /** The last time Sarvam's agent reached one of our hooks. */
    lastHookAt: string | null;
  } | null;
  /** Phone calls through an ElevenLabs agent (ADR 0040); null when never set up. */
  elevenlabs?: {
    enabled: boolean;
    keySaved: boolean;
    probe?: ProbeResult;
    /** Made and saved by the desk when it sets the agent up. */
    tokenSaved: boolean;
    webhookSecretSaved: boolean;
    numberChosen: boolean;
    /** How the last set-up of the agent went; `at` null when it never ran. */
    sync: { at: string | null; ok: boolean | null; error: string | null; skipped: number };
    lastHookAt: string | null;
  } | null;
  activity: ChannelActivity;
}

export function voiceHealth(f: VoiceFacts): ChannelHealth {
  const phone = f.phone?.enabled ? f.phone : null;
  const elevenlabs = f.elevenlabs?.enabled ? f.elevenlabs : null;
  const browserOff = (f.enabled === null && !f.keySaved) || f.enabled === false;
  if (browserOff && !phone && !elevenlabs) {
    return f.enabled === false
      ? off('voice', 'Switched off', [], f.activity)
      : off('voice', 'Not set up');
  }

  const checks: HealthCheck[] = [];
  if (browserOff) {
    // Phone calls alone: nothing about calls in the browser is wrong.
  } else if (!f.keySaved) {
    checks.push({
      key: 'key',
      label: 'Sarvam key',
      state: 'down',
      detail: 'Not saved. Calls cannot start.',
    });
  } else if (!f.probe) {
    checks.push({
      key: 'sarvam',
      label: 'Connection to Sarvam',
      state: 'warning',
      detail: 'Not checked yet. Click Test connection.',
    });
  } else {
    checks.push({
      key: 'sarvam',
      label: 'Connection to Sarvam',
      state: f.probe.ok ? 'ok' : 'down',
      detail: f.probe.ok
        ? 'Sarvam accepts the key'
        : (f.probe.error ?? 'Sarvam refused the connection'),
    });
  }
  if (phone) checks.push(...phoneChecks(phone));
  if (elevenlabs) checks.push(...elevenlabsChecks(elevenlabs));
  if (f.lines && !browserOff) {
    const busy = f.lines.active >= f.lines.max;
    checks.push({
      key: 'lines',
      label: 'Lines',
      state: busy ? 'warning' : 'ok',
      detail: busy
        ? `All ${f.lines.max} lines are in use: new callers are asked to try again`
        : `${f.lines.active} of ${f.lines.max} in use`,
    });
  }
  return build('voice', checks, f.activity, 'Ready for calls', f.probe?.at ?? null);
}

function phoneChecks(p: NonNullable<VoiceFacts['phone']>): HealthCheck[] {
  const checks: HealthCheck[] = [];
  if (!p.keySaved) {
    checks.push({
      key: 'phone_key',
      label: 'Phone: Sarvam key',
      state: 'down',
      detail: 'Not saved. Tickets cannot be written after a call.',
    });
  } else if (!p.probe) {
    checks.push({
      key: 'phone_sarvam',
      label: 'Phone: connection to Sarvam',
      state: 'warning',
      detail: 'Not checked yet. Click Test connection.',
    });
  } else {
    checks.push({
      key: 'phone_sarvam',
      label: 'Phone: connection to Sarvam',
      state: p.probe.ok ? 'ok' : 'down',
      detail: p.probe.ok
        ? (p.probe.detail ?? 'Sarvam accepts the key')
        : (p.probe.error ?? 'Sarvam refused the connection'),
    });
  }
  checks.push(
    p.tokenSaved
      ? {
          key: 'phone_hooks',
          label: 'Phone: calls from the phone agent',
          state: p.lastHookAt ? 'ok' : 'warning',
          detail: p.lastHookAt
            ? 'The phone agent reaches the desk'
            : 'No call has reached the desk yet',
        }
      : {
          key: 'phone_hooks',
          label: 'Phone: hook token',
          state: 'down',
          detail: 'Not saved. The phone agent is refused.',
        },
  );
  return checks;
}

function elevenlabsChecks(e: NonNullable<VoiceFacts['elevenlabs']>): HealthCheck[] {
  const checks: HealthCheck[] = [];
  if (!e.keySaved) {
    return [
      {
        key: 'elevenlabs_key',
        label: 'ElevenLabs: API key',
        state: 'down',
        detail: 'Not saved. The agent cannot be set up and calls cannot be written to tickets.',
      },
    ];
  }
  checks.push(
    e.probe
      ? {
          key: 'elevenlabs_api',
          label: 'ElevenLabs: connection',
          state: e.probe.ok ? 'ok' : 'down',
          detail: e.probe.ok
            ? (e.probe.detail ?? 'ElevenLabs accepts the key')
            : (e.probe.error ?? 'ElevenLabs refused the connection'),
        }
      : {
          key: 'elevenlabs_api',
          label: 'ElevenLabs: connection',
          state: 'warning',
          detail: 'Not checked yet. Click Test connection.',
        },
  );
  if (!e.sync.at || !e.tokenSaved || !e.webhookSecretSaved) {
    checks.push({
      key: 'elevenlabs_sync',
      label: 'ElevenLabs: agent',
      state: e.sync.ok === false ? 'down' : 'warning',
      detail:
        e.sync.ok === false
          ? (e.sync.error ?? 'The set-up failed')
          : 'Not set up yet. Click Set up.',
    });
    return checks;
  }
  checks.push({
    key: 'elevenlabs_sync',
    label: 'ElevenLabs: agent',
    state: e.sync.ok === false ? 'down' : e.sync.skipped ? 'warning' : 'ok',
    detail:
      e.sync.ok === false
        ? (e.sync.error ?? 'The last sync failed')
        : e.sync.skipped
          ? `In step, but ElevenLabs refused ${e.sync.skipped} tool${e.sync.skipped === 1 ? '' : 's'}`
          : 'In step with this desk',
  });
  checks.push({
    key: 'elevenlabs_number',
    label: 'ElevenLabs: number',
    state: e.numberChosen ? 'ok' : 'warning',
    detail: e.numberChosen ? 'A number is assigned to the agent' : 'No number yet: test calls only',
  });
  checks.push({
    key: 'elevenlabs_hooks',
    label: 'ElevenLabs: calls from the agent',
    state: e.lastHookAt ? 'ok' : 'warning',
    detail: e.lastHookAt ? 'The agent reaches the desk' : 'No call has reached the desk yet',
  });
  return checks;
}

/** Adds up activity across channels that share one way out (email and the help-center form). */
export function mergeActivity(...parts: Array<ChannelActivity | undefined>): ChannelActivity {
  const present = parts.filter((p): p is ChannelActivity => !!p);
  const latest = (values: Array<string | null>) =>
    values
      .filter((v): v is string => !!v)
      .sort()
      .at(-1) ?? null;
  return {
    lastInboundAt: latest(present.map((p) => p.lastInboundAt)),
    lastOutboundAt: latest(present.map((p) => p.lastOutboundAt)),
    failed24h: present.reduce((sum, p) => sum + p.failed24h, 0),
    lastFailure:
      present
        .map((p) => p.lastFailure)
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1) ?? null,
  };
}
