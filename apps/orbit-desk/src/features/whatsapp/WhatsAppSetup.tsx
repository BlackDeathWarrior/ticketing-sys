import type { ChannelSettingsView, WaTemplateSyncResult, WaTemplateView } from '@tms/shared';
import { useState } from 'react';
import { api } from '../../api/client';
import { Button, Input } from '../../components/ui';
import { cx } from '../../lib/format';
import { useGet } from '../../lib/useGet';
import settings from '../settings/Settings.module.css';
import { setupGaps, TEMPLATE_STATUS_LABELS } from './logic';
import styles from './WhatsApp.module.css';

/** The address Meta calls. It must be reachable from the internet over HTTPS. */
export const webhookUrl = () =>
  new URL('/api/v1/channels/whatsapp/webhook', window.location.origin).href;

/**
 * Everything about WhatsApp that isn't a plain setting: the webhook address
 * to paste into Meta, what is still missing, and the templates synced from Meta.
 */
export function WhatsAppSetup({ view }: { view: ChannelSettingsView }) {
  const templates = useGet<WaTemplateView[]>('/whatsapp/templates?all=true');
  const [busy, setBusy] = useState<'sync' | 'subscribe' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const gaps = setupGaps(view);
  const url = webhookUrl();

  const run = async (what: 'sync' | 'subscribe') => {
    setBusy(what);
    setMessage(null);
    try {
      if (what === 'sync') {
        const r = await api<WaTemplateSyncResult>('POST', '/whatsapp/templates/sync');
        setMessage(
          `${r.total} template${r.total === 1 ? '' : 's'} from Meta, ${r.approved} approved` +
            (r.removed ? `, ${r.removed} removed` : '') +
            '.',
        );
        await templates.reload();
      } else {
        await api('POST', '/whatsapp/subscribe');
        setMessage('Meta will now send this account’s messages to the webhook.');
      }
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setMessage('Webhook address copied.');
    } catch {
      setMessage('Select the address and copy it by hand.');
    }
  };

  return (
    <section className={styles.setup} aria-label="WhatsApp setup">
      <div className={styles.urlRow}>
        <Input
          id="whatsapp-webhook-url"
          label="Webhook address for Meta"
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          hint="Meta must reach it over HTTPS. Use the same verify token here and in Meta."
        />
        <Button onClick={() => void copy()}>Copy</Button>
      </div>

      {gaps.length > 0 ? (
        <div>
          <p className={styles.sectionTitle}>Still to do</p>
          <ul className={styles.gaps} aria-label="Missing WhatsApp settings">
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={settings.note}>
          Everything needed is saved. In Meta, subscribe the webhook to the “messages” field.
        </p>
      )}

      <div>
        <p className={styles.sectionTitle}>Message templates</p>
        <p className={settings.note}>
          Templates are written and approved in WhatsApp Manager. They are the only messages
          WhatsApp allows more than 24 hours after a customer last wrote.
        </p>
      </div>
      <div className={styles.rowActions}>
        <Button onClick={() => void run('sync')} disabled={busy !== null}>
          {busy === 'sync' ? 'Syncing…' : 'Sync templates'}
        </Button>
        <Button variant="ghost" onClick={() => void run('subscribe')} disabled={busy !== null}>
          {busy === 'subscribe' ? 'Subscribing…' : 'Subscribe to webhooks'}
        </Button>
      </div>
      {message && (
        <p className={settings.note} role="status">
          {message}
        </p>
      )}
      {templates.error && <p className={settings.error}>{templates.error}</p>}
      {templates.data &&
        (templates.data.length === 0 ? (
          <p className={settings.note}>No templates synced yet.</p>
        ) : (
          <div className={settings.scroller}>
            <table className={settings.table} aria-label="WhatsApp templates">
              <thead>
                <tr>
                  <th scope="col">Template</th>
                  <th scope="col">Language</th>
                  <th scope="col">Category</th>
                  <th scope="col">Status</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {templates.data.map((t) => (
                  <tr key={t.id} className={cx(t.status !== 'APPROVED' && settings.dim)}>
                    <td className={settings.nowrap}>{t.name}</td>
                    <td>{t.language}</td>
                    <td>{t.category.toLowerCase()}</td>
                    <td className={settings.nowrap}>
                      {TEMPLATE_STATUS_LABELS[t.status] ?? t.status}
                    </td>
                    <td className={styles.templateBody}>{t.bodyText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
