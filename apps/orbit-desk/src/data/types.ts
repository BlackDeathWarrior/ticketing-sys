import type { AiClassification, Channel, Priority, StatusCategory } from '@tms/shared';

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
  /** "Category › Sub-category", as chosen by a person or the web form; null when unset. */
  categoryLabel: string | null;
  channel: Channel;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  /** What the AI classifier suggested, if it ran. */
  aiClassification: AiClassification | null;
}

export type MessageKind = 'customer' | 'agent' | 'ai' | 'note' | 'system';

export interface Message {
  id: string;
  kind: MessageKind;
  author: string;
  initials: string;
  authorId: string | null;
  body: string;
  at: Date;
  /** Outbound delivery state: pending, sent, failed, or draft (an AI reply awaiting review). */
  delivery: string | null;
  channel: string | null;
  /** Written by the AI agent (a reply, a draft or a handover note). */
  byAi: boolean;
  /** Files sent with the message (email, web form); `path` is the API download path. */
  attachments: Attachment[];
  /** What the AI recorded with its reply: confidence, rules, knowledge used. */
  ai: { confidence: number | null; rules: string[]; sources: Array<{ label: string }> } | null;
}

export interface Attachment {
  filename: string;
  size: number;
  path: string;
}

export interface Conversation {
  id: string;
  channel: string;
  lastMessageAt: Date | null;
}

export interface Thread {
  messages: Message[];
  conversations: Conversation[];
  /** Some conversation on the ticket is being answered by the AI right now. */
  aiControlled: boolean;
}

export interface Workflow {
  statuses: StatusInfo[];
  transitions: Array<{ from: string; to: string }>;
}
