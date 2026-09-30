export type TicketStatus = 'open' | 'in_progress' | 'waiting' | 'resolved';
export type Priority = 'urgent' | 'high' | 'medium' | 'low';
export type Channel = 'email' | 'chat' | 'phone' | 'web';

export interface Agent {
  id: string;
  name: string;
  initials: string;
  team: string;
  capacity: number;
}

export interface Customer {
  name: string;
  company: string;
  email: string;
  initials: string;
  plan: 'Starter' | 'Growth' | 'Enterprise';
}

export interface Message {
  id: string;
  kind: 'customer' | 'agent' | 'note';
  author: string;
  initials: string;
  body: string;
  minutesAgo: number;
}

export interface Ticket {
  id: string;
  subject: string;
  customer: Customer;
  status: TicketStatus;
  priority: Priority;
  assigneeId: string | null;
  channel: Channel;
  tags: string[];
  updatedMinutesAgo: number;
  /** Minutes until the SLA target; negative means breached. Null once resolved. */
  slaMinutes: number | null;
  messages: Message[];
}

export interface Activity {
  id: string;
  actor: string;
  initials: string;
  action: string;
  target: string;
  minutesAgo: number;
}
