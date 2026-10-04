import {
  CUSTOM_TOOL_METHODS,
  CUSTOM_TOOL_PARAM_TYPES,
  type CustomToolDraft,
  type RoleView,
  TOOL_TIERS,
  type ToolView,
} from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Select, Textarea } from '../../components/ui';
import { cx } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { SecretField } from '../settings/ChannelsPanel';
import settings from '../settings/Settings.module.css';
import {
  type CustomToolForm,
  customToolBody,
  emptyCustomTool,
  formFromTool,
  helperDraftOf,
  tierLabel,
  withHelperDraft,
} from './logic';
import { ToolHelper } from './ToolHelper';
import { TestDialog } from './ToolsPanel';
import styles from './Tools.module.css';

/**
 * Custom tools (ADR 0017): an HTTP request to a company system, described
 * here instead of coming from an MCP server. Admins can create them, and so
 * can roles an admin has allowed.
 */
export function CustomTools() {
  const { can } = useSession();
  const tools = useGet<ToolView[]>('/tools/custom');
  const [editing, setEditing] = useState<ToolView | 'new' | null>(null);
  const reload = () => void tools.reload();

  return (
    <>
      <Card padding="md" aria-labelledby="custom-tools">
        <CardHeader
          id="custom-tools"
          title="Custom tools"
          subtitle="A web request to one of your systems that the AI can make: look something up, or change something. Internal addresses are refused unless an operator allowed the host."
          actions={<Button onClick={() => setEditing('new')}>New custom tool</Button>}
        />
        {tools.error && <p className={settings.error}>{tools.error}</p>}
        {tools.data && tools.data.length === 0 && (
          <p className={settings.note}>No custom tools yet.</p>
        )}
        {tools.data && tools.data.length > 0 && (
          <ul className={styles.list} aria-label="Custom tools">
            {tools.data.map((t) => (
              <CustomToolRow key={t.id} tool={t} onEdit={() => setEditing(t)} onChanged={reload} />
            ))}
          </ul>
        )}
      </Card>
      {can('user:manage') && <ToolCreators />}
      {editing && (
        <CustomToolDialog
          tool={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function CustomToolRow({
  tool,
  onEdit,
  onChanged,
}: {
  tool: ToolView;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const custom = tool.custom!;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      onChanged();
    }
  };
  const setEnabled = (enabled: boolean) =>
    run(() =>
      api('PUT', `/tools/custom/${tool.id}`, customToolBody({ ...formFromTool(tool), enabled })),
    );
  const remove = () => {
    if (!window.confirm(`Delete the custom tool ${tool.title ?? tool.name}?`)) return;
    void run(() => api('DELETE', `/tools/custom/${tool.id}`));
  };

  const id = `custom-${tool.id}`;
  return (
    <li className={cx(styles.tool, !tool.enabled && styles.off)} data-tool={tool.name}>
      <div>
        <p className={styles.toolName}>
          {tool.title ?? tool.name}
          <span className={styles.toolKey}>{tool.name}</span>
        </p>
        <p className={styles.toolDesc}>{tool.description}</p>
        <p className={styles.request}>
          <span className={styles.method}>{custom.method}</span>
          <span className={settings.mono}>{custom.url}</span>
        </p>
        <p className={styles.meta}>
          <span>{tierLabel(tool.tier)}</span>
          {tool.customerArg && <span>Customer email goes in {tool.customerArg}</span>}
          {custom.createdBy && <span>Created by {custom.createdBy.name}</span>}
        </p>
        {custom.authHeader && (
          <SecretField
            secret={{
              key: custom.token.key,
              label: `Key (sent as ${custom.authHeader})`,
              set: custom.token.set,
              last4: custom.token.last4,
            }}
            canEdit={can('settings:secrets')}
            onChanged={onChanged}
          />
        )}
        {error && <p className={settings.error}>{error}</p>}
      </div>
      <div className={styles.controls}>
        <Select
          id={`${id}-enabled`}
          label="AI may use it"
          value={tool.enabled ? 'yes' : 'no'}
          onChange={(e) => void setEnabled(e.target.value === 'yes')}
          options={[
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes' },
          ]}
        />
        <Button
          size="sm"
          onClick={() => setTesting(true)}
          disabled={tool.tier === 'transactional'}
          title={
            tool.tier === 'transactional'
              ? 'Needs-approval tools only run after an approval on a ticket'
              : undefined
          }
        >
          Test
        </Button>
        <Button size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={remove}>
          Delete
        </Button>
      </div>
      <TestDialog
        tool={tool}
        path={`/tools/custom/${tool.id}/test`}
        open={testing}
        onClose={() => setTesting(false)}
      />
    </li>
  );
}

function CustomToolDialog({
  tool,
  onClose,
  onSaved,
}: {
  tool: ToolView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CustomToolForm>(() =>
    tool ? formFromTool(tool) : emptyCustomTool(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A tool of the same system whose saved key the helper found: the new tool uses it too.
  const [keyFrom, setKeyFrom] = useState<{ toolId: string; title: string } | null>(null);
  const set = <K extends keyof CustomToolForm>(key: K, value: CustomToolForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setParam = (i: number, patch: Partial<CustomToolForm['parameters'][number]>) =>
    set(
      'parameters',
      form.parameters.map((p, n) => (n === i ? { ...p, ...patch } : p)),
    );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = customToolBody(form);
      if (tool) await api('PUT', `/tools/custom/${tool.id}`, body);
      else {
        await api('POST', '/tools/custom', {
          ...body,
          name: form.name.trim(),
          ...(keyFrom && body.authHeader ? { keyFromToolId: keyFrom.toolId } : {}),
        });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = tool ? `Edit ${tool.title ?? tool.name}` : 'New custom tool';
  return (
    <Dialog open onClose={onClose} labelledBy="custom-tool-title">
      <form onSubmit={save} className={settings.form} aria-label={title}>
        <h2 id="custom-tool-title" className={settings.dialogTitle}>
          {title}
        </h2>
        <p className={settings.dialogLede}>
          Describe one request. Put <code>{'{name}'}</code> in the address where a value belongs;
          other values go in the query for GET and DELETE, or in a JSON body.
        </p>
        <ToolHelper<CustomToolDraft>
          id="ct-helper"
          path="/ai/tool-helper/custom-tool"
          draft={helperDraftOf(form)}
          onDraft={(draft) => setForm((f) => withHelperDraft(f, draft, !!tool))}
          onAnswer={(answer) => setKeyFrom(tool ? null : (answer.keyFrom ?? null))}
          placeholder="Look up how many of a product we have in stock, from our warehouse system at https://warehouse.example.com"
          connection={{
            checkPath: '/tools/custom/check',
            diagnosePath: '/ai/tool-helper/custom-tool/diagnose',
            name: form.title.trim() || form.name.trim(),
            method: form.method,
            url: form.url.trim(),
            body: {
              method: form.method,
              url: form.url.trim(),
              authHeader: form.authHeader || null,
              // A new tool is checked with the key it will get: the one of the tool the helper found.
              ...(tool ? { toolId: tool.id } : keyFrom ? { toolId: keyFrom.toolId } : {}),
            },
          }}
        />
        <div className={settings.formRow}>
          <Input
            id="ct-title"
            label="Title"
            required
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Stock level"
          />
          <Input
            id="ct-name"
            label="Name for the AI"
            required
            disabled={!!tool}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="stock_level"
            hint={tool ? 'The name cannot change' : 'Lowercase letters, digits and underscores'}
          />
        </div>
        <Textarea
          id="ct-description"
          label="What it does (the AI decides when to use it from this)"
          rows={2}
          required
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
        />
        <div className={styles.requestRow}>
          <Select
            id="ct-method"
            label="Method"
            value={form.method}
            onChange={(e) => set('method', e.target.value as CustomToolForm['method'])}
            options={CUSTOM_TOOL_METHODS.map((m) => ({ value: m, label: m }))}
          />
          <Input
            id="ct-url"
            label="Address"
            required
            value={form.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="https://api.example.com/stock/{sku}"
          />
        </div>

        {keyFrom && form.authHeader && (
          <p className={settings.note} role="status" data-key-from>
            This tool will use the key already saved for “{keyFrom.title}”, which talks to the same
            system. Nobody needs to enter a key.
          </p>
        )}

        <fieldset className={styles.params}>
          <legend>Values the AI fills in</legend>
          {form.parameters.length === 0 && <p className={settings.note}>None.</p>}
          {form.parameters.map((p, i) => (
            <div key={i} className={styles.param} role="group" aria-label={`Value ${i + 1}`}>
              <Input
                id={`ct-param-${i}-name`}
                label="Name"
                required
                value={p.name}
                onChange={(e) => setParam(i, { name: e.target.value })}
                placeholder="sku"
              />
              <Select
                id={`ct-param-${i}-type`}
                label="Type"
                value={p.type}
                onChange={(e) =>
                  setParam(i, {
                    type: e.target.value as CustomToolForm['parameters'][number]['type'],
                  })
                }
                options={CUSTOM_TOOL_PARAM_TYPES.map((t) => ({ value: t, label: t }))}
              />
              <Input
                id={`ct-param-${i}-description`}
                label="What it is"
                value={p.description}
                onChange={(e) => setParam(i, { description: e.target.value })}
                placeholder="Product code"
              />
              <Select
                id={`ct-param-${i}-required`}
                label="Required"
                value={p.required ? 'yes' : 'no'}
                onChange={(e) => setParam(i, { required: e.target.value === 'yes' })}
                options={[
                  { value: 'yes', label: 'Yes' },
                  { value: 'no', label: 'No' },
                ]}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  set(
                    'parameters',
                    form.parameters.filter((_, n) => n !== i),
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              size="sm"
              disabled={form.parameters.length >= 12}
              onClick={() =>
                set('parameters', [
                  ...form.parameters,
                  { name: '', type: 'string', description: '', required: true },
                ])
              }
            >
              Add a value
            </Button>
          </div>
        </fieldset>

        <div className={settings.formRow}>
          <Select
            id="ct-auth"
            label="Key header"
            value={form.authHeader}
            onChange={(e) => set('authHeader', e.target.value)}
            options={[
              { value: '', label: 'No key' },
              { value: 'Authorization', label: 'Authorization: Bearer' },
              { value: 'X-Api-Key', label: 'X-Api-Key' },
            ]}
          />
          <Select
            id="ct-tier"
            label="Risk"
            value={form.tier}
            onChange={(e) => set('tier', e.target.value as CustomToolForm['tier'])}
            options={TOOL_TIERS.map((t) => ({ value: t, label: tierLabel(t) }))}
          />
          <Select
            id="ct-customer"
            label="Customer email goes in"
            value={form.customerArg}
            onChange={(e) => set('customerArg', e.target.value)}
            options={[
              { value: '', label: 'Nothing' },
              ...form.parameters
                .filter((p) => p.name.trim())
                .map((p) => ({ value: p.name.trim(), label: p.name.trim() })),
            ]}
          />
          <Select
            id="ct-enabled"
            label="AI may use it"
            value={form.enabled ? 'yes' : 'no'}
            onChange={(e) => set('enabled', e.target.value === 'yes')}
            options={[
              { value: 'no', label: 'No' },
              { value: 'yes', label: 'Yes' },
            ]}
          />
        </div>
        {form.authHeader && (
          <p className={settings.note}>
            Save the tool first; an admin then adds its key on the tool’s row. Keys are write-only.
          </p>
        )}
        <div className={settings.formActions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {tool ? 'Save changes' : 'Create tool'}
          </Button>
        </div>
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** Admins decide which other roles may create custom tools. */
function ToolCreators() {
  const roles = useGet<RoleView[]>('/roles');
  const [error, setError] = useState<string | null>(null);
  // The box follows the click at once; the saved state replaces it when it arrives.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const toggle = async (role: RoleView, granted: boolean) => {
    setError(null);
    setPending((p) => ({ ...p, [role.key]: granted }));
    try {
      await api(granted ? 'PUT' : 'DELETE', `/roles/${role.key}/permissions/tool:create`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      await roles.reload();
      setPending(({ [role.key]: _done, ...rest }) => rest);
    }
  };

  return (
    <Card padding="md" aria-labelledby="tool-creators">
      <CardHeader
        id="tool-creators"
        title="Who can create custom tools"
        subtitle="Administrators always can. Other roles can once you allow them here; keys stay with administrators."
      />
      {roles.error && <p className={settings.error}>{roles.error}</p>}
      <ul className={styles.creators} aria-label="Roles">
        {(roles.data ?? []).map((r) => {
          const allowed = pending[r.key] ?? r.permissions.includes('tool:create');
          return (
            <li key={r.key}>
              <label className={settings.check}>
                <input
                  type="checkbox"
                  checked={allowed}
                  disabled={r.locked}
                  onChange={(e) => void toggle(r, e.target.checked)}
                />
                <span>{r.name}</span>
              </label>
              <span className={settings.muted}>{r.description}</span>
            </li>
          );
        })}
      </ul>
      {error && <p className={settings.error}>{error}</p>}
    </Card>
  );
}
