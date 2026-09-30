import { PRIORITIES } from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, qs } from '../api';
import { useGet } from '../hooks';
import type { CategoryTree, CustomerView, Page, Ref, TicketView } from '../types';

export function NewTicketPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '');
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState<string>();
  const customers = useGet<Page<CustomerView>>(`/customers${qs({ q: search, limit: '20' })}`);
  const categories = useGet<CategoryTree[]>('/categories');
  const teams = useGet<Ref[]>('/teams');
  const subcats = categories.data?.find((c) => c.id === categoryId)?.children ?? [];

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      const t = await api<TicketView>('POST', '/tickets', {
        customerId,
        subject: f.get('subject'),
        description: (f.get('description') as string) || undefined,
        priority: f.get('priority'),
        categoryId: categoryId || undefined,
        subcategoryId: (f.get('subcategory') as string) || undefined,
        teamId: (f.get('team') as string) || undefined,
        tags: String(f.get('tags') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      });
      navigate(`/tickets/${t.reference}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <h1>New ticket</h1>
      <p>
        <label htmlFor="c-search">Find customer </label>
        <input
          id="c-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name, email or phone"
        />
      </p>
      <form onSubmit={submit}>
        <p>
          <label htmlFor="customer">Customer </label>
          <select
            id="customer"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            required
          >
            <option value="">Choose…</option>
            {customers.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} {c.primaryEmail ? `<${c.primaryEmail}>` : ''}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="subject">Subject</label>
          <br />
          <input id="subject" name="subject" size={80} required />
        </p>
        <p>
          <label htmlFor="description">Description</label>
          <br />
          <textarea id="description" name="description" rows={6} cols={80} />
        </p>
        <p>
          <label htmlFor="priority">Priority </label>
          <select id="priority" name="priority" defaultValue="normal">
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>{' '}
          <label htmlFor="category">Category </label>
          <select id="category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">None</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>{' '}
          <label htmlFor="subcategory">Sub-category </label>
          <select id="subcategory" name="subcategory">
            <option value="">None</option>
            {subcats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>{' '}
          <label htmlFor="team">Team </label>
          <select id="team" name="team">
            <option value="">None</option>
            {teams.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="tags">Tags (comma separated) </label>
          <input id="tags" name="tags" />
        </p>
        {error && <p role="alert">{error}</p>}
        <button type="submit">Create ticket</button>
      </form>
    </section>
  );
}
