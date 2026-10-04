import type {
  AiClassification,
  AiClosure,
  Channel,
  MessageCard,
  Priority,
  StatusCategory,
  TicketHandling,
} from '@tms/shared';
import type { SlaState } from '../lib/format';

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
  /** Digits-only phone number, when known. */
  phone: string | null;
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
  /** Who is answering: none | ai | human | handed_over. */
  handling: TicketHandling;
  /** Why the AI resolved or closed the ticket by itself; null when a person did, or it is open. */
  aiClosure: AiClosure | null;
  /** The most urgent SLA timer; null when no policy applies. */
  sla: { state: SlaState; minutes: number | null; label?: string; raw: string } | null;
  /** The outside app that raised the ticket through the API, by name. */
  integration: string | null;
  /** That app's id for what the ticket is about. */
  externalRef: string | null;
  /** Context the app sent along. Third-party data: shown as text, never trusted. */
  metadata: Record<string, unknown>;
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
  /**
   * Outbound delivery state: pending, sent, delivered, read, failed, or draft
   * (an AI reply awaiting review).
   */
  delivery: string | null;
  /** Why delivery failed, in plain words. */
  deliveryError: string | null;
  channel: string | null;
  /** Written by the AI agent (a reply, a draft or a handover note). */
  byAi: boolean;
  /** The customer wrote it in the portal, not on the conversation's channel. */
  viaPortal?: boolean;
  /** Files sent with the message (email, web form); `path` is the API download path. */
  attachments: Attachment[];
  /** What a voice message says, written down for the AI; null when nothing could be made out. Absent otherwise. */
  transcript?: string | null;
  /** Product cards shown with the message (WhatsApp carousel); absent when it had none. */
  cards?: MessageCard[];
  /** Why the cards were not shown and the reply went as text; absent when they were. */
  cardsDropped?: string;
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
  /** ai | human | none, and who when a person. */
  controller: string;
  controllerUserId: string | null;
  controllerName: string | null;
  /** WhatsApp only: when the customer last wrote (opens the 24-hour window). */
  lastInboundAt: string | null;
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
