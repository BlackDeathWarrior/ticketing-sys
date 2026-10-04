import {
  EXAMPLE_PRIORITY_RULES,
  PRIORITIES,
  type Priority,
  type PriorityRule,
  type PriorityRules,
} from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Input, Select } from '../../components/ui';
import { useGet } from '../../lib/useGet';
import styles from './Settings.module.css';

const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

const SENTIMENT_OPTIONS = [
  { value: '', label: 'Any mood' },
  { value: 'negative', label: 'Upset' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'positive', label: 'Happy' },
];

const newRule = (): PriorityRule => ({
  id: 'new',
  name: 'New rule',
  enabled: true,
  conditions: { keywords: [] },
  priority: 'high',
});

/** The words of a keyword list, one phrase per comma. */
const words = (s: string) =>
  s
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);

/**
 * Settings → Priority (ADR 0032): what makes a ticket urgent, high, normal or
 * low. The first rule a ticket matches gives its priority when it is opened;
 * after that, rules only raise it (once the AI knows the intent and mood,
 * and when the customer writes again). The SLA follows the priority.
 */
export function PriorityPanel() {
  const current = useGet<PriorityRules>('/settings/priority-rules');
  const [rules, setRules] = useState<PriorityRule[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (current.data) setRules(current.data.rules);
  }, [current.data]);

  const change = (i: number, patch: Partial<PriorityRule>) =>
    rules && setRules(rules.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const conditions = (i: number, patch: Partial<PriorityRule['conditions']>) => {
    if (!rules) return;
    const next = { ...rules[i]!.conditions, ...patch };
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) {
        delete (next as Record<string, unknown>)[k];
      }
    }
    change(i, { conditions: next });
  };
  const move = (i: number, by: -1 | 1) => {
    if (!rules) return;
    const j = i + by;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setRules(next);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!rules) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api<PriorityRules>('PUT', '/settings/priority-rules', { rules });
      setRules(saved.rules);
      setMessage('Saved. New tickets and replies use these rules.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.stack}>
      <Card padding="md">
        <CardHeader
          title="Priority rules"
          subtitle="The first rule a ticket matches sets its priority when it is opened. After that a rule only raises it: when the AI has worked out what the customer wants and how they feel, and when they write again. A priority someone lowered by hand is not raised back by the same message."
          actions={
            <Button
              variant="secondary"
              onClick={() =>
                rules &&
                setRules([...rules, ...EXAMPLE_PRIORITY_RULES.map((r) => ({ ...r, id: 'new' }))])
              }
            >
              Add examples
            </Button>
          }
        />
        {current.error && <p className={styles.error}>{current.error}</p>}
        {rules && (
          <form className={styles.form} onSubmit={save} aria-label="Priority rules">
            {rules.length === 0 && (
              <p className={styles.note}>
                No rules yet: every ticket starts as Normal, and only the AI's classification and
                people change it.
              </p>
            )}
            <ol className={styles.ruleList}>
              {rules.map((r, i) => (
                <li key={`${r.id}-${i}`} className={styles.ruleRow} data-rule={r.name}>
                  <div className={styles.form}>
                    <div className={styles.formRow}>
                      <Input
                        id={`prio-name-${i}`}
                        label={`Rule ${i + 1}`}
                        value={r.name}
                        maxLength={80}
                        onChange={(e) => change(i, { name: e.target.value })}
                      />
                      <Select
                        id={`prio-priority-${i}`}
                        label="Gives the priority"
                        value={r.priority}
                        options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
                        onChange={(e) => change(i, { priority: e.target.value as Priority })}
                      />
                    </div>
                    <Input
                      id={`prio-words-${i}`}
                      label="When the subject or message has any of these words (comma between phrases)"
                      value={(r.conditions.keywords ?? []).join(', ')}
                      onChange={(e) => conditions(i, { keywords: words(e.target.value) })}
                    />
                    <div className={styles.formRow}>
                      <Input
                        id={`prio-intent-${i}`}
                        label="And what they want includes (optional, e.g. refund)"
                        value={r.conditions.intent ?? ''}
                        onChange={(e) => conditions(i, { intent: e.target.value || undefined })}
                      />
                      <Select
                        id={`prio-mood-${i}`}
                        label="And their mood is"
                        value={r.conditions.sentiment ?? ''}
                        options={SENTIMENT_OPTIONS}
                        onChange={(e) =>
                          conditions(i, {
                            sentiment: (e.target.value || undefined) as
                              'positive' | 'neutral' | 'negative' | undefined,
                          })
                        }
                      />
                    </div>
                    <div className={styles.formRow}>
                      <Input
                        id={`prio-meta-key-${i}`}
                        label="And the app sent (field name, optional)"
                        value={r.conditions.metadata?.key ?? ''}
                        onChange={(e) =>
                          conditions(i, {
                            metadata: e.target.value
                              ? { key: e.target.value, value: r.conditions.metadata?.value ?? '' }
                              : undefined,
                          })
                        }
                      />
                      <Input
                        id={`prio-meta-value-${i}`}
                        label="with the value"
                        value={r.conditions.metadata?.value ?? ''}
                        disabled={!r.conditions.metadata}
                        onChange={(e) =>
                          r.conditions.metadata &&
                          conditions(i, {
                            metadata: { key: r.conditions.metadata.key, value: e.target.value },
                          })
                        }
                      />
                    </div>
                    <label className={styles.check}>
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={(e) => change(i, { enabled: e.target.checked })}
                      />
                      On
                    </label>
                  </div>
                  <div className={styles.actions}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                    >
                      Up
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => move(i, 1)}
                      disabled={i === rules.length - 1}
                    >
                      Down
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRules(rules.filter((_, n) => n !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
            <div className={styles.formActions}>
              <Button variant="secondary" onClick={() => setRules([...rules, newRule()])}>
                Add rule
              </Button>
              <Button type="submit" disabled={saving}>
                Save priority rules
              </Button>
            </div>
            {message && (
              <p className={styles.note} role="status">
                {message}
              </p>
            )}
          </form>
        )}
      </Card>
      <TryRules />
    </div>
  );
}

/** Which rule a made-up message would match, with the rules as saved. */
function TryRules() {
  const [text, setText] = useState('My payment failed but the money was deducted');
  const [result, setResult] = useState<{ priority: Priority | null; rule: string | null } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const run = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setResult(await api('POST', '/settings/priority-rules/test', { text }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Card padding="md">
      <CardHeader title="Try a message" subtitle="Uses the rules as saved." />
      <form className={styles.form} onSubmit={run} aria-label="Try priority rules">
        <Input
          id="prio-try"
          label="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className={styles.formActions}>
          <Button type="submit">Try</Button>
        </div>
        {error && <p className={styles.error}>{error}</p>}
        {result && (
          <p className={styles.note} role="status">
            {result.priority
              ? `${PRIORITY_LABELS[result.priority]}, from the rule “${result.rule}”.`
              : 'No rule matches: the ticket would start as Normal.'}
          </p>
        )}
      </form>
    </Card>
  );
}
