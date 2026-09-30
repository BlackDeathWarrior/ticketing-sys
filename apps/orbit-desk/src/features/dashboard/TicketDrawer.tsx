import { Fragment, useState } from 'react';
import { agentById, agents, currentAgentId } from '../../data/mock';
import type { Message, Priority, Ticket, TicketStatus } from '../../data/types';
import { cx, relativeTime } from '../../lib/format';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Icon,
  Select,
  SlaIndicator,
  StatusGlyph,
  StatusPill,
  Tabs,
  Textarea,
  priorityLabels,
  statusLabels,
} from '../../components/ui';
import styles from './TicketDrawer.module.css';

interface TicketDrawerProps {
  ticket: Ticket | null;
  onClose: () => void;
  onUpdate: (id: string, patch: Partial<Ticket>) => void;
}

const statuses: TicketStatus[] = ['open', 'in_progress', 'waiting', 'resolved'];
const channelLabels = {
  email: 'Email',
  chat: 'Live chat',
  phone: 'Phone',
  web: 'Web form',
} as const;

/** Highlight @mentions in the accent color (DESIGN.md › Testimonial Card). */
function withMentions(text: string) {
  return text.split(/(@\w+)/g).map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} className={styles.mention}>
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

export function TicketDrawer({ ticket, onClose, onUpdate }: TicketDrawerProps) {
  return (
    <Dialog open={ticket !== null} onClose={onClose} variant="drawer" labelledBy="drawer-title">
      {ticket && (
        <DrawerContent key={ticket.id} ticket={ticket} onClose={onClose} onUpdate={onUpdate} />
      )}
    </Dialog>
  );
}

function DrawerContent({
  ticket,
  onClose,
  onUpdate,
}: {
  ticket: Ticket;
  onClose: () => void;
  onUpdate: TicketDrawerProps['onUpdate'];
}) {
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [draft, setDraft] = useState('');

  const send = (e: { preventDefault(): void }) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    const me = agentById(currentAgentId)!;
    const message: Message = {
      id: `m${ticket.messages.length + 1}-${Date.now()}`,
      kind: mode === 'note' ? 'note' : 'agent',
      author: me.name,
      initials: me.initials,
      body,
      minutesAgo: 0,
    };
    onUpdate(ticket.id, {
      messages: [...ticket.messages, message],
      updatedMinutesAgo: 0,
      status: mode === 'reply' && ticket.status === 'open' ? 'waiting' : ticket.status,
      assigneeId: ticket.assigneeId ?? currentAgentId,
    });
    setDraft('');
  };

  return (
    <>
      <header className={styles.header}>
        <div className={styles.topline}>
          <span className={styles.id}>{ticket.id}</span>
          <StatusPill status={ticket.status} />
          <span className={styles.spacer} />
          <Button variant="ghost" size="sm" icon="x" iconOnly onClick={onClose} autoFocus>
            Close ticket panel
          </Button>
        </div>
        <h2 id="drawer-title" className={styles.title}>
          {ticket.subject}
        </h2>
        <div className={styles.tags}>
          {ticket.tags.map((tag) => (
            <Badge key={tag}>#{tag}</Badge>
          ))}
        </div>
      </header>

      <div className={styles.scroll}>
        <section className={styles.controls} aria-label="Ticket properties">
          <div className={styles.statusGroup} role="radiogroup" aria-label="Status">
            {statuses.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={ticket.status === s}
                className={cx(styles.statusOption, ticket.status === s && styles.statusActive)}
                onClick={() =>
                  onUpdate(ticket.id, {
                    status: s,
                    slaMinutes: s === 'resolved' ? null : (ticket.slaMinutes ?? 480),
                  })
                }
              >
                <StatusGlyph status={s} />
                {statusLabels[s]}
              </button>
            ))}
          </div>

          <div className={styles.selects}>
            <Select
              id="drawer-priority"
              label="Priority"
              value={ticket.priority}
              onChange={(e) => onUpdate(ticket.id, { priority: e.target.value as Priority })}
              options={(Object.keys(priorityLabels) as Priority[]).map((p) => ({
                value: p,
                label: priorityLabels[p],
              }))}
            />
            <Select
              id="drawer-assignee"
              label="Assignee"
              value={ticket.assigneeId ?? ''}
              onChange={(e) => onUpdate(ticket.id, { assigneeId: e.target.value || null })}
              options={[
                { value: '', label: 'Unassigned' },
                ...agents.map((a) => ({ value: a.id, label: `${a.name} · ${a.team}` })),
              ]}
            />
          </div>

          <dl className={styles.meta}>
            <div>
              <dt>Customer</dt>
              <dd className={styles.customerCell}>
                <Avatar initials={ticket.customer.initials} size={20} />
                {ticket.customer.name}
              </dd>
            </div>
            <div>
              <dt>Company</dt>
              <dd>
                {ticket.customer.company}{' '}
                <span className={styles.plan}>{ticket.customer.plan}</span>
              </dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>{channelLabels[ticket.channel]}</dd>
            </div>
            <div>
              <dt>SLA</dt>
              <dd>
                <SlaIndicator minutes={ticket.status === 'resolved' ? null : ticket.slaMinutes} />
              </dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd title={ticket.customer.email}>{ticket.customer.email}</dd>
            </div>
            <div>
              <dt>Messages</dt>
              <dd className="tabular">{ticket.messages.length}</dd>
            </div>
          </dl>
        </section>

        <section className={styles.thread} aria-label="Conversation">
          <h3 className={styles.threadTitle}>Conversation</h3>
          <ol className={styles.messages}>
            {ticket.messages.map((m) => (
              <li key={m.id} className={cx(styles.message, styles[m.kind])}>
                <Avatar
                  initials={m.initials}
                  size={32}
                  highlight={m.kind !== 'customer' && m.author === agentById(currentAgentId)?.name}
                />
                <div className={styles.bubble}>
                  <p className={styles.author}>
                    <span>{m.author}</span>
                    {m.kind === 'note' && <span className={styles.noteLabel}>Internal note</span>}
                    <time className={styles.time}>{relativeTime(m.minutesAgo)}</time>
                  </p>
                  <p className={styles.body}>{withMentions(m.body)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <form className={styles.composer} onSubmit={send}>
        <div className={styles.composerTop}>
          <Tabs
            label="Message type"
            value={mode}
            onChange={setMode}
            items={[
              { value: 'reply', label: 'Reply to customer' },
              { value: 'note', label: 'Internal note' },
            ]}
          />
        </div>
        <label htmlFor="composer" className="visually-hidden">
          {mode === 'reply' ? `Reply to ${ticket.customer.name}` : 'Internal note'}
        </label>
        <Textarea
          id="composer"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            mode === 'reply'
              ? `Reply to ${ticket.customer.name.split(' ')[0]}…`
              : 'Add a note for your team — use @name to mention'
          }
          rows={3}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e);
          }}
        />
        <div className={styles.composerFoot}>
          <span className={styles.hint}>
            <Icon name="sparkle" size={14} /> ⌘ Enter to send
          </span>
          <Button type="submit" variant="secondary" icon="send" disabled={!draft.trim()}>
            {mode === 'reply' ? 'Send reply' : 'Add note'}
          </Button>
        </div>
      </form>
    </>
  );
}
