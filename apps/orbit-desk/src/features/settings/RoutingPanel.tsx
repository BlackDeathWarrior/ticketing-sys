import {
  type AgentAvailability,
  PRESENCE_STATUSES,
  PRIORITIES,
  ROUTING_STRATEGIES,
  ROUTING_STRATEGY_LABELS,
  type RoutingRuleInput,
  type RoutingRuleView,
  type RoutingStrategy,
} from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Select } from '../../components/ui';
import { channelLabels } from '../../data/adapters';
import { useGet } from '../../lib/useGet';
import styles from './Settings.module.css';

type Team = { id: string; name: string };

/** Settings → Routing: rules in order, and agents' skills and capacity (ADR 0014). */
export function RoutingPanel() {
  const rules = useGet<RoutingRuleView[]>('/routing/rules');
  const agents = useGet<AgentAvailability[]>('/routing/agents');
  const teams = useGet<Team[]>('/teams');
  const [editing, setEditing] = useState<RoutingRuleView | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      void rules.reload();
      void agents.reload();
    }
  };

  const move = (i: number, by: -1 | 1) => {
    const list = rules.data ?? [];
    const ids = list.map((r) => r.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + by, 0, id!);
    void act(() => api('PUT', '/routing/order', { ids }));
  };

  return (
    <div className={styles.stack}>
      <p className={styles.note}>
        When a ticket needs a person (a handover, or a new ticket the AI isn’t answering), the first
        matching rule picks the team; its strategy picks an online agent with room. Nobody
        available: it waits in the team queue.
      </p>
      <Card padding="md" aria-labelledby="rules-title">
        <CardHeader
          id="rules-title"
          title="Routing rules"
          subtitle="Tried top to bottom"
          actions={<Button onClick={() => setEditing('new')}>Add rule</Button>}
        />
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {rules.data?.length === 0 && (
          <p className={styles.note}>No rules: tickets stay in the queue.</p>
        )}
        <ol className={styles.ruleList}>
          {(rules.data ?? []).map((r, i) => (
            <li key={r.id} className={styles.ruleRow} data-rule={r.name}>
              <div>
                <p className={styles.ruleName}>
                  {i + 1}. {r.name}
                  {!r.enabled && <span className={styles.muted}> · off</span>}
                </p>
                <p className={styles.muted}>
                  {describeConditions(r)} → {r.team.name} · {ROUTING_STRATEGY_LABELS[r.strategy]}
                  {r.requiredSkill ? ` · needs “${r.requiredSkill}”` : ''}
                </p>
              </div>
              <div className={styles.actions}>
                <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>
                  Up
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={i === (rules.data?.length ?? 0) - 1}
                  onClick={() => move(i, 1)}
                >
                  Down
                </Button>
                <Button size="sm" onClick={() => setEditing(r)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(`Delete the rule “${r.name}”?`))
                      void act(() => api('DELETE', `/routing/rules/${r.id}`));
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card padding="md" aria-labelledby="agents-title">
        <CardHeader
          id="agents-title"
          title="Agents"
          subtitle="Presence, capacity (open tickets they can hold) and skills"
        />
        <ul className={styles.ruleList}>
          {(agents.data ?? []).map((a) => (
            <AgentRow key={a.user.id} agent={a} onChanged={() => void agents.reload()} />
          ))}
        </ul>
      </Card>

      <RuleDialog
        rule={editing}
        teams={teams.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void rules.reload();
        }}
      />
    </div>
  );
}

function describeConditions(r: RoutingRuleView): string {
  const c = r.conditions;
  const parts = [
    c.channel && (channelLabels as Record<string, string>)[c.channel],
    c.priority && `${c.priority} priority`,
    c.language && `language ${c.language}`,
    c.customerType && `${c.customerType} customers`,
    c.categoryId && 'a category',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Everything';
}

function AgentRow({ agent: a, onChanged }: { agent: AgentAvailability; onChanged: () => void }) {
  const [skills, setSkills] = useState(a.skills.join(', '));
  const [capacity, setCapacity] = useState(String(a.capacity));
  const [error, setError] = useState<string | null>(null);
  const id = `agent-${a.user.id}`;
  const save = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      onChanged();
    }
  };
  return (
    <li className={styles.agentRow} data-agent={a.user.name}>
      <div>
        <p className={styles.ruleName}>{a.user.name}</p>
        <p className={styles.muted}>
          {a.teams.join(', ') || 'No team'} · {a.openTickets} open
        </p>
      </div>
      <Select
        id={`${id}-status`}
        label="Status"
        value={a.status}
        options={PRESENCE_STATUSES.map((s) => ({
          value: s,
          label: s[0]!.toUpperCase() + s.slice(1),
        }))}
        onChange={(e) =>
          void save(() =>
            api('PUT', `/routing/agents/${a.user.id}/presence`, { status: e.target.value }),
          )
        }
      />
      <Input
        id={`${id}-capacity`}
        label="Capacity"
        type="number"
        min={0}
        max={100}
        value={capacity}
        onChange={(e) => setCapacity(e.target.value)}
        onBlur={() => {
          if (Number(capacity) !== a.capacity)
            void save(() =>
              api('PUT', `/routing/agents/${a.user.id}/presence`, {
                status: a.status,
                capacity: Number(capacity),
              }),
            );
        }}
      />
      <Input
        id={`${id}-skills`}
        label="Skills"
        placeholder="e.g. hindi, billing"
        value={skills}
        onChange={(e) => setSkills(e.target.value)}
        onBlur={() => {
          const list = skills
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (list.join(',') !== a.skills.join(','))
            void save(() => api('PUT', `/routing/agents/${a.user.id}/skills`, { skills: list }));
        }}
      />
      {error && <p className={styles.error}>{error}</p>}
    </li>
  );
}

