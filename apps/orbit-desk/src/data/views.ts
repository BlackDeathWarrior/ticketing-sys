export type ViewId = 'all' | 'mine' | 'unassigned' | 'urgent' | 'sla';

export interface ViewDef {
  id: ViewId;
  label: string;
  icon: 'layers' | 'user' | 'inbox' | 'bolt' | 'clock';
  /** Query parameters for GET /tickets, before status and search filters. */
  query: (openStatuses: string[]) => Record<string, string | undefined>;
}

export const views: ViewDef[] = [
  { id: 'all', label: 'All tickets', icon: 'layers', query: () => ({}) },
  { id: 'mine', label: 'Assigned to me', icon: 'user', query: () => ({ assigneeId: 'me' }) },
  {
    id: 'unassigned',
    label: 'Unassigned',
    icon: 'inbox',
    query: (open) => ({ assigneeId: 'none', status: open.join(',') }),
  },
  {
    id: 'urgent',
    label: 'Urgent',
    icon: 'bolt',
    query: (open) => ({ priority: 'urgent', status: open.join(',') }),
  },
  {
    id: 'sla',
    label: 'SLA at risk',
    icon: 'clock',
    query: (open) => ({ sla: 'at_risk', status: open.join(',') }),
  },
];

export const viewById = (id: ViewId) => views.find((v) => v.id === id) ?? views[0]!;
