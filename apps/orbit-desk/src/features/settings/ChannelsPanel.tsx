import {
  type ChannelHealth,
  type ChannelKind,
  type ChannelSettingsView,
  type ConnectionTestResult,
  PHONE_PROVIDER_NAMES,
  VOICE_DEFAULT_GREETING,
} from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import {
  Button,
  Card,
  CardHeader,
  Input,
  Select,
  StatusLight,
  Textarea,
} from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { WhatsAppConnect } from '../whatsapp/WhatsAppConnect';
import { WhatsAppSetup } from '../whatsapp/WhatsAppSetup';
import {
  cardId,
  HealthBanner,
  HealthCard,
  HealthChecks,
  HealthOverview,
  useChannelHealth,
} from './ChannelHealth';
import { maskedKey } from './logic';
import styles from './Settings.module.css';
import { TestResult } from './TestResult';

type FieldKind = 'text' | 'number' | 'bool' | 'email' | 'longtext' | 'select';
interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  optional?: boolean;
  /** For `select`. */
  options?: Array<{ value: string; label: string }>;
}

const CHANNELS: Record<
  ChannelKind,
  { title: string; subtitle: string; fields: Field[]; defaults: Record<string, unknown> }
> = {
  email: {
    title: 'Email',
    subtitle: 'The support mailbox: read over IMAP, answered over SMTP.',
    fields: [
      { name: 'enabled', label: 'Email channel on', kind: 'bool' },
      { name: 'address', label: 'Support address', kind: 'email' },
      { name: 'fromName', label: 'Sender name', kind: 'text' },
      { name: 'imapHost', label: 'IMAP host', kind: 'text' },
      { name: 'imapPort', label: 'IMAP port', kind: 'number' },
      { name: 'imapSecure', label: 'IMAP over TLS', kind: 'bool' },
      { name: 'imapUser', label: 'IMAP user', kind: 'text' },
      { name: 'imapMailbox', label: 'Mailbox', kind: 'text' },
      { name: 'smtpHost', label: 'SMTP host', kind: 'text' },
      { name: 'smtpPort', label: 'SMTP port', kind: 'number' },
      { name: 'smtpSecure', label: 'SMTP over TLS', kind: 'bool' },
      { name: 'smtpUser', label: 'SMTP user', kind: 'text', optional: true },
      { name: 'pollSeconds', label: 'Fallback poll (seconds)', kind: 'number' },
    ],
    defaults: {
      enabled: true,
      imapPort: 993,
      imapSecure: true,
      imapMailbox: 'INBOX',
      smtpPort: 587,
      smtpSecure: false,
      pollSeconds: 60,
      fromName: 'Support',
    },
  },
  whatsapp: {
    title: 'WhatsApp',
    subtitle:
      'Meta WhatsApp Cloud API: customers write to your business number, and replies go out from here.',
    fields: [
      { name: 'enabled', label: 'WhatsApp channel on', kind: 'bool' },
      {
        name: 'phoneNumberId',
        label: 'Phone number ID',
        kind: 'text',
        placeholder: 'From Meta › WhatsApp › API setup',
      },
      { name: 'wabaId', label: 'WhatsApp Business account ID', kind: 'text', optional: true },
      { name: 'graphVersion', label: 'Graph API version', kind: 'text', placeholder: 'v23.0' },
    ],
    defaults: { enabled: false, graphVersion: 'v23.0' },
  },
  sarvam: {
    title: 'Sarvam voice',
    subtitle:
      'Voice calls in the browser: Sarvam turns speech into text and text into speech, in 11 languages. Calls use Sarvam credits.',
    fields: [
      { name: 'enabled', label: 'Voice on', kind: 'bool' },
      { name: 'defaultSpeaker', label: 'Voice', kind: 'text' },
      { name: 'sttModel', label: 'Speech-to-text model', kind: 'text' },
      { name: 'ttsModel', label: 'Text-to-speech model', kind: 'text' },
      { name: 'greeting', label: 'Greeting (must say the call is recorded)', kind: 'longtext' },
      { name: 'maxCallMinutes', label: 'Longest call (minutes)', kind: 'number' },
      { name: 'recordCalls', label: 'Record calls (kept 30 days)', kind: 'bool' },
    ],
    defaults: {
      enabled: true,
      sttModel: 'saaras:v4',
      ttsModel: 'bulbul:v3',
      defaultSpeaker: 'shubh',
      greeting: VOICE_DEFAULT_GREETING,
      maxCallMinutes: 10,
      recordCalls: true,
    },
  },
  phone: {
    title: 'Phone calls: Sarvam',
    subtitle:
      'Calls on a number rented from Sarvam, answered by a Sarvam Voice Agent that uses this desk’s knowledge and tools. Calls use your Sarvam wallet.',
    fields: [
      { name: 'enabled', label: 'Phone calls on', kind: 'bool' },
      { name: 'agentPhoneNumber', label: 'Rented number', kind: 'text', placeholder: '+9180…' },
      { name: 'orgId', label: 'Sarvam org ID', kind: 'text' },
      { name: 'workspaceId', label: 'Sarvam workspace ID', kind: 'text' },
      { name: 'appId', label: 'Agent (app) ID', kind: 'text' },
      { name: 'appVersion', label: 'Agent version', kind: 'number' },
      { name: 'connectionId', label: 'Connection ID', kind: 'text' },
    ],
    defaults: { enabled: true, appVersion: 1 },
  },
  calls: {
    title: 'Phone calls: general',
    subtitle: 'What holds for phone calls whichever voice agent takes them.',
    fields: [
      {
        name: 'outboundProvider',
        label: 'Calls this desk starts are placed by',
        kind: 'select',
        options: Object.entries(PHONE_PROVIDER_NAMES).map(([value, label]) => ({ value, label })),
      },
      { name: 'callingHours', label: 'Outbound calls only 09:00–21:00 IST', kind: 'bool' },
      {
        name: 'linkTemplate',
        label: 'WhatsApp template for links',
        kind: 'text',
        placeholder: 'Template name; its body has one variable, the link',
        optional: true,
      },
    ],
    defaults: { outboundProvider: 'sarvam', callingHours: false },
  },
};

