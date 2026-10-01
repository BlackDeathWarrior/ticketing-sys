import type { Retention, RetentionCounts } from '@tms/shared';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  roles: string[];
  teams: Array<{ id: string; name: string }>;
}

export interface AdminTeam {
  id: string;
  name: string;
  description: string | null;
  members: Array<{ id: string; name: string }>;
}

export interface AdminCategory {
  id: string;
  name: string;
  isActive: boolean;
  parentId: string | null;
  children?: AdminCategory[];
}

export interface AdminStatus {
  key: string;
  name: string;
  category: string;
  sortOrder: number;
  isInitial: boolean;
  isActive: boolean;
}

export interface Transition {
  from: string;
  to: string;
}

export interface UserForm {
  name: string;
  email: string;
  password: string;
  role: string;
  teamIds: string[];
  isActive: boolean;
}

export const emptyUser = (): UserForm => ({
  name: '',
  email: '',
  password: '',
  role: 'agent',
  teamIds: [],
  isActive: true,
});

export const formFromUser = (u: AdminUser): UserForm => ({
  name: u.name,
  email: u.email,
  password: '',
  role: u.roles[0] ?? 'agent',
  teamIds: u.teams.map((t) => t.id),
  isActive: u.isActive,
});

/** What to send to create a user, or to change one (only what changed; a blank password stays). */
export function userBody(form: UserForm, existing?: AdminUser): Record<string, unknown> {
  if (!existing) {
    return {
      name: form.name.trim(),
      email: form.email.trim(),
      password: form.password,
      roles: [form.role],
      teamIds: form.teamIds,
    };
  }
  const body: Record<string, unknown> = {};
  if (form.name.trim() !== existing.name) body.name = form.name.trim();
  if (form.isActive !== existing.isActive) body.isActive = form.isActive;
  if (form.role !== (existing.roles[0] ?? '')) body.roles = [form.role];
  const before = existing.teams.map((t) => t.id).sort();
  if (JSON.stringify([...form.teamIds].sort()) !== JSON.stringify(before)) {
    body.teamIds = form.teamIds;
  }
  if (form.password) body.password = form.password;
  return body;
}

export const toggle = <T>(list: T[], item: T): T[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

/** A status key from its name: "Waiting on supplier" becomes `waiting_on_supplier`. */
export function statusKey(name: string): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(key) ? key : key ? `s_${key}`.slice(0, 40) : '';
}

export const hasTransition = (list: Transition[], from: string, to: string) =>
  list.some((t) => t.from === from && t.to === to);

export function toggleTransition(list: Transition[], from: string, to: string): Transition[] {
  return hasTransition(list, from, to)
    ? list.filter((t) => !(t.from === from && t.to === to))
    : [...list, { from, to }];
}

/** Whether two sets of transitions allow the same moves. */
export function sameTransitions(a: Transition[], b: Transition[]): boolean {
  const key = (list: Transition[]) =>
    list
      .map((t) => `${t.from}>${t.to}`)
      .sort()
      .join('|');
  return key(a) === key(b);
}

/**
 * Problems an admin should hear about before saving a workflow: a status
 * tickets can't leave, or one they can never reach. Closed statuses are meant
 * to be the end of the road.
 */
export function workflowWarnings(statuses: AdminStatus[], transitions: Transition[]): string[] {
  const active = statuses.filter((s) => s.isActive);
  const out: string[] = [];
  for (const s of active) {
    const leaves = transitions.some((t) => t.from === s.key);
    const arrives = transitions.some((t) => t.to === s.key);
    if (!leaves && s.category !== 'closed') out.push(`Tickets can’t leave “${s.name}”.`);
    if (!arrives && !s.isInitial) out.push(`Nothing leads to “${s.name}”.`);
  }
  return out;
}

export const CATEGORY_LABELS: Record<string, string> = {
  open: 'Open',
  pending: 'Waiting',
  resolved: 'Resolved',
  closed: 'Closed',
};

// ---- System: retention ----

export const RETENTION_FIELDS: Array<{
  key: keyof Retention;
  label: string;
  min: number;
  max: number;
}> = [
  { key: 'llmCallsDays', label: 'Log of AI model calls (days)', min: 7, max: 3650 },
  { key: 'notificationsDays', label: 'Agents’ notifications (days)', min: 7, max: 3650 },
  { key: 'eventsDays', label: 'Delivered internal events (days)', min: 1, max: 365 },
  { key: 'signInLinksDays', label: 'Used portal sign-in links (days)', min: 1, max: 90 },
  { key: 'webhookDeliveriesDays', label: 'Log of webhook deliveries (days)', min: 1, max: 365 },
];

const COUNT_LABELS: Array<[keyof RetentionCounts, string, string]> = [
  ['llmCalls', 'model call', 'model calls'],
  ['notifications', 'notification', 'notifications'],
  ['events', 'event', 'events'],
  ['signInLinks', 'sign-in link', 'sign-in links'],
  ['recordings', 'recording', 'recordings'],
  ['webhookDeliveries', 'webhook delivery', 'webhook deliveries'],
];

/** "12 model calls, 3 events deleted", or that there was nothing to delete. */
export function deletedText(d: RetentionCounts): string {
  const parts = COUNT_LABELS.filter(([key]) => d[key] > 0).map(
    ([key, one, many]) => `${d[key]} ${d[key] === 1 ? one : many}`,
  );
  return parts.length ? `${parts.join(', ')} deleted` : 'nothing was old enough to delete';
}
