import { STATUS_CATEGORIES } from '@tms/shared';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Select } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import settings from '../settings/Settings.module.css';
import styles from './Admin.module.css';
import {
  type AdminCategory,
  type AdminStatus,
  CATEGORY_LABELS,
  hasTransition,
  sameTransitions,
  statusKey,
  toggleTransition,
  type Transition,
  workflowWarnings,
} from './logic';

interface Workflow {
  statuses: AdminStatus[];
  transitions: Array<{ fromStatus: string; toStatus: string }>;
}

/** Settings → Tickets: the categories customers and agents pick from, and the status workflow. */
export function TicketSetupPanel() {
  const { can } = useSession();
  return (
    <div className={settings.stack}>
      {can('settings:categories') && <Categories />}
      {can('settings:workflow') && <WorkflowEditor />}
    </div>
  );
}

function Categories() {
  const categories = useGet<AdminCategory[]>('/categories');
  const [dialog, setDialog] = useState<
    { mode: 'add'; parent?: AdminCategory } | { mode: 'rename'; category: AdminCategory } | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const setActive = async (c: AdminCategory, isActive: boolean) => {
    setError(null);
    try {
      await api('PATCH', `/categories/${c.id}`, { isActive });
    } catch (err) {
      setError((err as Error).message);
    }
    void categories.reload();
  };

  const row = (c: AdminCategory, parent?: AdminCategory) => (
    <li
      key={c.id}
      className={`${settings.ruleRow} ${parent ? styles.child : ''}`}
      data-category={c.name}
    >
      <div className={c.isActive ? undefined : settings.dim}>
        <p className={settings.ruleName}>{c.name}</p>
        {!c.isActive && <p className={settings.muted}>Switched off: kept on old tickets only</p>}
      </div>
      <div className={settings.actions}>
        {!parent && (
          <Button size="sm" variant="ghost" onClick={() => setDialog({ mode: 'add', parent: c })}>
            Add sub-category
          </Button>
        )}
        <Button size="sm" onClick={() => setDialog({ mode: 'rename', category: c })}>
          Rename
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void setActive(c, !c.isActive)}>
          {c.isActive ? 'Switch off' : 'Switch on'}
        </Button>
      </div>
    </li>
  );

  return (
    <Card padding="md" aria-labelledby="categories-title">
      <CardHeader
        id="categories-title"
        title="Categories"
        subtitle="What a ticket is about. Customers choose a top-level category on the request form."
        actions={<Button onClick={() => setDialog({ mode: 'add' })}>Add category</Button>}
      />
      {(error ?? categories.error) && (
        <p className={settings.error} role="alert">
          {error ?? categories.error}
        </p>
      )}
      <ul className={settings.ruleList}>
        {(categories.data ?? []).flatMap((c) => [
          row(c),
          ...(c.children ?? []).map((child) => row(child, c)),
        ])}
      </ul>
      <CategoryDialog
        state={dialog}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null);
          void categories.reload();
        }}
      />
    </Card>
  );
}

