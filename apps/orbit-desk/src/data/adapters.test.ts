import { describe, expect, it } from 'vitest';
import {
  type ApiConversation,
  glyphFor,
  initials,
  nextStatuses,
  replyTarget,
  statusInfo,
  toCustomer,
  toThread,
  toTicket,
  toWorkflow,
} from './adapters';
import { apiTicket, apiWorkflow, workflow } from '../test/fixtures';

describe('initials', () => {
  it('uses first and last name and ignores bracketed notes', () => {
    expect(initials('Maya Lindqvist')).toBe('ML');
    expect(initials('Priya Sharma (demo)')).toBe('PS');
    expect(initials('Cher')).toBe('C');
    expect(initials('  ')).toBe('?');
  });
});

describe('status glyphs', () => {
  it('maps workflow categories to the four glyph shapes', () => {
    expect(glyphFor('new', 'open')).toBe('open');
    expect(glyphFor('human_assigned', 'open')).toBe('open');
    expect(glyphFor('in_progress', 'open')).toBe('in_progress');
    expect(glyphFor('pending_customer', 'pending')).toBe('waiting');
    expect(glyphFor('resolved', 'resolved')).toBe('resolved');
    expect(glyphFor('closed', 'closed')).toBe('resolved');
  });

  it('orders active statuses and drops inactive ones', () => {
    const w = toWorkflow({
      ...apiWorkflow,
      statuses: [
        { key: 'b', name: 'B', category: 'open', isActive: true, sortOrder: 20 },
        { key: 'x', name: 'X', category: 'open', isActive: false, sortOrder: 5 },
        { key: 'a', name: 'A', category: 'open', isActive: true, sortOrder: 10 },
      ],
    });
    expect(w.statuses.map((s) => s.key)).toEqual(['a', 'b']);
  });

  it('falls back to a readable name for unknown statuses', () => {
    expect(statusInfo(workflow, 'on_hold')).toMatchObject({ name: 'On hold', glyph: 'open' });
    expect(statusInfo(workflow, 'pending_customer').name).toBe('Pending Customer');
  });

  it('lists only the transitions the workflow allows', () => {
    expect(nextStatuses(workflow, 'human_assigned').map((s) => s.key)).toEqual([
      'ai_handling',
      'in_progress',
      'pending_customer',
      'resolved',
    ]);
    expect(nextStatuses(workflow, 'closed')).toEqual([]);
  });
});

describe('toCustomer / toTicket', () => {
  it('reads company from attributes and plan from customer type', () => {
    expect(toCustomer(apiTicket().customer)).toMatchObject({
      name: 'Hana Ito',
      initials: 'HI',
      company: 'Atlas Freight Co.',
      plan: 'Business',
      email: 'hana@atlas.example.com',
    });
    expect(
      toCustomer({ id: 'c', displayName: 'Ana', attributes: { company: '  ' } }),
    ).toMatchObject({ company: null, plan: 'Standard', email: null });
  });

  it('maps a ticket with workflow status, assignee and dates', () => {
    const t = toTicket(
      apiTicket({ status: 'in_progress', assignee: { id: 'u1', name: 'Jonah Reyes' } }),
      workflow,
    );
    expect(t.status).toMatchObject({
      key: 'in_progress',
      name: 'In Progress',
      glyph: 'in_progress',
    });
    expect(t.assignee).toEqual({ id: 'u1', name: 'Jonah Reyes', initials: 'JR' });
    expect(t.createdAt).toBeInstanceOf(Date);
  });
});

describe('toThread', () => {
  const conv = (messages: Partial<ApiConversation['messages'][number]>[]): ApiConversation => ({
    id: 'conv1',
    channel: 'email',
    lastMessageAt: '2026-09-29T12:00:00.000Z',
    metadata: {},
    messages: messages.map((m, i) => ({
      id: `m${i}`,
      direction: 'inbound',
      authorType: 'customer',
      authorUserId: null,
      authorName: null,
      body: 'hi',
      createdAt: '2026-09-29T11:00:00.000Z',
      deliveryStatus: null,
      ...m,
    })),
  });

  it('merges description, messages and notes in time order', () => {
    const ticket = toTicket(apiTicket({ description: 'Original request' }), workflow);
    const thread = toThread(
      ticket,
      [
        conv([
          {
            direction: 'outbound',
            authorType: 'agent',
            authorName: 'Aiko Tanaka',
            authorUserId: 'u2',
            createdAt: '2026-09-29T12:00:00.000Z',
            deliveryStatus: 'pending',
          },
        ]),
      ],
      [{ id: 'n1', body: 'note', createdAt: '2026-09-29T11:30:00.000Z', author: null }],
    );
    expect(thread.messages.map((m) => [m.kind, m.author])).toEqual([
      ['customer', 'Hana Ito'],
      ['note', 'Former user'],
      ['agent', 'Aiko Tanaka'],
    ]);
    expect(thread.messages[2]!.delivery).toBe('pending');
  });

  it('skips the description once the customer wrote in on a channel', () => {
    const ticket = toTicket(apiTicket({ description: 'Same as the email' }), workflow);
    const thread = toThread(ticket, [conv([{ body: 'Same as the email' }])], []);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.id).toBe('m0');
  });

  it('replies on the most recently active conversation', () => {
    const ticket = toTicket(apiTicket(), workflow);
    const older = { ...conv([]), id: 'old', lastMessageAt: '2026-09-01T00:00:00.000Z' };
    const newer = {
      ...conv([]),
      id: 'new',
      channel: 'webchat',
      lastMessageAt: '2026-09-29T00:00:00.000Z',
    };
    expect(replyTarget(toThread(ticket, [older, newer], []))?.id).toBe('new');
    expect(replyTarget(toThread(ticket, [], []))).toBeNull();
  });
});
