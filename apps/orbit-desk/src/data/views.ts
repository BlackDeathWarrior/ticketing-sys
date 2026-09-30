import { currentAgentId } from './mock';
import type { Ticket } from './types';

export type ViewId = 'all' | 'mine' | 'unassigned' | 'urgent' | 'sla';

export const views: {
  id: ViewId;
  label: string;
  icon: 'layers' | 'user' | 'inbox' | 'bolt' | 'clock';
  match: (t: Ticket) => boolean;
}[] = [
  { id: 'all', label: 'All tickets', icon: 'layers', match: () => true },
  {
    id: 'mine',
    label: 'Assigned to me',
    icon: 'user',
    match: (t) => t.assigneeId === currentAgentId,
  },
  {
    id: 'unassigned',
    label: 'Unassigned',
    icon: 'inbox',
    match: (t) => t.assigneeId === null && t.status !== 'resolved',
  },
  {
    id: 'urgent',
    label: 'Urgent',
    icon: 'bolt',
    match: (t) => t.priority === 'urgent' && t.status !== 'resolved',
  },
  {
    id: 'sla',
    label: 'SLA at risk',
    icon: 'clock',
    match: (t) => t.slaMinutes !== null && t.slaMinutes <= 60,
  },
];

export const viewById = (id: ViewId) => views.find((v) => v.id === id) ?? views[0];