function CategoryDialog({
  state,
  onClose,
  onSaved,
}: {
  state:
    { mode: 'add'; parent?: AdminCategory } | { mode: 'rename'; category: AdminCategory } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(state?.mode === 'rename' ? state.category.name : '');
    setError(null);
  }, [state]);

  const title =
    state?.mode === 'rename'
      ? `Rename “${state.category.name}”`
      : state?.parent
        ? `Add a sub-category of ${state.parent.name}`
        : 'Add a category';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!state) return;
    setError(null);
    try {
      if (state.mode === 'rename') {
        await api('PATCH', `/categories/${state.category.id}`, { name: name.trim() });
      } else {
        await api('POST', '/categories', { name: name.trim(), parentId: state.parent?.id });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Dialog open={state !== null} onClose={onClose} labelledBy="category-dialog-title">
      <form className={settings.form} onSubmit={save} aria-label="Category">
        <h2 id="category-dialog-title" className={settings.dialogTitle}>
          {title}
        </h2>
        <Input
          id="category-name"
          label="Name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          required
        />
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.formActions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

function WorkflowEditor() {
  const workflow = useGet<Workflow>('/workflow');
  const [editing, setEditing] = useState<AdminStatus | 'new' | null>(null);
  const [draft, setDraft] = useState<Transition[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statuses = useMemo(
    () => [...(workflow.data?.statuses ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [workflow.data],
  );
  const saved = useMemo<Transition[]>(
    () => (workflow.data?.transitions ?? []).map((t) => ({ from: t.fromStatus, to: t.toStatus })),
    [workflow.data],
  );
  const transitions = draft ?? saved;
  const active = statuses.filter((s) => s.isActive);
  const dirty = draft !== null && !sameTransitions(draft, saved);
  const warnings = workflowWarnings(statuses, transitions);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
    } catch (err) {
      setError((err as Error).message);
    }
    void workflow.reload();
  };

  const saveTransitions = () =>
    run(async () => {
      await api('PUT', '/workflow/transitions', { transitions });
      setDraft(null);
    }, 'Workflow saved.');

  return (
    <>
      <Card padding="md" aria-labelledby="statuses-title">
        <CardHeader
          id="statuses-title"
          title="Statuses"
          subtitle="The steps a ticket goes through. The stage decides how SLA timers and reports treat it."
          actions={<Button onClick={() => setEditing('new')}>Add status</Button>}
        />
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.scroller}>
          <table className={settings.table}>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Stage</th>
                <th scope="col">Order</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {statuses.map((s) => (
                <tr
                  key={s.key}
                  data-status={s.key}
                  className={s.isActive ? undefined : settings.dim}
                >
                  <td>
                    {s.name}
                    <span className={styles.sub}>
                      {s.key}
                      {s.isInitial ? ' · new tickets start here' : ''}
                      {s.isActive ? '' : ' · switched off'}
                    </span>
                  </td>
                  <td>{CATEGORY_LABELS[s.category] ?? s.category}</td>
                  <td className="tabular">{s.sortOrder}</td>
                  <td>
                    <div className={settings.actions}>
                      <Button size="sm" onClick={() => setEditing(s)}>
                        Edit
                      </Button>
                      {s.isActive && !s.isInitial && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Switch off “${s.name}”? Tickets already in it stay there, but no ticket can move into it.`,
                              )
                            )
                              void run(() => api('DELETE', `/workflow/statuses/${s.key}`));
                          }}
                        >
                          Switch off
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card padding="md" aria-labelledby="transitions-title">
        <CardHeader
          id="transitions-title"
          title="Allowed moves"
          subtitle="Tick the moves a ticket may make: from the status on the left to the status at the top."
          actions={
            <Button onClick={() => void saveTransitions()} disabled={!dirty}>
              Save workflow
            </Button>
          }
        />
        <div className={settings.scroller}>
          <table className={`${settings.table} ${styles.matrix}`}>
            <thead>
              <tr>
                <th scope="col">From ↓ to →</th>
                {active.map((s) => (
                  <th key={s.key} scope="col">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {active.map((from) => (
                <tr key={from.key}>
                  <th scope="row">{from.name}</th>
                  {active.map((to) => (
                    <td key={to.key}>
                      {from.key === to.key ? (
                        <span className={settings.muted} aria-hidden="true">
                          ·
                        </span>
                      ) : (
                        <input
                          type="checkbox"
                          aria-label={`${from.name} to ${to.name}`}
                          checked={hasTransition(transitions, from.key, to.key)}
                          onChange={() => {
                            setMessage(null);
                            setDraft(toggleTransition(transitions, from.key, to.key));
                          }}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {warnings.length > 0 && (
          <ul className={styles.warnings} aria-label="Workflow warnings">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {message && (
          <p className={settings.note} role="status">
            {message}
          </p>
        )}
        {dirty && (
          <div className={settings.formActions}>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Undo changes
            </Button>
          </div>
        )}
      </Card>

      <StatusDialog
        status={editing}
        taken={statuses.map((s) => s.key)}
        nextOrder={(statuses.at(-1)?.sortOrder ?? 0) + 10}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void workflow.reload();
        }}
      />
    </>
  );
}

function StatusDialog({
  status,
  taken,
  nextOrder,
  onClose,
  onSaved,
}: {
  status: AdminStatus | 'new' | null;
  taken: string[];
  nextOrder: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = status && status !== 'new' ? status : undefined;
  const [name, setName] = useState('');
  const [category, setCategory] = useState('open');
  const [sortOrder, setSortOrder] = useState('100');
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(existing?.name ?? '');
    setCategory(existing?.category ?? 'open');
    setSortOrder(String(existing?.sortOrder ?? nextOrder));
    setIsActive(existing?.isActive ?? true);
    setError(null);
  }, [status]);

  const key = existing?.key ?? statusKey(name);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!existing && taken.includes(key)) {
      setError(`A status with the key “${key}” already exists. Choose another name.`);
      return;
    }
    setError(null);
    try {
      await api('PUT', '/workflow/statuses', {
        key,
        name: name.trim(),
        category,
        sortOrder: Number(sortOrder),
        isActive,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Dialog open={status !== null} onClose={onClose} labelledBy="status-dialog-title">
      <form className={settings.form} onSubmit={save} aria-label="Status">
        <h2 id="status-dialog-title" className={settings.dialogTitle}>
          {existing ? `Edit “${existing.name}”` : 'Add a status'}
        </h2>
        <div className={settings.formRow}>
          <Input
            id="status-name"
            label="Name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Select
            id="status-category"
            label="Stage"
            value={category}
            options={STATUS_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c]! }))}
            onChange={(e) => setCategory(e.target.value)}
          />
          <Input
            id="status-order"
            label="Order in lists"
            type="number"
            min={0}
            max={10000}
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            required
          />
          {existing && !existing.isInitial && (
            <Select
              id="status-active"
              label="In use"
              value={isActive ? 'yes' : 'no'}
              options={[
                { value: 'yes', label: 'Yes' },
                { value: 'no', label: 'No' },
              ]}
              onChange={(e) => setIsActive(e.target.value === 'yes')}
            />
          )}
        </div>
        <p className={settings.note}>
          {key ? `Key: ${key}. ` : ''}
          {existing
            ? 'The key never changes, so reports and automations keep working.'
            : 'After adding it, tick the moves into and out of it under “Allowed moves”.'}
        </p>
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.formActions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!key}>
            {existing ? 'Save status' : 'Add status'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
