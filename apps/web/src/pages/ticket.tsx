import { type CurrentUser, PRIORITIES } from '@tms/shared';
import { type FormEvent, useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, openAttachment } from '../api';
import { useAgentEvents } from '../realtime';
import { useGet } from '../hooks';
import type { CategoryTree, Ref, TicketView, Workflow } from '../types';

interface HistoryItem {
  id: number;
  occurredAt: string;
  action: string;
  actorType: string;
  actorName: string | null;
  data: Record<string, unknown>;
}

interface Note {
  id: string;
  body: string;
  createdAt: string;
  author: Ref | null;
}

interface ConversationMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  authorType: string;
  authorName: string | null;
  body: string;
  createdAt: string;
  deliveryStatus: string | null;
  deliveryError: string | null;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  metadata: { subject?: string; to?: string };
}

interface Conversation {
  id: string;
  channel: string;
  controller: string;
  metadata: { address?: string; subject?: string; visitorName?: string; sessionId?: string };
  messages: ConversationMessage[];
}

export function TicketPage({ user }: { user: CurrentUser }) {
  const { ref } = useParams();
  const ticket = useGet<TicketView>(`/tickets/${ref}`);
  const t = ticket.data;
  const id = t?.id;
  const workflow = useGet<Workflow>('/workflow');
  const notes = useGet<Note[]>(id ? `/tickets/${id}/notes` : null);
  const history = useGet<HistoryItem[]>(id ? `/tickets/${id}/history` : null);
  const convs = useGet<Conversation[]>(id ? `/tickets/${id}/conversations` : null);
  const can = (p: string) => user.permissions.includes(p);
  const users = useGet<Array<Ref & { isActive: boolean }>>(can('user:read') ? '/users' : null);
  const teams = useGet<Ref[]>('/teams');
  const categories = useGet<CategoryTree[]>('/categories');
  const [error, setError] = useState<string>();

  const refreshAll = () =>
    Promise.all([ticket.reload(), history.reload(), notes.reload(), convs.reload()]);
  // Live updates: new customer messages, delivery results, changes by other agents.
  useAgentEvents(
    () => void refreshAll(),
    (e) => !!id && e.ticketId === id,
  );

  async function run(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (ticket.error) return <p role="alert">{ticket.error}</p>;
  if (!t) return <p>Loading…</p>;

  const nextStatuses =
    workflow.data?.transitions
      .filter((x) => x.fromStatus === t.status)
      .map((x) => workflow.data!.statuses.find((s) => s.key === x.toStatus))
      .filter((s): s is NonNullable<typeof s> => !!s && s.isActive) ?? [];
  const subcats = categories.data?.find((c) => c.id === t.category?.id)?.children ?? [];

  return (
    <section>
      <h1>
        {t.reference}: {t.subject}
      </h1>
      {error && <p role="alert">Error: {error}</p>}

      <table border={1} cellPadding={4}>
        <tbody>
          <tr>
            <th align="left">Status</th>
            <td>{t.status}</td>
          </tr>
          <tr>
            <th align="left">Customer</th>
            <td>
              <Link to={`/customers/${t.customer.id}`}>{t.customer.displayName}</Link>
            </td>
          </tr>
          <tr>
            <th align="left">Channel</th>
            <td>{t.channel}</td>
          </tr>
          <tr>
            <th align="left">Priority</th>
            <td>{t.priority}</td>
          </tr>
          <tr>
            <th align="left">Category</th>
            <td>
              {t.category?.name ?? '—'} {t.subcategory ? `› ${t.subcategory.name}` : ''}
            </td>
          </tr>
          <tr>
            <th align="left">Team / assignee</th>
            <td>
              {t.team?.name ?? '—'} / {t.assignee?.name ?? '—'}
            </td>
          </tr>
          <tr>
            <th align="left">Tags</th>
            <td>{t.tags.join(', ') || '—'}</td>
          </tr>
          <tr>
            <th align="left">Created / updated</th>
            <td>
              {new Date(t.createdAt).toLocaleString()} / {new Date(t.updatedAt).toLocaleString()}
            </td>
          </tr>
          <tr>
            <th align="left">Resolution</th>
            <td>{t.resolution ?? '—'}</td>
          </tr>
        </tbody>
      </table>
      {t.description && (
        <>
          <h2>Description</h2>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{t.description}</pre>
        </>
      )}

      {can('ticket:transition') && (
        <TransitionForm
          options={nextStatuses}
          onSubmit={(status, resolution) =>
            run(() =>
              api('POST', `/tickets/${t.id}/transition`, {
                status,
                resolution: resolution || undefined,
              }),
            )
          }
        />
      )}

      {can('ticket:assign') && (
        <form
          // Remount once the option lists arrive (and after each save): an
          // uncontrolled <select> ignores a defaultValue whose option didn't
          // exist yet, which would submit "None" and clear the real value.
          key={`assign-${t.updatedAt}-${!!teams.data}-${!!users.data}`}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const assigneeId = (f.get('assignee') as string) || null;
            const teamId = (f.get('team') as string) || null;
            void run(() => api('POST', `/tickets/${t.id}/assign`, { assigneeId, teamId }));
          }}
        >
          <h2>Assign</h2>
          <label htmlFor="a-team">Team </label>
          <select id="a-team" name="team" defaultValue={t.team?.id ?? ''}>
            <option value="">None</option>
            {teams.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>{' '}
          <label htmlFor="a-user">Agent </label>
          <select id="a-user" name="assignee" defaultValue={t.assignee?.id ?? ''}>
            <option value="">Unassigned</option>
            {users.data
              ?.filter((u) => u.isActive)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>{' '}
          <button type="submit">Save assignment</button>
        </form>
      )}

      {can('ticket:update') && (
        <form
          key={`edit-${t.updatedAt}-${!!categories.data}`}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const tags = String(f.get('tags') ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            void run(() =>
              api('PATCH', `/tickets/${t.id}`, {
                priority: f.get('priority'),
                categoryId: (f.get('category') as string) || null,
                subcategoryId: (f.get('subcategory') as string) || null,
                tags,
              }),
            );
          }}
        >
          <h2>Edit</h2>
          <label htmlFor="e-priority">Priority </label>
          <select id="e-priority" name="priority" defaultValue={t.priority}>
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>{' '}
          <label htmlFor="e-category">Category </label>
          <select id="e-category" name="category" defaultValue={t.category?.id ?? ''}>
            <option value="">None</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>{' '}
          <label htmlFor="e-subcategory">Sub-category </label>
          <select id="e-subcategory" name="subcategory" defaultValue={t.subcategory?.id ?? ''}>
            <option value="">None</option>
            {subcats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>{' '}
          <label htmlFor="e-tags">Tags </label>
          <input id="e-tags" name="tags" defaultValue={t.tags.join(', ')} />{' '}
          <button type="submit">Save</button>
          <p>
            <small>Save the category first to choose from its sub-categories.</small>
          </p>
        </form>
      )}

      <h2>Conversations</h2>
      {convs.data?.length ? (
        convs.data.map((c) => (
          <ConversationView
            key={c.id}
            conversation={c}
            customerName={t.customer.displayName}
            canReply={can('message:send')}
            onReply={(body) => run(() => api('POST', `/conversations/${c.id}/messages`, { body }))}
            onError={setError}
          />
        ))
      ) : (
        <p>No conversations yet.</p>
      )}
      {can('message:send') && !convs.data?.some((c) => c.channel === 'email') && (
        <ReplyForm
          label="Email the customer (starts an email conversation)"
          submitText="Send email"
          onSubmit={(body) =>
            run(() => api('POST', `/tickets/${t.id}/conversations`, { channel: 'email', body }))
          }
        />
      )}

      <h2>Internal notes</h2>
      <ul>
        {notes.data?.map((n) => (
          <li key={n.id}>
            [{new Date(n.createdAt).toLocaleString()}] {n.author?.name ?? 'system'}: {n.body}
          </li>
        ))}
      </ul>
      {can('ticket:note') && (
        <NoteForm onSubmit={(body) => run(() => api('POST', `/tickets/${t.id}/notes`, { body }))} />
      )}

      <h2>History</h2>
      <ul>
        {history.data?.map((h) => (
          <li key={h.id}>
            [{new Date(h.occurredAt).toLocaleString()}] {h.actorName ?? h.actorType}: {h.action}{' '}
            <code>{JSON.stringify(h.data)}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TransitionForm({
  options,
  onSubmit,
}: {
  options: Array<{ key: string; name: string; category: string }>;
  onSubmit: (status: string, resolution: string) => Promise<void>;
}) {
  const [status, setStatus] = useState('');
  const [resolution, setResolution] = useState('');
  const target = options.find((o) => o.key === status);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!status) return;
    await onSubmit(status, resolution);
    setStatus('');
    setResolution('');
  }

  return (
    <form onSubmit={submit}>
      <h2>Change status</h2>
      {options.length === 0 ? (
        <p>No further statuses are allowed from here.</p>
      ) : (
        <>
          <label htmlFor="t-status">Move to </label>
          <select id="t-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
          </select>{' '}
          {target?.category === 'resolved' && (
            <>
              <label htmlFor="t-resolution">Resolution </label>
              <input
                id="t-resolution"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              />{' '}
            </>
          )}
          <button type="submit" disabled={!status}>
            Update status
          </button>
        </>
      )}
    </form>
  );
}

function NoteForm({ onSubmit }: { onSubmit: (body: string) => Promise<void> }) {
  const [body, setBody] = useState('');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim()) return;
        await onSubmit(body);
        setBody('');
      }}
    >
      <label htmlFor="note">Add an internal note (not visible to the customer)</label>
      <br />
      <textarea
        id="note"
        rows={3}
        cols={80}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <br />
      <button type="submit">Add note</button>
    </form>
  );
}

