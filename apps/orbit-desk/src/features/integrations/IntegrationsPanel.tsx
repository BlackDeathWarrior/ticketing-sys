import type { IntegrationView } from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input } from '../../components/ui';
import { useGet } from '../../lib/useGet';
import settings from '../settings/Settings.module.css';
import { ApiKeys } from './ApiKeys';
import { isValidSlug, slugFromName } from './logic';

/** Settings → Integrations: outside apps connected to TMS, and the API keys they call with. */
export function IntegrationsPanel() {
  const integrations = useGet<IntegrationView[]>('/integrations');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const list = integrations.data ?? [];
  const open = list.find((i) => i.id === openId) ?? null;

  const setActive = async (i: IntegrationView, isActive: boolean) => {
    if (
      !isActive &&
      !window.confirm(`Switch off ${i.name}? Its API keys stop working until it is on again.`)
    ) {
      return;
    }
    setBusy(i.id);
    setMessage(null);
    try {
      await api('PATCH', `/integrations/${i.id}`, { isActive });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      void integrations.reload();
    }
  };

  return (
    <div className={settings.stack}>
      <Card padding="md">
        <CardHeader
          title="Integrations"
          subtitle="An integration is an outside app that creates tickets and reports incidents through the API. Each one has its own keys."
          actions={
            <Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>
              Add integration
            </Button>
          }
        />
        {message && (
          <p className={settings.error} role="alert">
            {message}
          </p>
        )}
        {integrations.error && <p className={settings.error}>{integrations.error}</p>}
        {!integrations.loading && !list.length && !integrations.error && (
          <p className={settings.note}>
            No integrations yet. Add one for each app that should talk to this workspace.
          </p>
        )}
        {list.length > 0 && (
          <div className={settings.scroller}>
            <table className={settings.table}>
              <thead>
                <tr>
                  <th scope="col">Integration</th>
                  <th scope="col">Working keys</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id} className={i.isActive ? undefined : settings.dim}>
                    <td>
                      <div>{i.name}</div>
                      <div className={settings.mono}>{i.slug}</div>
                    </td>
                    <td>{i.activeKeys}</td>
                    <td>{i.isActive ? 'On' : 'Off'}</td>
                    <td>
                      <div className={settings.actions}>
                        <Button
                          size="sm"
                          aria-expanded={openId === i.id}
                          onClick={() => setOpenId(openId === i.id ? null : i.id)}
                        >
                          {openId === i.id ? 'Hide keys' : 'API keys'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === i.id}
                          onClick={() => void setActive(i, !i.isActive)}
                        >
                          {i.isActive ? 'Switch off' : 'Switch on'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && (
        <ApiKeys key={open.id} integration={open} onChanged={() => void integrations.reload()} />
      )}

      <Dialog open={adding} onClose={() => setAdding(false)} labelledBy="integration-dialog-title">
        {adding && (
          <IntegrationForm
            onCancel={() => setAdding(false)}
            onSaved={(created) => {
              setAdding(false);
              setOpenId(created.id);
              void integrations.reload();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function IntegrationForm({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (created: IntegrationView) => void;
}) {
  const [name, setName] = useState('');
  // The slug follows the name until the admin types their own.
  const [slug, setSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const effectiveSlug = slug ?? slugFromName(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isValidSlug(effectiveSlug)) {
      return setError(
        'The identifier needs 2 to 40 lowercase letters, digits or dashes, starting with a letter.',
      );
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await api<IntegrationView>('POST', '/integrations', {
          name: name.trim(),
          slug: effectiveSlug,
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
        <h2 id="integration-dialog-title" className={settings.dialogTitle}>
          Add an integration
        </h2>
        <p className={settings.dialogLede}>
          Name the app that will connect. You create its API keys next.
        </p>
      </div>
      <Input
        id="integration-name"
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        minLength={2}
        maxLength={80}
        required
      />
      <Input
        id="integration-slug"
        label="Identifier"
        value={effectiveSlug}
        onChange={(e) => setSlug(e.target.value)}
        spellCheck={false}
        required
        hint="Used by the app and in secret names. It cannot be changed later."
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
          Add integration
        </Button>
      </div>
    </form>
  );
}
