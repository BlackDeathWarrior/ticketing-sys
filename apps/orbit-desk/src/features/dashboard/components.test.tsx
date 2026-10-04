import type { CurrentUser, Permission } from '@tms/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toTicket } from '../../data/adapters';
import { SessionContext, type Session } from '../../lib/session';
import { apiTicket, workflow } from '../../test/fixtures';
import { NewTicketForm } from './NewTicketDialog';
import { TicketDrawer } from './TicketDrawer';
import { TicketTable } from './TicketTable';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({
  api: apiMock,
  qs: (p: Record<string, unknown>) =>
    `?${new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)]))}`,
}));

const user: CurrentUser = {
  id: 'u-admin',
  email: 'admin@example.com',
  name: 'Administrator',
  roles: ['admin'],
  permissions: ['ticket:transition', 'ticket:update', 'ticket:note', 'message:send'],
};

function withSession(
  ui: React.ReactNode,
  permissions: Permission[] = user.permissions as Permission[],
) {
  const session: Session = {
    user: { ...user, permissions },
    workflow,
    can: (p) => permissions.includes(p),
    signOut: () => undefined,
  };
  return <SessionContext.Provider value={session}>{ui}</SessionContext.Provider>;
}

beforeEach(() => {
  // The callbacks handed to the components too: a call left by one test must not satisfy the next.
  vi.clearAllMocks();
  apiMock.mockReset();
});

describe('TicketTable', () => {
  const tickets = [
    toTicket(apiTicket({ subject: 'Refund please', status: 'new', priority: 'urgent' }), workflow),
    toTicket(apiTicket({ subject: 'Waiting on photos', status: 'pending_customer' }), workflow),
    toTicket(apiTicket({ subject: 'All sorted', status: 'resolved' }), workflow),
  ];
  const props = {
    title: 'All tickets',
    tickets,
    total: 3,
    loading: false,
    search: '',
    onSearch: vi.fn(),
    channel: '' as const,
    onChannel: vi.fn(),
    handling: '' as const,
    onHandling: vi.fn(),
    selectedId: null,
    onSelect: vi.fn(),
    onClearFilters: vi.fn(),
  };

  it('counts per status tab and filters rows', () => {
    render(<TicketTable {...props} />);
    expect(screen.getAllByRole('row')).toHaveLength(4); // header + 3
    expect(screen.getByRole('tab', { name: /Pending/ })).toHaveTextContent('1');
    fireEvent.click(screen.getByRole('tab', { name: /Resolved/ }));
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('All sorted');
  });

  it('opens a ticket on click and shows the empty state with a reset', () => {
    const { rerender } = render(<TicketTable {...props} />);
    fireEvent.click(screen.getByText('Refund please'));
    expect(props.onSelect).toHaveBeenCalledWith(tickets[0]!.id);

    rerender(<TicketTable {...props} tickets={[]} total={0} search="zzz" />);
    expect(screen.getByText('No tickets in this part of the sky')).toBeInTheDocument();
    expect(screen.getByText('zzz')).toBeInTheDocument();
    // One beside the search that is on, one in the empty state: both reset.
    const clears = screen.getAllByRole('button', { name: 'Clear filters' });
    expect(clears).toHaveLength(2);
    fireEvent.click(clears[1]!);
    expect(props.onClearFilters).toHaveBeenCalled();
  });

  it('filters by channel', () => {
    const { rerender } = render(<TicketTable {...props} />);
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'web_form' } });
    expect(props.onChannel).toHaveBeenCalledWith('web_form');
    rerender(<TicketTable {...props} channel="web_form" />);
    expect(screen.getByText(/Web form only/)).toBeInTheDocument();
  });

  it('filters by who is handling and shows SLA and handling in rows', () => {
    const { rerender } = render(<TicketTable {...props} />);
    fireEvent.change(screen.getByLabelText('Handled by'), { target: { value: 'handed_over' } });
    expect(props.onHandling).toHaveBeenCalledWith('handed_over');
    const late = {
      ...tickets[0]!,
      handling: 'handed_over' as const,
      sla: { state: 'breached' as const, minutes: -30, raw: 'breached' },
    };
    rerender(<TicketTable {...props} tickets={[late]} handling="handed_over" />);
    expect(document.querySelector('[data-handling="handed_over"]')).toHaveTextContent(
      'Handed over',
    );
    expect(document.querySelector('[data-sla="breached"]')).toHaveTextContent('30m over');
  });

  it('says when the list is capped', () => {
    render(<TicketTable {...props} total={250} />);
    expect(screen.getByText(/showing 3 of 250/)).toBeInTheDocument();
  });
});