function ConversationView({
  conversation: c,
  customerName,
  canReply,
  onReply,
  onError,
}: {
  conversation: Conversation;
  customerName: string;
  canReply: boolean;
  onReply: (body: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const who = (m: ConversationMessage) =>
    m.authorType === 'customer'
      ? (c.metadata.visitorName ?? customerName)
      : m.authorType === 'agent'
        ? (m.authorName ?? 'Agent')
        : m.authorType;
  const where =
    c.channel === 'email'
      ? `Email with ${c.metadata.address ?? 'customer'}${c.metadata.subject ? ` — "${c.metadata.subject}"` : ''}`
      : c.channel === 'webchat'
        ? 'Web chat'
        : c.channel;

  return (
    <div>
      <h3>
        {where} <small>(replying: {c.controller})</small>
      </h3>
      <ol>
        {c.messages.map((m) => (
          <li key={m.id}>
            <strong>{who(m)}</strong> <small>{new Date(m.createdAt).toLocaleString()}</small>
            {m.direction === 'outbound' && (
              <small>
                {' '}
                · {m.deliveryStatus === 'sent' ? 'delivered' : m.deliveryStatus}
                {m.deliveryError ? ` (${m.deliveryError})` : ''}
              </small>
            )}
            <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 8px' }}>{m.body}</pre>
            {m.attachments.length > 0 && (
              <p>
                Attachments:{' '}
                {m.attachments.map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() =>
                      openAttachment(m.id, i).catch((err) =>
                        onError(err instanceof Error ? err.message : String(err)),
                      )
                    }
                  >
                    {a.filename} ({Math.ceil(a.size / 1024)} KB)
                  </button>
                ))}
              </p>
            )}
          </li>
        ))}
      </ol>
      {canReply && (
        <ReplyForm
          label={`Reply by ${c.channel === 'webchat' ? 'chat' : c.channel}`}
          submitText="Send reply"
          onSubmit={onReply}
        />
      )}
    </div>
  );
}

function ReplyForm({
  label,
  submitText,
  onSubmit,
}: {
  label: string;
  submitText: string;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim()) return;
        setBusy(true);
        try {
          await onSubmit(body);
          setBody('');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={id}>{label}</label>
      <br />
      <textarea id={id} rows={4} cols={80} value={body} onChange={(e) => setBody(e.target.value)} />
      <br />
      <button type="submit" disabled={busy || !body.trim()}>
        {busy ? 'Sending…' : submitText}
      </button>
    </form>
  );
}
