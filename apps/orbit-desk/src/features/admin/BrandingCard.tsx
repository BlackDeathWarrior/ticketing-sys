import type { Branding } from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Input } from '../../components/ui';
import { useGet } from '../../lib/useGet';
import settings from '../settings/Settings.module.css';

/**
 * Settings → Customers: who the helpdesk speaks for. The name appears in the
 * help center and in what the AI says; emails are signed with the team name.
 */
export function BrandingCard() {
  const saved = useGet<Branding>('/settings/branding');
  const [form, setForm] = useState<Branding | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (saved.data) setForm(saved.data);
  }, [saved.data]);

  if (!form) return saved.error ? <p className={settings.error}>{saved.error}</p> : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setError(null);
    try {
      setForm(await api<Branding>('PUT', '/settings/branding', form));
      setMessage('Saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form onSubmit={save} aria-label="Branding">
      <Card padding="md" aria-labelledby="branding-title">
        <CardHeader
          id="branding-title"
          title="Branding"
          subtitle="The company customers are talking to. It names the help center, and the AI answers on its behalf."
        />
        <div className={settings.formRow}>
          <Input
            id="brand-company"
            label="Company name"
            value={form.companyName}
            onChange={(e) => setForm({ ...form, companyName: e.target.value })}
            maxLength={80}
            required
          />
          <Input
            id="brand-support"
            label="Replies are signed by"
            value={form.supportName}
            onChange={(e) => setForm({ ...form, supportName: e.target.value })}
            maxLength={80}
            required
            hint="As in “Kind regards, Support”."
          />
          <Input
            id="brand-reference"
            label="Reference field on the request form"
            value={form.referenceLabel ?? ''}
            onChange={(e) => setForm({ ...form, referenceLabel: e.target.value || null })}
            maxLength={40}
            placeholder="No reference field"
            hint="What customers quote: “Order number”, “Listing”, “Account number”. Empty hides the field."
          />
          <Input
            id="brand-note"
            label="Line at the bottom of the help center"
            value={form.helpCenterNote}
            onChange={(e) => setForm({ ...form, helpCenterNote: e.target.value })}
            maxLength={300}
            placeholder="No line"
          />
        </div>
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
          <Button type="submit">Save branding</Button>
        </div>
      </Card>
    </form>
  );
}
