import type { LlmModelView, LlmProviderView, LlmRoleView, RoleMode } from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { Badge, Button, Card, CardHeader, Dialog, Icon, Input, Select } from '../../components/ui';
import { cx } from '../../lib/format';
import { useGet } from '../../lib/useGet';
import { formatPerMTok, move, skipLabel } from './logic';
import styles from './Settings.module.css';

export function ModelsPanel() {
  const models = useGet<LlmModelView[]>('/settings/llm/models');
  const roles = useGet<LlmRoleView[]>('/settings/llm/roles');
  const providers = useGet<LlmProviderView[]>('/settings/llm/providers');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    void models.reload();
    void roles.reload();
  };

  const patch = async (m: LlmModelView, body: Record<string, unknown>) => {
    setError(null);
    try {
      await api('PATCH', `/settings/llm/models/${m.id}`, body);
    } catch (err) {
      setError((err as Error).message);
    }
    reload();
  };

  const remove = async (m: LlmModelView) => {
    if (!window.confirm(`Remove ${m.label}?`)) return;
    try {
      await api('DELETE', `/settings/llm/models/${m.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
    reload();
  };

  const list = models.data ?? [];
  return (
    <div className={styles.stack}>
      <Card padding="md">
        <CardHeader
          title="Models"
          subtitle="Each model is registered in LiteLLM. Capabilities and prices come from LiteLLM; set a price when it doesn't know the model."
          actions={
            <Button
              icon="plus"
              onClick={() => setAdding(true)}
              disabled={!providers.data?.length}
              title={providers.data?.length ? undefined : 'Add a provider first'}
            >
              Add model
            </Button>
          }
        />
        {error && <p className={styles.error}>{error}</p>}
        {!models.loading && !list.length && (
          <p className={styles.note}>No models registered yet.</p>
        )}
        {list.length > 0 && (
          <div className={styles.scroller}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Can do</th>
                  <th scope="col">Price in / out per 1M tokens</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id} className={m.enabled ? undefined : styles.dim}>
                    <td>
                      <div>{m.label}</div>
                      <div className={styles.mono}>
                        {m.model} · {m.providerLabel}
                      </div>
                    </td>
                    <td>
                      <div className={styles.chips}>
                        {m.mode === 'embedding' && <Badge>Embeddings</Badge>}
                        {m.supportsTools && <Badge>Tools</Badge>}
                        {m.supportsJson && <Badge>JSON</Badge>}
                        {m.supportsVision && <Badge>Vision</Badge>}
                      </div>
                    </td>
                    <td className={styles.nowrap}>
                      {formatPerMTok(m.inputCostPerMTok)} / {formatPerMTok(m.outputCostPerMTok)}
                      <div className={styles.muted}>
                        {m.costSource === 'manual'
                          ? 'set by you'
                          : m.costSource === 'litellm'
                            ? 'from LiteLLM'
                            : 'unknown: routed last'}
                      </div>
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => patch(m, { enabled: !m.enabled })}
                        >
                          {m.enabled ? 'Turn off' : 'Turn on'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => remove(m)}>
                          Remove
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

      <Card padding="md">
        <CardHeader
          title="Roles"
          subtitle="What each AI feature uses. “Cheapest first” tries the cheapest capable model and falls back up the list; providers over their cap are skipped."
        />
        {roles.error && <p className={styles.error}>{roles.error}</p>}
        <div>
          {(roles.data ?? []).map((r) => (
            <RoleRow key={r.role} role={r} models={list} onSaved={() => void roles.reload()} />
          ))}
        </div>
      </Card>

      <Dialog open={adding} onClose={() => setAdding(false)} labelledBy="model-dialog-title">
        {adding && (
          <ModelForm
            providers={providers.data ?? []}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              reload();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function RoleRow({
  role,
  models,
  onSaved,
}: {
  role: LlmRoleView;
  models: LlmModelView[];
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<RoleMode>(role.mode);
  const [order, setOrder] = useState<string[]>(role.modelIds);
  const [trying, setTrying] = useState(false);
  const [tryResult, setTryResult] = useState<string | null>(null);
  const eligible = models.filter((m) =>
    role.role === 'embedding' ? m.mode === 'embedding' : m.mode === 'chat',
  );
  const labelOf = (id: string) => models.find((m) => m.id === id)?.label ?? 'Removed model';

  const save = async () => {
    await api('PUT', `/settings/llm/roles/${role.role}`, { mode, modelIds: order });
    setEditing(false);
    onSaved();
  };

  const tryIt = async () => {
    setTrying(true);
    setTryResult(null);
    const r = await api<{
      ok: boolean;
      output?: string;
      model?: string;
      latencyMs?: number;
      error?: string;
    }>('POST', `/settings/llm/roles/${role.role}/try`, {}).catch(
      (err: Error) => ({ ok: false, error: err.message }) as { ok: false; error: string },
    );
    setTryResult(
      r.ok
        ? `${'model' in r ? r.model : ''} answered in ${'latencyMs' in r ? r.latencyMs : '?'} ms: “${('output' in r && r.output) || ''}”`
        : `Failed: ${r.error ?? 'unknown error'}`,
    );
    setTrying(false);
  };

  return (
    <section className={styles.role} aria-labelledby={`role-${role.role}`}>
      <div className={styles.roleHead}>
        <div>
          <span id={`role-${role.role}`} className={styles.roleName}>
            {role.label}
          </span>
          <span className={cx(styles.mono, styles.roleKey)}>{role.role}</span>
          <div className={styles.muted}>
            {role.mode === 'cheapest' ? 'Cheapest first' : 'Fixed order'}
          </div>
        </div>
        <div className={styles.actions}>
          <Button size="sm" onClick={tryIt} disabled={trying}>
            Try it
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close' : 'Change'}
          </Button>
        </div>
      </div>
      {role.warning && (
        <p className={styles.warning}>
          <Icon name="alert" size={14} />
          {role.warning}
        </p>
      )}
      {!editing && role.candidates.length > 0 && (
        <ol className={styles.candidates} aria-label={`${role.label} routing order`}>
          {role.candidates.map((c) => (
            <li key={c.modelId} className={cx(styles.candidate, c.skipped && styles.skipped)}>
              <span className={styles.candLabel}>{c.label}</span>
              <span className={styles.muted}>
                {c.blendedCostPerMTok === null
                  ? 'price unknown'
                  : `${formatPerMTok(c.blendedCostPerMTok)}/1M`}
              </span>
              {c.skipped && <span className={styles.muted}>{skipLabel(c.skipped)}</span>}
            </li>
          ))}
        </ol>
      )}
      {editing && (
        <div className={styles.form}>
          <Select
            id={`mode-${role.role}`}
            label="Routing"
            value={mode}
            onChange={(e) => setMode(e.target.value as RoleMode)}
            options={[
              {
                value: 'cheapest',
                label: 'Cheapest first (all capable models, or only the ones ticked)',
              },
              { value: 'ordered', label: 'Fixed order (only the ticked models, top to bottom)' },
            ]}
          />
          <ol className={styles.candidates}>
            {[...order, ...eligible.map((m) => m.id).filter((id) => !order.includes(id))].map(
              (id) => {
                const index = order.indexOf(id);
                const on = index >= 0;
                return (
                  <li key={id} className={cx(styles.candidate, !on && styles.skipped)}>
                    <label className={cx(styles.check, styles.candLabel)}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setOrder(on ? order.filter((x) => x !== id) : [...order, id])
                        }
                      />
                      {labelOf(id)}
                    </label>
                    {on && mode === 'ordered' && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          icon="chevronUp"
                          disabled={index === 0}
                          onClick={() => setOrder(move(order, index, -1))}
                        >
                          Move up
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          iconOnly
                          icon="chevronDown"
                          disabled={index === order.length - 1}
                          onClick={() => setOrder(move(order, index, 1))}
                        >
                          Move down
                        </Button>
                      </>
                    )}
                  </li>
                );
              },
            )}
          </ol>
          <div className={styles.formActions}>
            <Button onClick={save} disabled={mode === 'ordered' && !order.length}>
              Save routing
            </Button>
          </div>
        </div>
      )}
      {tryResult && (
        <p className={styles.tryOut} role="status">
          {tryResult}
        </p>
      )}
    </section>
  );
}

function ModelForm({
  providers,
  onCancel,
  onSaved,
}: {
  providers: LlmProviderView[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [model, setModel] = useState('');
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState<'chat' | 'embedding'>('chat');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [tools, setTools] = useState<'auto' | 'yes' | 'no'>('auto');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const price = (s: string) => (s.trim() ? Number(s) : undefined);
    try {
      await api('POST', '/settings/llm/models', {
        providerId,
        model: model.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        mode,
        ...(price(input) !== undefined ? { inputCostPerMTok: price(input) } : {}),
        ...(price(output) !== undefined ? { outputCostPerMTok: price(output) } : {}),
        ...(tools !== 'auto'
          ? { supportsTools: tools === 'yes', supportsJson: tools === 'yes' }
          : {}),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} autoComplete="off">
      <div>
        <h2 id="model-dialog-title" className={styles.dialogTitle}>
          Add a model
        </h2>
        <p className={styles.dialogLede}>
          Use the provider's model name, such as claude-haiku-4-5 or llama-3.1-8b-instant.
        </p>
      </div>
      <Select
        id="model-provider"
        label="Provider"
        value={providerId}
        onChange={(e) => setProviderId(e.target.value)}
        options={providers.map((p) => ({ value: p.id, label: p.label }))}
      />
      <div className={styles.formRow}>
        <Input
          id="model-name"
          label="Model name"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          required
        />
        <Input
          id="model-label"
          label="Display name (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className={styles.formRow}>
        <Select
          id="model-mode"
          label="Kind"
          value={mode}
          onChange={(e) => setMode(e.target.value as 'chat' | 'embedding')}
          options={[
            { value: 'chat', label: 'Chat' },
            { value: 'embedding', label: 'Embeddings' },
          ]}
        />
        <Select
          id="model-tools"
          label="Tool calling and JSON"
          value={tools}
          onChange={(e) => setTools(e.target.value as 'auto' | 'yes' | 'no')}
          options={[
            { value: 'auto', label: 'As LiteLLM reports' },
            { value: 'yes', label: 'Supported' },
            { value: 'no', label: 'Not supported' },
          ]}
        />
      </div>
      <div className={styles.formRow}>
        <Input
          id="model-in"
          label="Input price per 1M tokens (USD)"
          inputMode="decimal"
          placeholder="From LiteLLM"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <Input
          id="model-out"
          label="Output price per 1M tokens (USD)"
          inputMode="decimal"
          placeholder="From LiteLLM"
          value={output}
          onChange={(e) => setOutput(e.target.value)}
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
        <Button type="submit" disabled={saving || !model.trim() || !providerId}>
          Add model
        </Button>
      </div>
    </form>
  );
}
