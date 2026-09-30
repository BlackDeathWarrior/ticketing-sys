import type { Channel, Priority, StatusCategory } from '@tms/shared';

export type { Channel, Priority, StatusCategory };

/** The four glyph shapes status is drawn with (DESIGN.md: no status colors). */
export type StatusGlyphKind = 'open' | 'in_progress' | 'waiting' | 'resolved';

export interface StatusInfo {
  key: string;
  name: string;
  category: StatusCategory;
  glyph: StatusGlyphKind;
}

export interface Person {
  id: string;
  name: string;
  initials: string;
}

export interface Customer extends Person {
  email: string | null;
  company: string | null;
  /** Customer type label: Standard, VIP, Business or Internal. */
  plan: string;
}

export interface Ticket {
  id: string;
  number: number;
  reference: string;
  subject: string;
  description: string | null;
  customer: Customer;
  status: StatusInfo;
  priority: Priority;
  assignee: Person | null;
  team: { id: string; name: string } | null;
  channel: Channel;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type MessageKind = 'customer' | 'agent' | 'note' | 'system';

export interface Message {
  id: string;
  kind: MessageKind;
  author: string;
  initials: string;
  authorId: string | null;
  body: string;
  at: Date;
  /** Outbound delivery state for agent replies: pending, sent or failed. */
  delivery: string | null;
  channel: string | null;
}

export interface Conversation {
  id: string;
  channel: string;
  lastMessageAt: Date | null;
}

export interface Thread {
  messages: Message[];
  conversations: Conversation[];
}

export interface Workflow {
  statuses: StatusInfo[];
  transitions: Array<{ from: string; to: string }>;
}
