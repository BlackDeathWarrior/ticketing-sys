import {
  type BusinessHoursInput,
  type BusinessHoursView,
  PRIORITIES,
  type SlaPolicyInput,
  type SlaPolicyView,
} from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Select, Textarea } from '../../components/ui';
import { useGet } from '../../lib/useGet';
import styles from './Settings.module.css';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ZONES = [
  'Asia/Kolkata',
  'Europe/Berlin',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
];

export const minutesText = (m: number) =>
  m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;

/** Settings → SLA: targets per priority and customer type, and the hours they count in. */
export function SlaSettingsPanel() {
  const policies = useGet<SlaPolicyView[]>('/sla/policies');
  const hours = useGet<BusinessHoursView[]>('/sla/business-hours');
  const [policy, setPolicy] = useState<SlaPolicyView | 'new' | null>(null);
  const [editHours, setEditHours] = useState<BusinessHoursView | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    void policies.reload();
    void hours.reload();
  };
  const remove = async (path: string) => {
    setError(null);
    try {
      await api('DELETE', path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      reload();
    }
  };

  return (
    <div className={styles.stack}>
      <p className={styles.note}>
        Each ticket gets the most specific policy that fits its priority and customer type. Timers
        count only business hours, pause while waiting on the customer, and warn at 80%.
      </p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <Card padding="md" aria-labelledby="policies-title">
        <CardHeader
          id="policies-title"
          title="Policies"
          actions={<Button onClick={() => setPolicy('new')}>Add policy</Button>}
        />
        <ul className={styles.ruleList}>
          {(policies.data ?? []).map((p) => (
            <li key={p.id} className={styles.ruleRow} data-policy={p.name}>
              <div>
                <p className={styles.ruleName}>
                  {p.name}
                  {!p.enabled && <span className={styles.muted}> · off</span>}
                </p>
                <p className={styles.muted}>
                  {[
                    p.priority && `${p.priority} priority`,
                    p.customerType && `${p.customerType} customers`,
                  ]
                    .filter(Boolean)
                    .join(', ') || 'Any ticket'}{' '}
                  · first response {minutesText(p.firstResponseMinutes)} · resolution{' '}
                  {minutesText(p.resolutionMinutes)} ·{' '}
                  {p.businessHours
                    ? `${p.businessHours.name} (${p.businessHours.timezone})`
                    : 'around the clock'}
                </p>
              </div>
              <div className={styles.actions}>
                <Button size="sm" onClick={() => setPolicy(p)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(`Delete the policy “${p.name}”?`))
                      void remove(`/sla/policies/${p.id}`);
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card padding="md" aria-labelledby="hours-title">
        <CardHeader
          id="hours-title"
          title="Business hours"
          actions={<Button onClick={() => setEditHours('new')}>Add hours</Button>}
        />
        <ul className={styles.ruleList}>
          {(hours.data ?? []).map((h) => (
            <li key={h.id} className={styles.ruleRow} data-hours={h.name}>
              <div>
                <p className={styles.ruleName}>{h.name}</p>
                <p className={styles.muted}>
                  {h.timezone} · {scheduleText(h)} · {h.holidays.length} holiday
                  {h.holidays.length === 1 ? '' : 's'}
                </p>
              </div>
              <div className={styles.actions}>
                <Button size="sm" onClick={() => setEditHours(h)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(`Delete “${h.name}”?`))
                      void remove(`/sla/business-hours/${h.id}`);
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Dialog open={policy !== null} onClose={() => setPolicy(null)} labelledBy="policy-title">
        {policy !== null && (
          <PolicyForm
            key={policy === 'new' ? 'new' : policy.id}
            policy={policy === 'new' ? null : policy}
            hours={hours.data ?? []}
            onClose={() => setPolicy(null)}
            onSaved={() => {
              setPolicy(null);
              reload();
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={editHours !== null}
        onClose={() => setEditHours(null)}
        labelledBy="hours-form-title"
      >
        {editHours !== null && (
          <HoursForm
            key={editHours === 'new' ? 'new' : editHours.id}
            hours={editHours === 'new' ? null : editHours}
            onClose={() => setEditHours(null)}
            onSaved={() => {
              setEditHours(null);
              reload();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

function scheduleText(h: BusinessHoursView): string {
  if (!h.schedule.length) return 'always open';
  const first = h.schedule[0]!;
  const same = h.schedule.every((w) => w.start === first.start && w.end === first.end);
  const days = [...new Set(h.schedule.map((w) => DAYS[w.day]))].join(', ');
  return same ? `${days} ${first.start}–${first.end}` : `${h.schedule.length} windows`;
}

function PolicyForm({
  policy,
  hours,
  onClose,
  onSaved,
}: {
  policy: SlaPolicyView | null;
  hours: BusinessHoursView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [v, setV] = useState({
    name: policy?.name ?? '',
    priority: policy?.priority ?? '',
    customerType: policy?.customerType ?? '',
    first: String(policy?.firstResponseMinutes ?? 60),
    resolution: String(policy?.resolutionMinutes ?? 480),
    hoursId: policy?.businessHours?.id ?? '',
    enabled: policy?.enabled ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: SlaPolicyInput = {
      name: v.name,
      priority: (v.priority || null) as SlaPolicyInput['priority'],
      customerType: v.customerType || null,
      firstResponseMinutes: Number(v.first),
      resolutionMinutes: Number(v.resolution),
      businessHoursId: v.hoursId || null,
      enabled: v.enabled,
    };
    try {
      await api(
        policy ? 'PUT' : 'POST',
        policy ? `/sla/policies/${policy.id}` : '/sla/policies',
        body,
      );
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className={styles.form} onSubmit={submit} aria-label="SLA policy">
      <h2 id="policy-title" className={styles.dialogTitle}>
        {policy ? 'Edit policy' : 'Add an SLA policy'}
      </h2>
      <div className={styles.formRow}>
        <Input
          id="policy-name"
          label="Name"
          required
          value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
        />
        <Select
          id="policy-priority"
          label="Priority"
          value={v.priority}
          onChange={(e) => setV({ ...v, priority: e.target.value })}
          options={[
            { value: '', label: 'Any' },
            ...PRIORITIES.map((p) => ({ value: p, label: p })),
          ]}
        />
        <Input
          id="policy-customer"
          label="Customer type"
          placeholder="Any, or e.g. vip"
          value={v.customerType}
          onChange={(e) => setV({ ...v, customerType: e.target.value })}
        />
        <Input
          id="policy-first"
          label="First response (minutes)"
          type="number"
          min={1}
          required
          value={v.first}
          onChange={(e) => setV({ ...v, first: e.target.value })}
        />
        <Input
          id="policy-resolution"
          label="Resolution (minutes)"
          type="number"
          min={1}
          required
          value={v.resolution}
          onChange={(e) => setV({ ...v, resolution: e.target.value })}
        />
        <Select
          id="policy-hours"
          label="Counts in"
          value={v.hoursId}
          onChange={(e) => setV({ ...v, hoursId: e.target.value })}
          options={[
            { value: '', label: 'Around the clock' },
            ...hours.map((h) => ({ value: h.id, label: `${h.name} (${h.timezone})` })),
          ]}
        />
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.formActions}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!v.name.trim()}>
          Save policy
        </Button>
      </div>
    </form>
  );
}

function HoursForm({
  hours,
  onClose,
  onSaved,
}: {
  hours: BusinessHoursView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const first = hours?.schedule[0];
  const [name, setName] = useState(hours?.name ?? '');
  const [timezone, setTimezone] = useState(hours?.timezone ?? 'Asia/Kolkata');
  const [days, setDays] = useState<number[]>(
    hours ? [...new Set(hours.schedule.map((w) => w.day))] : [1, 2, 3, 4, 5],
  );
  const [start, setStart] = useState(first?.start ?? '09:00');
  const [end, setEnd] = useState(first?.end ?? '18:00');
  const [holidayText, setHolidayText] = useState(
    (hours?.holidays ?? []).map((d) => `${d.date} ${d.name}`).join('\n'),
  );
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const holidays = holidayText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ date: l.slice(0, 10), name: l.slice(10).trim() || 'Holiday' }));
    const body: BusinessHoursInput = {
      name,
      timezone,
      schedule: days.sort().map((day) => ({ day, start, end })),
      holidays,
    };
    try {
      await api(
        hours ? 'PUT' : 'POST',
        hours ? `/sla/business-hours/${hours.id}` : '/sla/business-hours',
        body,
      );
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Business hours">
      <h2 id="hours-form-title" className={styles.dialogTitle}>
        {hours ? 'Edit business hours' : 'Add business hours'}
      </h2>
      <div className={styles.formRow}>
        <Input
          id="hours-name"
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          id="hours-zone"
          label="Time zone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          options={[...new Set([timezone, ...ZONES])].map((z) => ({ value: z, label: z }))}
        />
        <Input
          id="hours-start"
          label="Opens"
          type="time"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <Input
          id="hours-end"
          label="Closes"
          type="time"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
      </div>
      <fieldset className={styles.days}>
        <legend className={styles.note}>Open on</legend>
        {DAYS.map((d, i) => (
          <label key={d} className={styles.check}>
            <input
              type="checkbox"
              checked={days.includes(i)}
              onChange={(e) =>
                setDays((x) => (e.target.checked ? [...x, i] : x.filter((y) => y !== i)))
              }
            />
            {d}
          </label>
        ))}
      </fieldset>
      <Textarea
        id="hours-holidays"
        label="Holidays (one per line: YYYY-MM-DD Name)"
        rows={3}
        value={holidayText}
        onChange={(e) => setHolidayText(e.target.value)}
      />
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.formActions}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          Save hours
        </Button>
      </div>
    </form>
  );
}
