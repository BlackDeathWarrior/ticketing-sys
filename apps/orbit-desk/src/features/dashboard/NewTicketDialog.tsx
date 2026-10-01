import { PRIORITIES } from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api, qs } from '../../api/client';
import { initials, type ApiTicket } from '../../data/adapters';
import type { Priority } from '../../data/types';
import { useGet } from '../../lib/useGet';
import { cx } from '../../lib/format';
import { priorityLabels } from '../../components/ui/PriorityGlyph';
import { Avatar, Button, Dialog, Input, Select, Textarea } from '../../components/ui';
import styles from './NewTicketDialog.module.css';

interface NewTicketDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (ticketId: string) => void;
}

interface CustomerHit {
  id: string;
  displayName: string;
  primaryEmail: string | null;
}

/** Channels an agent can log a ticket for by hand. */
const MANUAL_CHANNELS = [
  { value: 'agent', label: 'Logged by agent' },
  { value: 'voice', label: 'Phone call' },
  { value: 'email', label: 'Email' },
];

export function NewTicketDialog({ open, onClose, onCreated }: NewTicketDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="new-ticket-title" padded={false}>
      {open && <NewTicketForm onClose={onClose} onCreated={onCreated} />}
    </Dialog>
  );
}

function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function NewTicketForm({ onClose, onCreated }: Omit<NewTicketDialogProps, 'open'>) {
  const [subject, setSubject] = useState('');
  const [customerQuery, setCustomerQuery] = useState('');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newCompany, setNewCompany] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [channel, setChannel] = useState('agent');
  const [tags, setTags] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const q = useDebounced(customerQuery.trim());
  const hits = useGet<{ items: CustomerHit[] }>(
    !customer && !creatingCustomer && q.length >= 2 ? `/customers${qs({ q, limit: 5 })}` : null,
  );

  const hasCustomer = creatingCustomer ? newName.trim().length > 0 : customer !== null;
  const valid = subject.trim().length > 0 && hasCustomer;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      let customerId = customer?.id;
      if (creatingCustomer) {
        const created = await api<{ id: string }>('POST', '/customers', {
          displayName: newName.trim(),
          ...(newEmail.trim() ? { email: newEmail.trim() } : {}),
          attributes: newCompany.trim() ? { company: newCompany.trim() } : {},
        });
        customerId = created.id;
      }
      const ticket = await api<ApiTicket>('POST', '/tickets', {
        customerId,
        subject: subject.trim(),
        priority,
        channel,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        ...(body.trim() ? { description: body.trim() } : {}),
      });
      onCreated(ticket.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <header className={styles.header}>
        <h2 id="new-ticket-title" className={styles.title}>
          New ticket
        </h2>
        <p className={styles.subtitle}>
          Log a request on behalf of a customer. It lands in the queue unassigned.
        </p>
      </header>

      <div className={styles.fields}>
        <Input
          id="nt-subject"
          label="Subject"
          placeholder="What does the customer need?"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
          autoFocus
        />

        {creatingCustomer ? (
          <div className={styles.newCustomer}>
            <div className={styles.pair}>
              <Input
                id="nt-name"
                label="Customer name"
                placeholder="Full name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
              />
              <Input
                id="nt-company"
                label="Company"
                placeholder="Organisation"
                value={newCompany}
                onChange={(e) => setNewCompany(e.target.value)}
              />
            </div>
            <Input
              id="nt-email"
              label="Email"
              type="email"
              placeholder="name@company.com"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
            <Button variant="link" size="sm" onClick={() => setCreatingCustomer(false)}>
              Pick an existing customer instead
            </Button>
          </div>
        ) : customer ? (
          <div className={styles.picked}>
            <Avatar initials={initials(customer.displayName)} size={28} />
            <span className={styles.pickedText}>
              <span>{customer.displayName}</span>
              {customer.primaryEmail && (
                <span className={styles.muted}>{customer.primaryEmail}</span>
              )}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setCustomer(null)}>
              Change
            </Button>
          </div>
        ) : (
          <div className={styles.lookup}>
            <Input
              id="nt-customer"
              label="Customer"
              placeholder="Search by name, email or phone"
              value={customerQuery}
              onChange={(e) => setCustomerQuery(e.target.value)}
              autoComplete="off"
            />
            {q.length >= 2 && (
              <ul className={styles.hits} aria-label="Matching customers">
                {(hits.data?.items ?? []).map((c) => (
                  <li key={c.id}>
                    <button type="button" className={styles.hit} onClick={() => setCustomer(c)}>
                      <span>{c.displayName}</span>
                      {c.primaryEmail && <span className={styles.muted}>{c.primaryEmail}</span>}
                    </button>
                  </li>
                ))}
                {hits.data && hits.data.items.length === 0 && (
                  <li className={cx(styles.muted, styles.noHits)}>No customer matches “{q}”.</li>
                )}
              </ul>
            )}
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                setCreatingCustomer(true);
                setNewName(customerQuery.trim());
              }}
            >
              New customer
            </Button>
          </div>
        )}

        <div className={styles.pair}>
          <Select
            id="nt-priority"
            label="Priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            options={PRIORITIES.map((p) => ({ value: p, label: priorityLabels[p] }))}
          />
          <Select
            id="nt-channel"
            label="Channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            options={MANUAL_CHANNELS}
          />
        </div>
        <Input
          id="nt-tags"
          label="Tags"
          placeholder="Comma separated, e.g. refund, vip"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
        <Textarea
          id="nt-body"
          label="Description"
          placeholder="Paste the customer's message or summarise the call…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
        />
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>

      <footer className={styles.footer}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="secondary" icon="plus" disabled={!valid || busy}>
          {busy ? 'Creating…' : 'Create ticket'}
        </Button>
      </footer>
    </form>
  );
}
