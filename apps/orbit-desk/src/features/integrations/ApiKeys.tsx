import {
  API_KEY_SCOPE_LABELS,
  API_KEY_SCOPES,
  type ApiKeyScope,
  type ApiKeyView,
  type CreatedApiKey,
  DEFAULT_KEY_RATE_LIMIT,
  type IntegrationView,
} from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Select } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { relativeFromIso } from '../settings/logic';
import settings from '../settings/Settings.module.css';
import styles from './Integrations.module.css';
import {
  EXPIRY_CHOICES,
  type ExpiryChoice,
  expiresAtFor,
  keyStatusLabel,
  parseRateLimit,
  scopeSummary,
  toggle,
} from './logic';

/** One integration's API keys: create (shown once), list, revoke. */
export function ApiKeys({
  integration,
  onChanged,
}: {
  integration: IntegrationView;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const keys = useGet<ApiKeyView[]>(`/integrations/${integration.id}/keys`);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mayCreate = can('settings:secrets');

  const reload = () => {
    void keys.reload();
    onChanged();
  };

  const revoke = async (k: ApiKeyView) => {
    if (
      !window.confirm(
        `Revoke "${k.name}"? Requests with it are refused at once, and it cannot be restored.`,
      )
    ) {
      return;
    }
    setBusy(k.id);
    setMessage(null);
    try {
      await api('POST', `/integrations/keys/${k.id}/revoke`);
      if (created?.id === k.id) setCreated(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const list = keys.data ?? [];
  return (
    <Card padding="md" aria-label={`API keys of ${integration.name}`}>
      <CardHeader
        title={`API keys · ${integration.name}`}
        subtitle="A key is shown once, when it is created. TMS keeps only a hash of it."
        actions={
          mayCreate && (
            <Button variant="secondary" icon="plus" onClick={() => setCreating(true)}>
              Create key
            </Button>
          )
        }
      />
      {created && <NewKey created={created} onDone={() => setCreated(null)} />}
      {message && (
        <p className={settings.error} role="alert">
          {message}
        </p>
      )}
      {keys.error && <p className={settings.error}>{keys.error}</p>}
      {!keys.loading && !list.length && !keys.error && (
        <p className={settings.note}>
          No keys yet.
          {mayCreate ? '' : ' Creating keys needs the permission to handle secrets.'}
        </p>
      )}
      {list.length > 0 && (
        <div className={settings.scroller}>
          <table className={settings.table}>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">May</th>
                <th scope="col">Limit</th>
                <th scope="col">Last used</th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((k) => (
                <tr key={k.id} className={k.status === 'active' ? undefined : settings.dim}>
                  <td>
                    <div>{k.name}</div>
                    <div className={settings.mono}>{k.prefix}…</div>
                  </td>
                  <td>{scopeSummary(k.scopes)}</td>
                  <td className={settings.nowrap}>{k.rateLimitPerMinute} / min</td>
                  <td className={settings.nowrap}>{relativeFromIso(k.lastUsedAt)}</td>
                  <td className={settings.nowrap}>
                    {keyStatusLabel(k.status)}
                    {k.status === 'active' && k.expiresAt
                      ? ` · until ${new Date(k.expiresAt).toLocaleDateString()}`
                      : ''}
                  </td>
                  <td>
                    <div className={settings.actions}>
                      {k.status !== 'revoked' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === k.id}
                          onClick={() => void revoke(k)}
                        >
                          Revoke
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
      <Dialog open={creating} onClose={() => setCreating(false)} labelledBy="key-dialog-title">
        {creating && (
          <KeyForm
            integration={integration}
            onCancel={() => setCreating(false)}
            onSaved={(key) => {
              setCreating(false);
              setCreated(key);
              reload();
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}

/** The one time the key is on screen. */
function NewKey({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
  const [note, setNote] = useState('Copy it now. It will not be shown again.');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.key);
      setNote('Copied. Store it where the app keeps its secrets.');
    } catch {
      setNote('Select the key and copy it by hand.');
    }
  };
  return (
    <div className={settings.banner} role="status" aria-label="New API key">
      <div>
        <div>New key “{created.name}”</div>
        <div className={settings.keyState}>{note}</div>
      </div>
      <div className={styles.keyBox}>
        <code className={styles.keyValue} data-testid="new-api-key">
          {created.key}
        </code>
        <div className={settings.actions}>
          <Button size="sm" onClick={() => void copy()}>
            Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function KeyForm({
  integration,
  onCancel,
  onSaved,
}: {
  integration: IntegrationView;
  onCancel: () => void;
  onSaved: (key: CreatedApiKey) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['integration:ticket']);
  const [rate, setRate] = useState(String(DEFAULT_KEY_RATE_LIMIT));
  const [expiry, setExpiry] = useState<ExpiryChoice>('never');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const rateLimitPerMinute = parseRateLimit(rate);
    if (rateLimitPerMinute === 'invalid') {
      return setError('The limit must be a whole number from 1 to 6000.');
    }
    if (!scopes.length) return setError('Choose at least one thing the key may do.');
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await api<CreatedApiKey>('POST', `/integrations/${integration.id}/keys`, {
          name: name.trim(),
          scopes,
          rateLimitPerMinute,
          expiresAt: expiresAtFor(expiry),
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
        <h2 id="key-dialog-title" className={settings.dialogTitle}>
          Create an API key
        </h2>
        <p className={settings.dialogLede}>
          For {integration.name}. Give each part of the app its own key, with only what it needs.
        </p>
      </div>
      <Input
        id="key-name"
        label="Name"
        placeholder="Storefront backend"
        value={name}
        onChange={(e) => setName(e.target.value)}
        minLength={2}
        maxLength={80}
        required
      />
      <fieldset className={styles.scopes}>
        <legend>The key may</legend>
        {API_KEY_SCOPES.map((s) => (
          <label key={s} className={settings.check}>
            <input
              type="checkbox"
              checked={scopes.includes(s)}
              onChange={() => setScopes(toggle(scopes, s))}
            />
            <span>
              {API_KEY_SCOPE_LABELS[s]}
              <span className={styles.scopeKey}>{s}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className={settings.formRow}>
        <Input
          id="key-rate"
          label="Requests per minute"
          inputMode="numeric"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          required
        />
        <Select
          id="key-expiry"
          label="Expires"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value as ExpiryChoice)}
          options={EXPIRY_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
        />
      </div>
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
          Create key
        </Button>
      </div>
    </form>
  );
}
