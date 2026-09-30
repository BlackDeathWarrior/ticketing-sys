import { toWorkflow, type ApiTicket, type ApiWorkflow } from '../data/adapters';
import { DEFAULT_STATUSES, DEFAULT_TRANSITIONS } from '@tms/shared';

export const apiWorkflow: ApiWorkflow = {
  statuses: DEFAULT_STATUSES.map((s) => ({ ...s, isActive: true })),
  transitions: DEFAULT_TRANSITIONS.map(([fromStatus, toStatus]) => ({ fromStatus, toStatus })),
};

export const workflow = toWorkflow(apiWorkflow);

let n = 100;
export function apiTicket(overrides: Partial<ApiTicket> = {}): ApiTicket {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    number: n,
    reference: `TMS-${n}`,
    subject: `Subject ${n}`,
    description: null,
    channel: 'email',
    priority: 'normal',
    status: 'new',
    tags: [],
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    customer: {
      id: 'c1',
      displayName: 'Hana Ito',
      primaryEmail: 'hana@atlas.example.com',
      customerType: 'business',
      attributes: { company: 'Atlas Freight Co.' },
    },
    assignee: null,
    team: null,
    ...overrides,
  };
}
