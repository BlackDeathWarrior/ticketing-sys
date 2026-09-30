import {
  BUDGET_PERIODS,
  type BudgetPeriod,
  LLM_PROVIDER_INFO,
  LLM_PROVIDERS,
  type LlmProvider,
  type LlmProviderView,
} from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Meter, Select } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { formatUsd, maskedKey, parseBudget, PERIOD_LABELS } from './logic';
import styles from './Settings.module.css';
import { TestResult } from './TestResult';

type Editing = { mode: 'add' } | { mode: 'edit'; provider: LlmProviderView } | null;

export function ProvidersPanel() {
  const { can } = useSession();
  const providers = useGet<LlmProviderView[]>('/settings/llm/providers');
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mayHandleKeys = can('settings:secrets');

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      void providers.reload();
    }
  };

  const test = (p: LlmProviderView) =>
    run(p.id, async () => {
      const r = await api<{ ok: boolean; error?: string; model: string }>(
        'POST',
        `/settings/llm/providers/${p.id}/test`,
      );
      setMessage(r.ok ? `${p.label}: ${r.model} answered.` : `${p.label}: ${r.error ?? 'failed'}`);
    });

  const toggle = (p: LlmProviderView) =>
    run(p.id, () => api('PATCH', `/settings/llm/providers/${p.id}`, { enabled: !p.enabled }));

  const remove = (p: LlmProviderView) => {
    if (!window.confirm(`Delete ${p.label}? Its key and models are removed from LiteLLM.`)) return;
    void run(p.id, () => api('DELETE', `/settings/llm/providers/${p.id}`));
  };

  const list = providers.data ?? [];
  return (
    <Card padding="md">
      <CardHeader
        title="AI providers"
        subtitle="Keys are stored in LiteLLM and never shown again. Each provider can have a spending cap."
        actions={
          mayHandleKeys && (
            <Button variant="secondary" icon="plus" onClick={() => setEditing({ mode: 'add' })}>
              Add provider
            </Button>
          )
        }
      />
      {message && (
        <p className={styles.note} role="status">
          {message}
        </p>
      )}
      {providers.error && <p className={styles.error}>{providers.error}</p>}
      {!providers.loading && !list.length && !providers.error && (
        <p className={styles.note}>
          No providers yet. Add one with its API key; then register models under Models &amp; roles.
        </p>
      )}
      {list.length > 0 && (
        <div className={styles.scroller}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Key</th>
                <th scope="col">Spend this period</th>
                <th scope="col">Connection</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className={p.enabled ? undefined : styles.dim}>
                  <td>
                    <div>{p.label}</div>
                    <div className={styles.muted}>
                      {LLM_PROVIDER_INFO[p.provider].label}
                      {p.enabled ? '' : ' · off'}
                    </div>
                  </td>
                  <td className={styles.mono}>{maskedKey(p.keyLast4)}</td>
                  <td>
                    <div className={styles.budget}>
                      {p.budgetUsd !== null && p.budgetUsd > 0 && (
                        <Meter value={p.spentUsd} max={p.budgetUsd} label={`${p.label} spend`} />
                      )}
                      <span className={styles.budgetText}>
                        {formatUsd(p.spentUsd)}
                        {p.budgetUsd === null
                          ? ' · no cap'
                          : ` of ${formatUsd(p.budgetUsd)} ${PERIOD_LABELS[p.budgetPeriod]}`}
                      </span>
                    </div>
                  </td>
                  <td>
                    <TestResult result={p.lastTest} />
                  </td>
                  <td>
                    <div className={styles.actions}>
                      <Button size="sm" onClick={() => test(p)} disabled={busy === p.id}>
                        Test
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing({ mode: 'edit', provider: p })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => toggle(p)}
                        disabled={busy === p.id}
                      >
                        {p.enabled ? 'Turn off' : 'Turn on'}
                      </Button>
                      {mayHandleKeys && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => remove(p)}
                          disabled={busy === p.id}
                        >
                          Delete
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
      <ProviderDialog
        editing={editing}
        mayHandleKeys={mayHandleKeys}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void providers.reload();
        }}
      />
    </Card>
  );
}

