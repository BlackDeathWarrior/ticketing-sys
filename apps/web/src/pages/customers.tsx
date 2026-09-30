import { IDENTITY_TYPES } from '@tms/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, qs } from '../api';
import { useGet } from '../hooks';
import type { CustomerView, Page } from '../types';

export function CustomersPage() {
  const [q, setQ] = useState('');
  const [error, setError] = useState<string>();
  const navigate = useNavigate();
  const { data, error: loadError } = useGet<Page<CustomerView>>(
    `/customers${qs({ q, limit: '100' })}`,
  );

  return (
    <section>
      <h1>Customers</h1>
      <label htmlFor="cq">Search </label>
      <input
        id="cq"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Name, email or phone"
      />
      {loadError && <p role="alert">{loadError}</p>}
      <table border={1} cellPadding={4}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Phone</th>
            <th>Type</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={`/customers/${c.id}`}>{c.displayName}</Link>
              </td>
              <td>{c.primaryEmail ?? '—'}</td>
              <td>{c.primaryPhone ?? '—'}</td>
              <td>{c.customerType}</td>
              <td>{new Date(c.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Add customer</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setError(undefined);
          try {
            const c = await api<CustomerView>('POST', '/customers', {
              displayName: f.get('name'),
              email: (f.get('email') as string) || undefined,
              phone: (f.get('phone') as string) || undefined,
            });
            navigate(`/customers/${c.id}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <label htmlFor="n-name">Name </label>
        <input id="n-name" name="name" required /> <label htmlFor="n-email">Email </label>
        <input id="n-email" name="email" type="email" /> <label htmlFor="n-phone">Phone </label>
        <input id="n-phone" name="phone" /> <button type="submit">Add</button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}

export function CustomerPage() {
  const { id } = useParams();
  const { data: c, error, reload } = useGet<CustomerView>(`/customers/${id}`);
  const [actionError, setActionError] = useState<string>();

  if (error) return <p role="alert">{error}</p>;
  if (!c) return <p>Loading…</p>;

  return (
    <section>
      <h1>{c.displayName}</h1>
      <p>
        Type: {c.customerType} · Language: {c.language ?? '—'} · Since{' '}
        {new Date(c.createdAt).toLocaleDateString()}
      </p>
      <p>
        <Link to={`/tickets/new?customerId=${c.id}`}>Create ticket for this customer</Link>
      </p>

      <h2>Identities</h2>
      <ul>
        {c.identities?.map((i) => (
          <li key={i.id}>
            {i.type}: {i.value} {i.verified ? '(verified)' : ''}
          </li>
        ))}
      </ul>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          setActionError(undefined);
          try {
            await api('POST', `/customers/${c.id}/identities`, {
              type: f.get('type'),
              value: f.get('value'),
            });
            form.reset();
            await reload();
          } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <label htmlFor="i-type">Add identity </label>
        <select id="i-type" name="type">
          {IDENTITY_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>{' '}
        <input name="value" aria-label="Identity value" required />{' '}
        <button type="submit">Add</button>
        {actionError && <p role="alert">{actionError}</p>}
      </form>

      <h2>Recent tickets</h2>
      <ul>
        {c.recentTickets?.map((t) => (
          <li key={t.id}>
            <Link to={`/tickets/TMS-${t.number}`}>TMS-{t.number}</Link> {t.subject} ({t.status},{' '}
            {t.channel})
          </li>
        ))}
      </ul>
    </section>
  );
}