/** The token the phone agent sends with every request: made here, shown once, saved write-only. */
function newHookToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Where Sarvam's agent reaches this desk; pasted into its tools, start hook and webhook. */
function PhoneAddresses() {
  const base = `${window.location.origin}/api/v1/phone/sarvam`;
  const rows = [
    ['On-start hook', `${base}/start`],
    ['Tools', `${base}/tools/<name>`],
    ['Webhook (call ended)', `${base}/ended`],
  ] as const;
  return (
    <div>
      <p className={styles.note}>
        Paste these into the agent in Sarvam’s dashboard. The hook and the tools send the hook token
        as a bearer token.
      </p>
      {rows.map(([label, url]) => (
        <p key={label} className={styles.note}>
          {label}: <span className={styles.mono}>{url}</span>
        </p>
      ))}
    </div>
  );
}

export function ChannelsPanel() {
  const channels = useGet<ChannelSettingsView[]>('/settings/channels');
  const health = useChannelHealth();
  const light = (channel: ChannelHealth['channel']) =>
    health.data?.find((h) => h.channel === channel);
  const view = (kind: ChannelKind) => channels.data?.find((v) => v.kind === kind);
  const changed = () => {
    void channels.reload();
    void health.refresh();
  };
  const email = view('email');
  const whatsapp = view('whatsapp');
  const sarvam = view('sarvam');
  const phone = view('phone');
  const calls = view('calls');
  const webchat = light('webchat');
  const webForm = light('web_form');

  return (
    <div className={styles.stack}>
      {channels.error && <p className={styles.error}>{channels.error}</p>}
      {health.error && <p className={styles.error}>{health.error}</p>}
      {health.data && (
        <HealthOverview
          health={health.data}
          checking={health.checking}
          onCheck={() => void health.check()}
        />
      )}
      {email && <ChannelCard view={email} health={light('email')} onChanged={changed} />}
      {whatsapp && <ChannelCard view={whatsapp} health={light('whatsapp')} onChanged={changed} />}
      {webchat && (
        <HealthCard
          health={webchat}
          subtitle="The chat widget on your website. There is nothing to connect: it works whenever the API and the worker run."
        />
      )}
      {webForm && (
        <HealthCard
          health={webForm}
          subtitle="The “Submit a request” page. Acknowledgements and replies go out through the email channel."
        />
      )}
      {sarvam && <ChannelCard view={sarvam} health={light('voice')} onChanged={changed} />}
      {/* The Voice light is shown once, on the card above: it covers phone calls too. */}
      {phone && <ChannelCard view={phone} health={undefined} onChanged={changed} />}
      {calls && <ChannelCard view={calls} health={undefined} onChanged={changed} />}
    </div>
  );
}

