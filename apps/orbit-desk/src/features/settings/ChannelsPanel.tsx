import type { ChannelKind, ChannelSettingsView, ConnectionTestResult } from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Input, Select } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { WhatsAppSetup } from '../whatsapp/WhatsAppSetup';
import { maskedKey } from './logic';
import styles from './Settings.module.css';
import { TestResult } from './TestResult';

type FieldKind = 'text' | 'number' | 'bool' | 'email';
interface Field {
  name: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  optional?: boolean;
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
      'Speech-to-text and text-to-speech for the voice agent (Phase 9), and language detection.',
    fields: [
      { name: 'enabled', label: 'Voice on', kind: 'bool' },
      { name: 'sttModel', label: 'Speech-to-text model', kind: 'text' },
      { name: 'ttsModel', label: 'Text-to-speech model', kind: 'text' },
      { name: 'defaultSpeaker', label: 'Default voice', kind: 'text' },
    ],
    defaults: {
      enabled: true,
      sttModel: 'saaras:v4',
      ttsModel: 'bulbul:v3',
      defaultSpeaker: 'shubh',
    },
  },
};

export function ChannelsPanel() {
  const channels = useGet<ChannelSettingsView[]>('/settings/channels');
  return (
    <div className={styles.stack}>
      {channels.error && <p className={styles.error}>{channels.error}</p>}
      {(channels.data ?? []).map((view) => (
        <ChannelCard key={view.kind} view={view} onChanged={() => void channels.reload()} />
      ))}
    </div>
  );
}

function ChannelCard({ view, onChanged }: { view: ChannelSettingsView; onChanged: () => void }) {
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

  const sourceNote =
    view.source === 'environment'
      ? 'Currently read from environment variables. Saving here overrides them.'
      : view.source === 'none'
        ? 'Not configured yet.'
        : null;

  return (
    <Card padding="md" aria-labelledby={`channel-${view.kind}`}>
      <CardHeader
        id={`channel-${view.kind}`}
        title={def.title}
        subtitle={def.subtitle}
        actions={<TestResult result={view.lastTest} />}
      />
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
            <Button onClick={test} disabled={testing}>
              Test connection
            </Button>
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
            />
          ))}
        </div>
      </div>
      {view.kind === 'whatsapp' && <WhatsAppSetup view={view} />}
    </Card>
  );
}

export function SecretField({
  secret,
  canEdit,
  onChanged,
}: {
  secret: ChannelSettingsView['secrets'][number];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('PUT', `/settings/secrets/${secret.key}`, { value });
      setValue('');
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
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          disabled={!canEdit}
          placeholder={secret.set ? 'Enter a new value to rotate' : 'Not set'}
          onChange={(e) => setValue(e.target.value)}
          hint={
            <span className={styles.keyState}>Stored: {maskedKey(secret.last4, secret.set)}</span>
          }
        />
        {canEdit && (
          <div className={styles.actions}>
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
