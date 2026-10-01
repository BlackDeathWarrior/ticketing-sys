import { type CustomerExperience, CSAT_WINDOW_DAYS, PORTAL_LINK_MINUTES } from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Input, Select } from '../../components/ui';
import { useGet } from '../../lib/useGet';
import settings from '../settings/Settings.module.css';

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

/** Settings → Customers: the portal ("My requests") and asking for ratings. */
export function CustomersPanel() {
  const saved = useGet<CustomerExperience>('/settings/customer-experience');
  const [form, setForm] = useState<CustomerExperience | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (saved.data) setForm(saved.data);
  }, [saved.data]);

  if (!form) return saved.error ? <p className={settings.error}>{saved.error}</p> : null;

  const yesNo = (key: 'portalEnabled' | 'csatByEmail' | 'csatInChat', label: string) => (
    <Select
      id={`cx-${key}`}
      label={label}
      value={form[key] ? 'yes' : 'no'}
      options={YES_NO}
      onChange={(e) => setForm({ ...form, [key]: e.target.value === 'yes' })}
    />
  );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setError(null);
    try {
      setForm(await api<CustomerExperience>('PUT', '/settings/customer-experience', form));
      setMessage('Saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className={settings.stack} onSubmit={save} aria-label="Customer settings">
      <Card padding="md" aria-labelledby="portal-title">
        <CardHeader
          id="portal-title"
          title="Customer portal"
          subtitle={`“My requests” in the help center. Customers sign in with a link sent to their email (it works once, for ${PORTAL_LINK_MINUTES} minutes), then see and answer their own tickets from every channel.`}
        />
        <div className={settings.formRow}>{yesNo('portalEnabled', 'Portal on')}</div>
        <p className={settings.note}>
          Sign-in links are sent from the support mailbox, so the email channel must be working.
        </p>
      </Card>

      <Card padding="md" aria-labelledby="ratings-title">
        <CardHeader
          id="ratings-title"
          title="Ratings"
          subtitle={`When a ticket is solved, the customer is asked once to rate it from 1 to 5. They can rate for ${CSAT_WINDOW_DAYS} days. Only customers can rate; agents see the result on the ticket.`}
        />
        <div className={settings.formRow}>
          {yesNo('csatByEmail', 'Ask by email (email and request-form tickets)')}
          {yesNo('csatInChat', 'Ask in the chat window (web chat tickets)')}
        </div>
        <p className={settings.note}>
          Customers can always rate a solved request in the portal. A rating of 1 or 2 notifies the
          assignee and team leads.
        </p>
      </Card>

      <Card padding="md" aria-labelledby="estimate-title">
        <CardHeader
          id="estimate-title"
          title="Time-saved estimate"
          subtitle="Reports estimate the agent time the AI saved as: tickets the AI resolved alone × this many minutes."
        />
        <div className={settings.formRow}>
          <Input
            id="cx-minutes"
            label="Minutes of agent work per ticket"
            type="number"
            min={1}
            max={240}
            value={String(form.agentMinutesPerTicket)}
            onChange={(e) => setForm({ ...form, agentMinutesPerTicket: Number(e.target.value) })}
            required
          />
        </div>
      </Card>

      {error && (
        <p className={settings.error} role="alert">
          {error}
        </p>
      )}
      <div className={settings.formActions}>
        {message && (
          <p className={settings.note} role="status">
            {message}
          </p>
        )}
        <Button type="submit">Save settings</Button>
      </div>
    </form>
  );
}