function ChannelCard({
  view,
  health,
  onChanged,
}: {
  view: ChannelSettingsView;
  health: ChannelHealth | undefined;
  onChanged: () => void;
}) {
  const def = CHANNELS[view.kind];

  return (
    <Card
      padding="md"
      id={health ? cardId(health.channel) : undefined}
      aria-labelledby={`channel-${view.kind}`}
    >
      <CardHeader
        id={`channel-${view.kind}`}
        title={def.title}
        subtitle={def.subtitle}
        actions={
          health ? (
            <StatusLight state={health.state} />
          ) : view.kind === 'calls' ? undefined : (
            <TestResult result={view.lastTest} />
          )
        }
      />
      {view.kind === 'whatsapp' ? (
        <>
          {health && <HealthBanner health={health} />}
          {health && <HealthChecks health={health} />}
          <WhatsAppConnect view={view} onChanged={onChanged} />
          <WhatsAppSetup />
        </>
      ) : (
        <>
          {health && <HealthChecks health={health} />}
          <ChannelForm view={view} onChanged={onChanged} />
        </>
      )}
    </Card>
  );
}

/** The generic settings form and its keys (email, Sarvam). */
function ChannelForm({ view, onChanged }: { view: ChannelSettingsView; onChanged: () => void }) {
  const def = CHANNELS[view.kind];
  const { can } = useSession();
  const [values, setValues] = useState<Record<string, unknown>>({
    ...def.defaults,
    ...(view.config ?? {}),
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setValues({ ...def.defaults, ...(view.config ?? {}) }), [view, def.defaults]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    const body = Object.fromEntries(
      def.fields.map((f) => {
        const v = values[f.name];
        if (f.kind === 'number') return [f.name, Number(v)];
        if (f.kind === 'bool') return [f.name, !!v];
        const s = typeof v === 'string' ? v.trim() : v;
        return [f.name, f.optional && !s ? null : s];
      }),
    );
    try {
      await api('PUT', `/settings/channels/${view.kind}`, body);
      setMessage('Saved.');
      onChanged();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const r = await api<ConnectionTestResult>('POST', `/settings/channels/${view.kind}/test`);
      setMessage(r.ok ? (r.detail ?? 'Connected.') : `Test failed: ${r.error}`);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setTesting(false);
      onChanged();
    }
  };

  // The general card has nothing to connect to: no test, no keys, and its values are in
  // force before it is ever saved.
  const plain = view.kind === 'calls';
  const sourceNote = plain
    ? null
    : view.source === 'environment'
      ? 'Currently read from environment variables. Saving here overrides them.'
      : view.source === 'none'
        ? 'Not configured yet.'
        : null;

  return (
    <div className={styles.grid2}>
      <form className={styles.form} onSubmit={save} aria-label={`${def.title} settings`}>
        {sourceNote && <p className={styles.note}>{sourceNote}</p>}
        <div className={styles.formRow}>
          {def.fields.map((f) =>
            f.kind === 'bool' ? (
              <Select
                key={f.name}
                id={`${view.kind}-${f.name}`}
                label={f.label}
                value={values[f.name] ? 'yes' : 'no'}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value === 'yes' })}
                options={[
                  { value: 'yes', label: 'Yes' },
                  { value: 'no', label: 'No' },
                ]}
              />
            ) : f.kind === 'select' ? (
              <Select
                key={f.name}
                id={`${view.kind}-${f.name}`}
                label={f.label}
                value={typeof values[f.name] === 'string' ? (values[f.name] as string) : ''}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                options={f.options ?? []}
              />
            ) : f.kind === 'longtext' ? (
              <div key={f.name} className={styles.wide}>
                <Textarea
                  id={`${view.kind}-${f.name}`}
                  label={f.label}
                  rows={2}
                  value={typeof values[f.name] === 'string' ? (values[f.name] as string) : ''}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  required={!f.optional}
                />
              </div>
            ) : (
              <Input
                key={f.name}
                id={`${view.kind}-${f.name}`}
                label={f.label}
                type={f.kind === 'number' ? 'number' : f.kind === 'email' ? 'email' : 'text'}
                placeholder={f.placeholder}
                value={
                  values[f.name] === null || values[f.name] === undefined
                    ? ''
                    : String(values[f.name])
                }
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                required={!f.optional}
              />
            ),
          )}
        </div>
        <div className={styles.formActions}>
          {!plain && (
            <Button onClick={test} disabled={testing}>
              Test connection
            </Button>
          )}
          <Button type="submit" disabled={saving}>
            Save settings
          </Button>
        </div>
        {message && (
          <p className={styles.note} role="status">
            {message}
          </p>
        )}
      </form>
      {!plain && (
        <div className={styles.form}>
          <p className={styles.note}>
            Credentials are encrypted and write-only: only the last four characters show.
          </p>
          {view.secrets.map((s) => (
            <SecretField
              key={s.key}
              secret={s}
              canEdit={can('settings:secrets')}
              onChanged={onChanged}
              generate={s.key === 'phone.hook_token' ? newHookToken : undefined}
            />
          ))}
          {view.kind === 'phone' && <PhoneAddresses />}
        </div>
      )}
    </div>
  );
}