describe('NewTicketForm', () => {
  it('needs a subject and a customer, then creates customer and ticket', async () => {
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (method === 'POST' && path === '/customers') return { id: 'c-new' };
      if (method === 'POST' && path === '/tickets') return { id: 't-new' };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const onCreated = vi.fn();
    render(<NewTicketForm onClose={() => undefined} onCreated={onCreated} />);
    const create = screen.getByRole('button', { name: 'Create ticket' });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Broken lamp' } });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'New customer' }));
    fireEvent.change(screen.getByLabelText('Customer name'), {
      target: { value: 'Ines Calloway' },
    });
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Calloway Ceramics' } });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'lamp, , damaged ' } });
    expect(create).toBeEnabled();
    fireEvent.click(create);

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('t-new'));
    expect(apiMock).toHaveBeenCalledWith('POST', '/customers', {
      displayName: 'Ines Calloway',
      attributes: { company: 'Calloway Ceramics' },
    });
    expect(apiMock).toHaveBeenCalledWith('POST', '/tickets', {
      customerId: 'c-new',
      subject: 'Broken lamp',
      priority: 'normal',
      channel: 'agent',
      tags: ['lamp', 'damaged'],
    });
  });

  it('shows API errors', async () => {
    apiMock.mockRejectedValue(new Error('Validation failed — email: Invalid email'));
    render(<NewTicketForm onClose={() => undefined} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'New customer' }));
    fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create ticket' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email');
  });
});

describe('TicketDrawer', () => {
  const ticket = apiTicket({ status: 'human_assigned', subject: 'Printer offline' });

  function mockTicketApi() {
    apiMock.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === `/tickets/${ticket.id}`) return ticket;
      if (method === 'GET' && path.endsWith('/conversations')) return [];
      if (method === 'GET' && path.endsWith('/notes')) return [];
      if (method === 'POST') return {};
      throw new Error(`unexpected ${method} ${path}`);
    });
  }

  it('offers only allowed transitions and posts the chosen one', async () => {
    mockTicketApi();
    const onChanged = vi.fn();
    render(
      withSession(
        <TicketDrawer
          ticketId={ticket.id}
          liveTick={0}
          onClose={() => undefined}
          onChanged={onChanged}
        />,
      ),
    );
    const group = await screen.findByRole('radiogroup', { name: 'Status' });
    const names = within(group)
      .getAllByRole('radio')
      .map((r) => r.textContent);
    expect(names).toEqual([
      'Human Assigned',
      'AI Handling',
      'In Progress',
      'Pending Customer',
      'Resolved',
    ]);

    fireEvent.click(within(group).getByRole('radio', { name: 'Resolved' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('POST', `/tickets/${ticket.id}/transition`, {
        status: 'resolved',
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('starts an email conversation when there is none, and hides assignment without rights', async () => {
    mockTicketApi();
    render(
      withSession(
        <TicketDrawer
          ticketId={ticket.id}
          liveTick={0}
          onClose={() => undefined}
          onChanged={() => undefined}
        />,
      ),
    );
    const composer = await screen.findByLabelText('Reply to Hana Ito');
    expect(screen.queryByRole('combobox', { name: 'Assignee' })).toBeNull();
    fireEvent.change(composer, { target: { value: 'On it!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('POST', `/tickets/${ticket.id}/conversations`, {
        channel: 'email',
        body: 'On it!',
      }),
    );
  });

  it('only allows notes for users who cannot send messages', async () => {
    mockTicketApi();
    render(
      withSession(
        <TicketDrawer
          ticketId={ticket.id}
          liveTick={0}
          onClose={() => undefined}
          onChanged={() => undefined}
        />,
        ['ticket:note'],
      ),
    );
    await screen.findByRole('radiogroup', { name: 'Status' });
    expect(screen.queryByRole('tab', { name: 'Reply to customer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });
});
