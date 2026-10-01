import { describe, expect, it } from 'vitest';
import { visibleTabs } from '../settings/logic';
import { deletedText } from './logic';
import {
  type AdminStatus,
  type AdminUser,
  emptyUser,
  formFromUser,
  sameTransitions,
  statusKey,
  toggle,
  toggleTransition,
  userBody,
  workflowWarnings,
} from './logic';

const user: AdminUser = {
  id: 'u1',
  email: 'jonah.reyes@tms.example',
  name: 'Jonah Reyes',
  isActive: true,
  roles: ['agent'],
  teams: [{ id: 't1', name: 'Orders' }],
};

const status = (key: string, category: string, over: Partial<AdminStatus> = {}): AdminStatus => ({
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  category,
  sortOrder: 10,
  isInitial: false,
  isActive: true,
  ...over,
});

describe('user form', () => {
  it('sends everything for a new user', () => {
    const form = {
      ...emptyUser(),
      name: ' Ada Park ',
      email: 'ada@tms.example',
      password: 'Secret-Pass1',
    };
    expect(userBody(form)).toEqual({
      name: 'Ada Park',
      email: 'ada@tms.example',
      password: 'Secret-Pass1',
      roles: ['agent'],
      teamIds: [],
    });
  });

  it('sends only what changed for an existing user', () => {
    const form = formFromUser(user);
    expect(userBody(form, user)).toEqual({});
    expect(userBody({ ...form, role: 'team_lead' }, user)).toEqual({ roles: ['team_lead'] });
    expect(userBody({ ...form, isActive: false }, user)).toEqual({ isActive: false });
    expect(userBody({ ...form, teamIds: ['t1', 't2'] }, user)).toEqual({ teamIds: ['t1', 't2'] });
    // A blank password keeps the old one; a typed one replaces it.
    expect(userBody({ ...form, password: 'New-Passw0rd!' }, user)).toEqual({
      password: 'New-Passw0rd!',
    });
  });

  it('toggles list membership', () => {
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('workflow editing', () => {
  it('derives a status key from its name', () => {
    expect(statusKey('Waiting on supplier')).toBe('waiting_on_supplier');
    expect(statusKey('  On-hold (2nd line) ')).toBe('on_hold_2nd_line');
    expect(statusKey('2nd line')).toBe('s_2nd_line');
    expect(statusKey('!!!')).toBe('');
  });

  it('adds and removes a move, and knows when nothing changed', () => {
    const saved = [{ from: 'new', to: 'open' }];
    const added = toggleTransition(saved, 'open', 'done');
    expect(added).toHaveLength(2);
    expect(sameTransitions(added, saved)).toBe(false);
    expect(sameTransitions(toggleTransition(added, 'open', 'done'), saved)).toBe(true);
    expect(sameTransitions([...added].reverse(), added)).toBe(true);
  });

  it('warns about statuses tickets can’t leave or can’t reach', () => {
    const statuses = [
      status('new', 'open', { isInitial: true }),
      status('open', 'open'),
      status('stuck', 'pending'),
      status('closed', 'closed'),
      status('retired', 'open', { isActive: false }),
    ];
    const moves = [
      { from: 'new', to: 'open' },
      { from: 'open', to: 'closed' },
      { from: 'open', to: 'stuck' },
    ];
    expect(workflowWarnings(statuses, moves)).toEqual(['Tickets can’t leave “Stuck”.']);
    expect(workflowWarnings(statuses, moves.slice(0, 2))).toEqual([
      'Tickets can’t leave “Stuck”.',
      'Nothing leads to “Stuck”.',
    ]);
  });
});

describe('settings tabs for the new admin pages', () => {
  const tabs = (...perms: string[]) => visibleTabs((p) => perms.includes(p)).map((t) => t.value);

  it('shows People to user managers, Tickets to either ticket permission', () => {
    expect(tabs('user:manage')).toEqual(['people']);
    expect(tabs('settings:workflow')).toEqual(['tickets']);
    expect(tabs('settings:categories')).toEqual(['tickets']);
    expect(tabs('settings:channels')).toEqual(['channels', 'customers']);
    expect(tabs()).toEqual([]);
  });
});

describe('retention', () => {
  const none = { llmCalls: 0, notifications: 0, events: 0, signInLinks: 0, recordings: 0 };

  it('says what a run deleted, in words', () => {
    expect(deletedText(none)).toBe('nothing was old enough to delete');
    expect(deletedText({ ...none, llmCalls: 12, events: 1 })).toBe(
      '12 model calls, 1 event deleted',
    );
    expect(deletedText({ ...none, recordings: 2, signInLinks: 1 })).toBe(
      '1 sign-in link, 2 recordings deleted',
    );
  });
});