export function SecretField({
  secret,
  canEdit,
  onChanged,
  generate,
}: {
  secret: ChannelSettingsView['secrets'][number];
  canEdit: boolean;
  onChanged: () => void;
  /** For a secret we make up ourselves: fills the field, shown in clear so it can be copied. */
  generate?: () => string;
}) {
  const [value, setValue] = useState('');
  const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('PUT', `/settings/secrets/${secret.key}`, { value });
      setValue('');
      setGenerated(false);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete the ${secret.label.toLowerCase()}?`)) return;
    setBusy(true);
    await api('DELETE', `/settings/secrets/${secret.key}`).catch((err: Error) =>
      setError(err.message),
    );
    setBusy(false);
    onChanged();
  };

  const id = `secret-${secret.key.replace(/\W/g, '-')}`;
  return (
    <div>
      <div className={styles.secretRow}>
        <Input
          id={id}
          label={secret.label}
          type={generated ? 'text' : 'password'}
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          disabled={!canEdit}
          placeholder={secret.set ? 'Enter a new value to rotate' : 'Not set'}
          onChange={(e) => {
            setValue(e.target.value);
            setGenerated(false);
          }}
          hint={
            <span className={styles.keyState}>Stored: {maskedKey(secret.last4, secret.set)}</span>
          }
        />
        {canEdit && (
          <div className={styles.actions}>
            {generate && (
              <Button
                variant="ghost"
                onClick={() => {
                  setValue(generate());
                  setGenerated(true);
                }}
                disabled={busy}
              >
                Generate
              </Button>
            )}
            <Button onClick={save} disabled={!value || busy}>
              {secret.set ? 'Rotate' : 'Save'}
            </Button>
            {secret.set && (
              <Button variant="ghost" onClick={remove} disabled={busy}>
                Delete
              </Button>
            )}
          </div>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