function RuleDialog({
  rule,
  teams,
  onClose,
  onSaved,
}: {
  rule: RoutingRuleView | 'new' | null;
  teams: Team[];
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={rule !== null} onClose={onClose} labelledBy="rule-title">
      {rule !== null && (
        <RuleForm
          key={rule === 'new' ? 'new' : rule.id}
          rule={rule === 'new' ? null : rule}
          teams={teams}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function RuleForm({
  rule,
  teams,
  onClose,
  onSaved,
}: {
  rule: RoutingRuleView | null;
  teams: Team[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [v, setV] = useState({
    name: rule?.name ?? '',
    teamId: rule?.team.id ?? teams[0]?.id ?? '',
    strategy: (rule?.strategy ?? 'least_loaded') as RoutingStrategy,
    requiredSkill: rule?.requiredSkill ?? '',
    enabled: rule?.enabled ?? true,
    channel: rule?.conditions.channel ?? '',
    priority: rule?.conditions.priority ?? '',
    language: rule?.conditions.language ?? '',
    customerType: rule?.conditions.customerType ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (value: string | boolean) =>
    setV((x) => ({ ...x, [k]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const conditions = Object.fromEntries(
      (['channel', 'priority', 'language', 'customerType'] as const)
        .filter((k) => v[k])
        .map((k) => [k, v[k]]),
    );
    const body: RoutingRuleInput = {
      name: v.name,
      teamId: v.teamId,
      strategy: v.strategy,
      requiredSkill: v.requiredSkill || null,
      enabled: v.enabled,
      conditions,
    };
    try {
      await api(rule ? 'PUT' : 'POST', rule ? `/routing/rules/${rule.id}` : '/routing/rules', body);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Routing rule">
      <h2 id="rule-title" className={styles.dialogTitle}>
        {rule ? 'Edit rule' : 'Add a routing rule'}
      </h2>
      <div className={styles.formRow}>
        <Input
          id="rule-name"
          label="Name"
          required
          value={v.name}
          onChange={(e) => set('name')(e.target.value)}
        />
        <Select
          id="rule-team"
          label="Team"
          value={v.teamId}
          onChange={(e) => set('teamId')(e.target.value)}
          options={teams.map((t) => ({ value: t.id, label: t.name }))}
        />
        <Select
          id="rule-strategy"
          label="Pick"
          value={v.strategy}
          onChange={(e) => set('strategy')(e.target.value)}
          options={ROUTING_STRATEGIES.map((s) => ({ value: s, label: ROUTING_STRATEGY_LABELS[s] }))}
        />
        <Input
          id="rule-skill"
          label="Needs skill (optional)"
          value={v.requiredSkill}
          onChange={(e) => set('requiredSkill')(e.target.value)}
        />
      </div>
      <p className={styles.note}>Applies when all of these match (leave empty for any):</p>
      <div className={styles.formRow}>
        <Select
          id="rule-channel"
          label="Channel"
          value={v.channel}
          onChange={(e) => set('channel')(e.target.value)}
          options={[
            { value: '', label: 'Any' },
            ...Object.entries(channelLabels).map(([value, label]) => ({ value, label })),
          ]}
        />
        <Select
          id="rule-priority"
          label="Priority"
          value={v.priority}
          onChange={(e) => set('priority')(e.target.value)}
          options={[
            { value: '', label: 'Any' },
            ...PRIORITIES.map((p) => ({ value: p, label: p })),
          ]}
        />
        <Input
          id="rule-language"
          label="Language code"
          placeholder="e.g. hi"
          value={v.language}
          onChange={(e) => set('language')(e.target.value)}
        />
        <Input
          id="rule-customer"
          label="Customer type"
          placeholder="e.g. vip"
          value={v.customerType}
          onChange={(e) => set('customerType')(e.target.value)}
        />
      </div>
      <Select
        id="rule-enabled"
        label="On"
        value={v.enabled ? 'yes' : 'no'}
        onChange={(e) => set('enabled')(e.target.value === 'yes')}
        options={[
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ]}
      />
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.formActions}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!v.name.trim() || !v.teamId}>
          Save rule
        </Button>
      </div>
    </form>
  );
}
