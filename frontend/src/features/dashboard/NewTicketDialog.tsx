import { useState, type FormEvent } from 'react';
import type { Channel, Priority, Ticket } from '../../data/types';
import { Button, Dialog, Input, Select, Textarea } from '../../components/ui';
import styles from './NewTicketDialog.module.css';

interface NewTicketDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (ticket: Omit<Ticket, 'id'>) => void;
}

const slaTargets: Record<Priority, number> = { urgent: 30, high: 120, medium: 480, low: 1440 };

export function NewTicketDialog({ open, onClose, onCreate }: NewTicketDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} labelledBy="new-ticket-title">
      <NewTicketForm onClose={onClose} onCreate={onCreate} />
    </Dialog>
  );
}

function NewTicketForm({ onClose, onCreate }: Omit<NewTicketDialogProps, 'open'>) {
  const [subject, setSubject] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [channel, setChannel] = useState<Channel>('email');
  const [body, setBody] = useState('');

  const valid = subject.trim() && name.trim() && company.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const [first, last = ''] = name.trim().split(' ');
    onCreate({
      subject: subject.trim(),
      customer: {
        name: name.trim(),
        company: company.trim(),
        email: `${first.toLowerCase()}@${company.toLowerCase().replace(/[^a-z]/g, '') || 'example'}.com`,
        initials: `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase(),
        plan: 'Growth',
      },
      status: 'open',
      priority,
      assigneeId: null,
      channel,
      tags: [],
      updatedMinutesAgo: 0,
      slaMinutes: slaTargets[priority],
      messages: body.trim()
        ? [{ id: 'm1', kind: 'customer', author: name.trim(), initials: `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase(), body: body.trim(), minutesAgo: 0 }]
        : [],
    });
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <header className={styles.header}>
        <h2 id="new-ticket-title" className={styles.title}>
          New ticket
        </h2>
        <p className={styles.subtitle}>Log a request on behalf of a customer. It lands in the queue unassigned.</p>
      </header>

      <div className={styles.fields}>
        <Input id="nt-subject" label="Subject" placeholder="What does the customer need?" value={subject} onChange={(e) => setSubject(e.target.value)} required autoFocus />
        <div className={styles.pair}>
          <Input id="nt-name" label="Customer" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input id="nt-company" label="Company" placeholder="Organisation" value={company} onChange={(e) => setCompany(e.target.value)} required />
        </div>
        <div className={styles.pair}>
          <Select
            id="nt-priority"
            label="Priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            options={[
              { value: 'urgent', label: 'Urgent — 30m SLA' },
              { value: 'high', label: 'High — 2h SLA' },
              { value: 'medium', label: 'Medium — 8h SLA' },
              { value: 'low', label: 'Low — 24h SLA' },
            ]}
          />
          <Select
            id="nt-channel"
            label="Channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as Channel)}
            options={[
              { value: 'email', label: 'Email' },
              { value: 'chat', label: 'Live chat' },
              { value: 'phone', label: 'Phone' },
              { value: 'web', label: 'Web form' },
            ]}
          />
        </div>
        <Textarea id="nt-body" label="Description" placeholder="Paste the customer's message or summarise the call…" value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
      </div>

      <footer className={styles.footer}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="secondary" icon="plus" disabled={!valid}>
          Create ticket
        </Button>
      </footer>
    </form>
  );
}
