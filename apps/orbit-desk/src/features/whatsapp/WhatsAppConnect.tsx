import type {
  ChannelSettingsView,
  HealthCheck,
  WhatsappConnectInput,
  WhatsappConnectResult,
} from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Input, StatusLight } from '../../components/ui';
import { useSession } from '../../lib/session';
import { SecretField } from '../settings/ChannelsPanel';
import { maskedKey, newVerifyToken } from '../settings/logic';
import settings from '../settings/Settings.module.css';
import styles from './WhatsApp.module.css';

interface Props {
  view: ChannelSettingsView;
  onChanged: () => void;
}

const EMPTY = { accessToken: '', appSecret: '', verifyToken: '', pin: '' };

function savedIds(config: ChannelSettingsView['config']) {
  const text = (key: string, fallback = '') =>
    typeof config?.[key] === 'string' ? (config[key] as string) : fallback;
  return {
    phoneNumberId: text('phoneNumberId'),
    wabaId: text('wabaId'),
    graphVersion: text('graphVersion', 'v23.0'),
  };
}

/**
 * Connect a WhatsApp number in one step: the IDs and keys from Meta go in one
 * form, are checked with Meta, and are only saved when Meta accepts them.
 */
export function WhatsAppConnect({ view, onChanged }: Props) {
  const { can } = useSession();
  const saved = (view.config ?? {}) as Record<string, unknown>;
  const [ids, setIds] = useState(() => savedIds(view.config));
  const [keys, setKeys] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<HealthCheck[] | null>(null);
  const [generated, setGenerated] = useState(false);

  // Follow the saved settings when they change (after connecting, or a reload).
  useEffect(() => setIds(savedIds(view.config)), [view.config]);

  const stored = (key: string) => view.secrets.find((s) => s.key === key);
  const keyHint = (key: string) => {
    const s = stored(key);
    return s?.set ? `Saved: ${maskedKey(s.last4)}. Leave empty to keep it.` : 'Not saved yet.';
  };
  const mayConnect = can('settings:secrets');
  const on = saved.enabled === true;

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSteps(null);
    const body: WhatsappConnectInput = {
      ...ids,
      ...Object.fromEntries(Object.entries(keys).filter(([, v]) => v.trim())),
    };
    try {
      const result = await api<WhatsappConnectResult>('POST', '/whatsapp/connect', body);
      setSteps(result.steps);
      if (result.connected) {
        // The verify token stays on screen until it has been copied into Meta.
        setKeys({ ...EMPTY, verifyToken: generated ? keys.verifyToken : '' });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/settings/channels/whatsapp', { ...saved, enabled: false });
      setSteps(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  return (
    <div className={styles.connect}>
      <form className={settings.form} onSubmit={connect} aria-label="Connect WhatsApp">
        <div className={settings.formRow}>
          <Input
            id="wa-phone-number-id"
            label="Phone number ID"
            inputMode="numeric"
            placeholder="From Meta › WhatsApp › API setup"
            value={ids.phoneNumberId}
            onChange={(e) => setIds({ ...ids, phoneNumberId: e.target.value })}
            required
          />
          <Input
            id="wa-waba-id"
            label="WhatsApp Business account ID"
            inputMode="numeric"
            placeholder="From Meta › WhatsApp › API setup"
            value={ids.wabaId}
            onChange={(e) => setIds({ ...ids, wabaId: e.target.value })}
            required
          />
          <Input
            id="wa-access-token"
            label="Access token"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={!mayConnect}
            value={keys.accessToken}
            onChange={(e) => setKeys({ ...keys, accessToken: e.target.value })}
            hint={keyHint('whatsapp.access_token')}
          />
          <Input
            id="wa-app-secret"
            label="App secret"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={!mayConnect}
            value={keys.appSecret}
            onChange={(e) => setKeys({ ...keys, appSecret: e.target.value })}
            hint={`${keyHint('whatsapp.app_secret')} From Meta › App settings › Basic.`}
          />
          <div className={styles.tokenRow}>
            <Input
              id="wa-verify-token"
              label="Webhook verify token"
              type={generated ? 'text' : 'password'}
              autoComplete="new-password"
              spellCheck={false}
              disabled={!mayConnect}
              value={keys.verifyToken}
              onChange={(e) => {
                setGenerated(false);
                setKeys({ ...keys, verifyToken: e.target.value });
              }}
              hint={
                generated
                  ? 'Copy it into Meta now. It cannot be shown again after you leave this page.'
                  : `${keyHint('whatsapp.verify_token')} Any long random text; Meta needs the same one.`
              }
            />
            <Button
              disabled={!mayConnect}
              onClick={() => {
                setGenerated(true);
                setKeys({ ...keys, verifyToken: newVerifyToken() });
              }}
            >
              Generate
            </Button>
          </div>
          <Input
            id="wa-pin"
            label="Two-step verification PIN (optional)"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            disabled={!mayConnect}
            value={keys.pin}
            onChange={(e) => setKeys({ ...keys, pin: e.target.value })}
            hint="Only to register a real number for the first time. Meta's test number needs none."
          />
        </div>
        <details className={styles.advanced}>
          <summary>Advanced</summary>
          <Input
            id="wa-graph-version"
            label="Graph API version"
            value={ids.graphVersion}
            onChange={(e) => setIds({ ...ids, graphVersion: e.target.value })}
            required
          />
        </details>
        {!mayConnect && (
          <p className={settings.note}>Only people who may manage keys can connect WhatsApp.</p>
        )}
        <div className={settings.formActions}>
          {on && (
            <Button variant="ghost" onClick={() => void turnOff()} disabled={busy}>
              Turn off
            </Button>
          )}
          <Button type="submit" disabled={busy || !mayConnect}>
            {busy ? 'Checking with Meta…' : on ? 'Reconnect WhatsApp' : 'Connect WhatsApp'}
          </Button>
        </div>
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
      </form>

      {steps && (
        <ul className={settings.checkList} aria-label="Connection result">
          {steps.map((s) => (
            <li key={s.key} className={settings.check} data-state={s.state}>
              <StatusLight state={s.state} compact />
              <span className={settings.checkLabel}>{s.label}</span>
              <span className={settings.checkDetail}>{s.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <details className={styles.advanced}>
        <summary>Saved keys</summary>
        <div className={settings.form}>
          <p className={settings.note}>
            Keys are encrypted and write-only: only the last four characters show.
          </p>
          {view.secrets.map((s) => (
            <SecretField key={s.key} secret={s} canEdit={mayConnect} onChanged={onChanged} />
          ))}
        </div>
      </details>
    </div>
  );
}
