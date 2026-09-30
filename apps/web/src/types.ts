/** Response shapes used by the barebones UI. */

export interface Ref {
  id: string;
  name: string;
}

export interface TicketView {
  id: string;
  number: number;
  reference: string;
  subject: string;
  description: string | null;
  channel: string;
  priority: string;
  status: string;
  resolution: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  customerId: string;
  customer: { id: string; displayName: string };
  assignee: Ref | null;
  team: Ref | null;
  category: Ref | null;
  subcategory: Ref | null;
}

export interface Workflow {
  statuses: Array<{ key: string; name: string; category: string; isActive: boolean }>;
  transitions: Array<{ fromStatus: string; toStatus: string }>;
}

export interface CustomerView {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  language: string | null;
  customerType: string;
  createdAt: string;
  identities?: Array<{ id: string; type: string; value: string; verified: boolean }>;
  recentTickets?: Array<{
    id: string;
    number: number;
    subject: string;
    status: string;
    channel: string;
    createdAt: string;
  }>;
}

export interface CategoryTree extends Ref {
  children: Ref[];
}

export interface Page<T> {
  items: T[];
  total: number;
}
