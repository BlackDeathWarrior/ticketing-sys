import { PRIORITIES } from '@tms/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { qs } from '../api';
import { useAgentEvents } from '../realtime';
import { useGet } from '../hooks';
import type { Page, TicketView, Workflow } from '../types';

export function TicketsPage() {
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [assignee, setAssignee] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const workflow = useGet<Workflow>('/workflow');
  const path = `/tickets${qs({ status, priority, assigneeId: assignee, q, limit: String(limit), offset: String(offset) })}`;
  const { data, error, loading, reload } = useGet<Page<TicketView>>(path);
  // New tickets and status changes show up without a manual refresh.
  useAgentEvents(() => void reload());

  return (
    <section>
      <h1>Tickets</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          void reload();
        }}
      >
        <label htmlFor="f-status">Status </label>
        <select id="f-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any</option>
          {workflow.data?.statuses.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </select>{' '}
        <label htmlFor="f-priority">Priority </label>
        <select id="f-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">Any</option>
          {PRIORITIES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>{' '}
        <label htmlFor="f-assignee">Assignee </label>
        <select id="f-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="none">Unassigned</option>
        </select>{' '}
        <label htmlFor="f-q">Search </label>
        <input
          id="f-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Subject or TMS-123"
        />{' '}
        <button type="submit">Apply</button>
      </form>

      {error && <p role="alert">{error}</p>}
      {loading && <p>Loading…</p>}
      {data && (
        <>
          <p>
            {data.total} ticket(s). Showing {data.total ? offset + 1 : 0}–
            {Math.min(offset + limit, data.total)}.{' '}
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
              Previous
            </button>{' '}
            <button
              disabled={offset + limit >= data.total}
              onClick={() => setOffset(offset + limit)}
            >
              Next
            </button>
          </p>
          <table border={1} cellPadding={4}>
            <thead>
              <tr>
                <th>Ref</th>
                <th>Subject</th>
                <th>Customer</th>
                <th>Channel</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Team</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/tickets/${t.reference}`}>{t.reference}</Link>
                  </td>
                  <td>{t.subject}</td>
                  <td>
                    <Link to={`/customers/${t.customer.id}`}>{t.customer.displayName}</Link>
                  </td>
                  <td>{t.channel}</td>
                  <td>{t.priority}</td>
                  <td>{t.status}</td>
                  <td>{t.assignee?.name ?? '—'}</td>
                  <td>{t.team?.name ?? '—'}</td>
                  <td>{new Date(t.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