function ProviderDialog({
  editing,
  mayHandleKeys,
  onClose,
  onSaved,
}: {
  editing: Editing;
  mayHandleKeys: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = editing?.mode === 'edit' ? editing.provider : null;
  return (
    <Dialog open={!!editing} onClose={onClose} labelledBy="provider-dialog-title">
      {editing && (
        <ProviderForm
          key={current?.id ?? 'new'}
          current={current}
          mayHandleKeys={mayHandleKeys}
          onCancel={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function ProviderForm({
  current,
  mayHandleKeys,
  onCancel,
  onSaved,
}: {
  current: LlmProviderView | null;
  mayHandleKeys: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState<LlmProvider>(current?.provider ?? 'anthropic');
  const info = LLM_PROVIDER_INFO[provider];
  const [label, setLabel] = useState(current?.label ?? info.label);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? '');
  const [budget, setBudget] = useState(current?.budgetUsd?.toString() ?? '');
  const [period, setPeriod] = useState<BudgetPeriod>(current?.budgetPeriod ?? 'month');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const budgetUsd = parseBudget(budget);
    if (budgetUsd === 'invalid') return setError('The cap must be a dollar amount, or empty.');
    setSaving(true);
    setError(null);
    try {
      if (current) {
        await api('PATCH', `/settings/llm/providers/${current.id}`, {
          label,
          budgetUsd,
          budgetPeriod: period,
          ...(baseUrl.trim() !== (current.baseUrl ?? '')
            ? { baseUrl: baseUrl.trim() || null }
            : {}),
          ...(apiKey ? { apiKey } : {}),
        });
      } else {
        await api('POST', '/settings/llm/providers', {
          provider,
          label,
          budgetUsd,
          budgetPeriod: period,
          ...(apiKey ? { apiKey } : {}),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} autoComplete="off">
      <div>
        <h2 id="provider-dialog-title" className={styles.dialogTitle}>
          {current ? `Edit ${current.label}` : 'Add a provider'}
        </h2>
        <p className={styles.dialogLede}>
          The key goes straight to LiteLLM. TMS keeps only its last four characters.
        </p>
      </div>
      {!current && (
        <Select
          id="provider-kind"
          label="Provider"
          value={provider}
          onChange={(e) => {
            const next = e.target.value as LlmProvider;
            setProvider(next);
            setLabel(LLM_PROVIDER_INFO[next].label);
            setBaseUrl(LLM_PROVIDER_INFO[next].defaultBaseUrl ?? '');
          }}
          options={LLM_PROVIDERS.map((p) => ({ value: p, label: LLM_PROVIDER_INFO[p].label }))}
        />
      )}
      <Input
        id="provider-label"
        label="Name"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        required
      />
      {mayHandleKeys && (
        <Input
          id="provider-key"
          label={current ? 'Rotate key (leave empty to keep the current one)' : 'API key'}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          required={!current && info.keyRequired}
          hint={current?.keyLast4 ? `Current key ends in ${current.keyLast4}` : undefined}
        />
      )}
      {(info.baseUrlRequired ||
        info.defaultBaseUrl ||
        current?.baseUrl ||
        provider === 'openai') && (
        <Input
          id="provider-base-url"
          label={info.baseUrlRequired ? 'Base URL' : 'Base URL (optional)'}
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={info.defaultBaseUrl ?? 'https://…'}
          required={info.baseUrlRequired}
        />
      )}
      <div className={styles.formRow}>
        <Input
          id="provider-budget"
          label="Spending cap (USD)"
          inputMode="decimal"
          placeholder="No cap"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          hint="When reached, the router skips this provider."
        />
        <Select
          id="provider-period"
          label="Cap resets"
          value={period}
          onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}
          options={BUDGET_PERIODS.map((p) => ({ value: p, label: PERIOD_LABELS[p] }))}
        />
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.formActions}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="secondary" disabled={saving}>
          {current ? 'Save' : 'Add provider'}
        </Button>
      </div>
    </form>
  );
}
