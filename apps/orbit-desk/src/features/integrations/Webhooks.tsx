import {
  type IntegrationView,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENTS,
  WEBHOOK_SCOPES,
  type WebhookDeliveryView,
  type WebhookEvent,
  type WebhookScope,
  type WebhookTestResult,
  type WebhookView,
  type WebhookWithSecret,
} from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Select } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { relativeFromIso } from '../settings/logic';
import settings from '../settings/Settings.module.css';
import styles from './Integrations.module.css';
import { deliveryLine, eventSummary, SCOPE_LABELS, testLine, toggle } from './logic';
import { SecretOnce } from './SecretOnce';

/** One integration's webhooks: where TMS tells the app about events, and how that is going. */
export function Webhooks({ integration }: { integration: IntegrationView }) {
  const { can } = useSession();
  const hooks = useGet<WebhookView[]>(`/integrations/${integration.id}/webhooks`);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<WebhookWithSecret | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mayHandleSecrets = can('settings:secrets');

  const run = async (id: string, action: () => Promise<string | void>) => {
    setBusy(id);
    setMessage(null);
    try {
      const said = await action();
      if (said) setMessage(said);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      void hooks.reload();
    }
  };

  const test = (h: WebhookView) =>
    run(h.id, async () => testLine(await api<WebhookTestResult>('POST', `/webhooks/${h.id}/test`)));
  const setActive = (h: WebhookView, isActive: boolean) =>
    run(h.id, () => api('PATCH', `/webhooks/${h.id}`, { isActive }));
  const rotate = (h: WebhookView) => {
    if (
      !window.confirm(
        'Rotate the signing secret? Deliveries are signed with the new one at once, so the app must be given it.',
      )
    ) {
      return;
    }
    void run(h.id, async () => {
      setSecret(await api<WebhookWithSecret>('POST', `/webhooks/${h.id}/rotate-secret`));
    });
  };
  const remove = (h: WebhookView) => {
    if (!window.confirm(`Delete the webhook to ${h.url}? Its delivery log goes with it.`)) return;
    void run(h.id, async () => {
      await api('DELETE', `/webhooks/${h.id}`);
      if (logFor === h.id) setLogFor(null);
      if (secret?.id === h.id) setSecret(null);
    });
  };

  const list = hooks.data ?? [];
  return (
    <Card padding="md" aria-label={`Webhooks of ${integration.name}`}>
      <CardHeader
        title={`Webhooks · ${integration.name}`}
        subtitle="TMS posts a signed message to these addresses when something happens. Failed deliveries are retried, then logged."
        actions={
          mayHandleSecrets && (
            <Button variant="secondary" icon="plus" onClick={() => setCreating(true)}>
              Add webhook
            </Button>
          )
        }
      />
      {secret && (
        <SecretOnce
          title="Signing secret"
          label="New signing secret"
          value={secret.secret}
          testId="new-webhook-secret"
          onDone={() => setSecret(null)}
        />
      )}
      {message && (
        <p className={settings.note} role="status">
          {message}
        </p>
      )}
      {hooks.error && <p className={settings.error}>{hooks.error}</p>}
      {!hooks.loading && !list.length && !hooks.error && (
        <p className={settings.note}>
          No webhooks yet. Without one, the app has to ask for news itself.
        </p>
      )}
      {list.length > 0 && (
        <ul className={styles.hooks}>
          {list.map((h) => (
            <li key={h.id} className={h.isActive ? undefined : settings.dim} data-webhook={h.id}>
              <div className={styles.hookHead}>
                <div>
                  <div className={settings.mono}>{h.url}</div>
                  <div className={settings.keyState}>
                    {eventSummary(h.events)} · {SCOPE_LABELS[h.scope]} · {h.isActive ? 'On' : 'Off'}
                    {h.lastDeliveryAt
                      ? ` · last delivered ${relativeFromIso(h.lastDeliveryAt)}`
                      : ''}
                    {h.secretLast4 ? ` · secret ••••${h.secretLast4}` : ''}
                  </div>
                  {h.disabledReason && <div className={settings.warning}>{h.disabledReason}</div>}
                </div>
                <div className={settings.actions}>
                  <Button size="sm" disabled={busy === h.id} onClick={() => void test(h)}>
                    Send a test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={logFor === h.id}
                    onClick={() => setLogFor(logFor === h.id ? null : h.id)}
                  >
                    {logFor === h.id ? 'Hide deliveries' : 'Deliveries'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === h.id}
                    onClick={() => void setActive(h, !h.isActive)}
                  >
                    {h.isActive ? 'Switch off' : 'Switch on'}
                  </Button>
                  {mayHandleSecrets && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === h.id}
                        onClick={() => rotate(h)}
                      >
                        Rotate secret
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === h.id}
                        onClick={() => remove(h)}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {logFor === h.id && <Deliveries key={`${h.id}-${busy ?? ''}`} webhookId={h.id} />}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={creating} onClose={() => setCreating(false)} labelledBy="webhook-dialog-title">
        {creating && (
          <WebhookForm
            integration={integration}
            onCancel={() => setCreating(false)}
            onSaved={(created) => {
              setCreating(false);
              setSecret(created);
              void hooks.reload();
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}

/** The delivery log of one webhook: outcomes only, with a way to send one again. */
function Deliveries({ webhookId }: { webhookId: string }) {
  const log = useGet<WebhookDeliveryView[]>(`/webhooks/${webhookId}/deliveries`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const redeliver = async (d: WebhookDeliveryView) => {
    setBusy(d.id);
    setError(null);
    try {
      await api('POST', `/webhooks/deliveries/${d.id}/redeliver`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      void log.reload();
    }
  };

  const list = log.data ?? [];
  return (
    <section className={styles.deliveries} aria-label="Deliveries">
      <div className={settings.actions}>
        <Button size="sm" variant="ghost" onClick={() => void log.reload()}>
          Refresh
        </Button>
      </div>
      {(error ?? log.error) && <p className={settings.error}>{error ?? log.error}</p>}
      {!log.loading && !list.length && !log.error && (
        <p className={settings.note}>Nothing has been sent yet.</p>
      )}
      {list.length > 0 && (
        <div className={settings.scroller}>
          <table className={settings.table}>
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Outcome</th>
                <th scope="col">When</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} data-status={d.status}>
                  <td className={settings.mono}>
                    {d.eventType}
                    {d.redeliveryOf ? ' (sent again)' : ''}
                  </td>
                  <td>{deliveryLine(d)}</td>
                  <td className={settings.nowrap}>{relativeFromIso(d.createdAt)}</td>
                  <td>
                    <div className={settings.actions}>
                      {d.status !== 'pending' && d.eventType !== 'ping' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === d.id}
                          onClick={() => void redeliver(d)}
                        >
                          Send again
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function WebhookForm({
  integration,
  onCancel,
  onSaved,
}: {
  integration: IntegrationView;
  onCancel: () => void;
  onSaved: (created: WebhookWithSecret) => void;
}) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>([
    'ticket.status_changed',
    'message.created',
  ]);
  const [scope, setScope] = useState<WebhookScope>('own');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!events.length) return setError('Choose at least one event.');
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await api<WebhookWithSecret>('POST', `/integrations/${integration.id}/webhooks`, {
          url: url.trim(),
          events,
          scope,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={settings.form} onSubmit={submit} autoComplete="off">
      <div>
        <h2 id="webhook-dialog-title" className={settings.dialogTitle}>
          Add a webhook
        </h2>
        <p className={settings.dialogLede}>
          For {integration.name}. You get a signing secret next; the app uses it to check that a
          message really came from here.
        </p>
      </div>
      <Input
        id="webhook-url"
        label="Address"
        type="url"
        placeholder="https://app.example.com/support/webhook"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        spellCheck={false}
        required
        hint="A public https address."
      />
      <fieldset className={styles.scopes}>
        <legend>Tell it when</legend>
        {WEBHOOK_EVENTS.map((ev) => (
          <label key={ev} className={settings.check}>
            <input
              type="checkbox"
              checked={events.includes(ev)}
              onChange={() => setEvents(toggle(events, ev))}
            />
            <span>
              {WEBHOOK_EVENT_LABELS[ev]}
              <span className={styles.scopeKey}>{ev}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Select
        id="webhook-scope"
        label="About"
        value={scope}
        onChange={(e) => setScope(e.target.value as WebhookScope)}
        options={WEBHOOK_SCOPES.map((s) => ({ value: s, label: SCOPE_LABELS[s] }))}
      />
      {error && (
        <p className={settings.error} role="alert">
          {error}
        </p>
      )}
      <div className={settings.formActions}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="secondary" disabled={saving}>
          Add webhook
        </Button>
      </div>
    </form>
  );
}
