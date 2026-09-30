import type { AiClassification, StatusCategory } from '@tms/shared';
import type {
  Channel,
  Conversation,
  Customer,
  Message,
  Person,
  Priority,
  StatusGlyphKind,
  StatusInfo,
  Thread,
  Ticket,
  Workflow,
} from './types';

// ---- API response shapes (what the endpoints return) ----

export interface ApiRef {
  id: string;
  name: string;
}

export interface ApiTicket {
  id: string;
  number: number;
  reference: string;
  subject: string;
  description: string | null;
  channel: string;
  priority: string;
  status: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  customer: {
    id: string;
    displayName: string;
    primaryEmail?: string | null;
    customerType?: string;
    attributes?: Record<string, unknown>;
  };
  assignee: ApiRef | null;
  team: ApiRef | null;
  category?: ApiRef | null;
  subcategory?: ApiRef | null;
  aiClassification?: AiClassification | null;
}

export interface ApiWorkflow {
  statuses: Array<{
    key: string;
    name: string;
    category: string;
    isActive: boolean;
    sortOrder: number;
  }>;
  transitions: Array<{ fromStatus: string; toStatus: string }>;
}

export interface ApiNote {
  id: string;
  body: string;
  createdAt: string;
  author: ApiRef | null;
  /** user | ai | system */
  authorType?: string;
}

export interface ApiConversation {
  id: string;
  channel: string;
  /** ai | human | none: who answers the next customer message. */
  controller?: string;
  lastMessageAt: string | null;
  metadata: { visitorName?: string; address?: string };
  messages: Array<{
    id: string;
    direction: 'inbound' | 'outbound';
    authorType: string;
    authorUserId: string | null;
    authorName: string | null;
    body: string;
    createdAt: string;
    deliveryStatus: string | null;
    attachments?: Array<{ filename: string; size: number; contentType: string }>;
    metadata?: {
      ai?: { confidence?: number | null; rules?: string[]; sources?: Array<{ label: string }> };
    };
  }>;
}

// ---- helpers ----

export function initials(name: string): string {
  const parts = name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

export const person = (ref: ApiRef): Person => ({
  id: ref.id,
  name: ref.name,
  initials: initials(ref.name),
});

const PLAN_LABELS: Record<string, string> = {
  standard: 'Standard',
  vip: 'VIP',
  business: 'Business',
  internal: 'Internal',
};

/**
 * Glyph for a workflow status. The category decides the shape; within "open",
 * a status someone is actively working gets the half-filled glyph.
 */
export function glyphFor(key: string, category: string): StatusGlyphKind {
  if (category === 'pending') return 'waiting';
  if (category === 'resolved' || category === 'closed') return 'resolved';
  return key === 'in_progress' ? 'in_progress' : 'open';
}

export function toWorkflow(w: ApiWorkflow): Workflow {
  return {
    statuses: w.statuses
      .filter((s) => s.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((s) => ({
        key: s.key,
        name: s.name,
        category: s.category as StatusCategory,
        glyph: glyphFor(s.key, s.category),
      })),
    transitions: w.transitions.map((t) => ({ from: t.fromStatus, to: t.toStatus })),
  };
}

/** Status info for a key, tolerating statuses missing from the loaded workflow. */
export function statusInfo(workflow: Workflow | undefined, key: string): StatusInfo {
  const found = workflow?.statuses.find((s) => s.key === key);
  if (found) return found;
  const name = key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return { key, name, category: 'open', glyph: glyphFor(key, 'open') };
}

/** Statuses the workflow allows moving to from `from`. */
export function nextStatuses(workflow: Workflow, from: string): StatusInfo[] {
  const targets = new Set(workflow.transitions.filter((t) => t.from === from).map((t) => t.to));
  return workflow.statuses.filter((s) => targets.has(s.key));
}

export const isOpenCategory = (c: StatusCategory) => c === 'open' || c === 'pending';

export function toCustomer(c: ApiTicket['customer']): Customer {
  const company = c.attributes?.company;
  return {
    id: c.id,
    name: c.displayName,
    initials: initials(c.displayName),
    email: c.primaryEmail ?? null,
    company: typeof company === 'string' && company.trim() ? company : null,
    plan: PLAN_LABELS[c.customerType ?? 'standard'] ?? 'Standard',
  };
}

export function toTicket(t: ApiTicket, workflow: Workflow | undefined): Ticket {
  return {
    id: t.id,
    number: t.number,
    reference: t.reference,
    subject: t.subject,
    description: t.description,
    customer: toCustomer(t.customer),
    status: statusInfo(workflow, t.status),
    priority: t.priority as Priority,
    assignee: t.assignee ? person(t.assignee) : null,
    team: t.team,
    categoryLabel: t.category?.name
      ? [t.category.name, t.subcategory?.name].filter(Boolean).join(' › ')
      : null,
    channel: t.channel as Channel,
    tags: t.tags,
    createdAt: new Date(t.createdAt),
    updatedAt: new Date(t.updatedAt),
    aiClassification: t.aiClassification ?? null,
  };
}

/**
 * One chronological thread from a ticket's description, its conversations'
 * messages and its internal notes.
 */
export function toThread(
  ticket: Ticket,
  conversations: ApiConversation[],
  notes: ApiNote[],
): Thread {
  const messages: Message[] = [];
  const hasInbound = conversations.some((c) => c.messages.some((m) => m.direction === 'inbound'));
  if (ticket.description && !hasInbound) {
    messages.push({
      id: `desc-${ticket.id}`,
      kind: 'customer',
      author: ticket.customer.name,
      initials: ticket.customer.initials,
      authorId: null,
      body: ticket.description,
      at: ticket.createdAt,
      delivery: null,
      channel: null,
      byAi: false,
      attachments: [],
      ai: null,
    });
  }
  for (const c of conversations) {
    for (const m of c.messages) {
      // A draft the agent threw away is not part of the conversation.
      if (m.deliveryStatus === 'discarded') continue;
      const fromCustomer = m.direction === 'inbound';
      const byAi = !fromCustomer && m.authorType === 'ai';
      const author = fromCustomer
        ? (c.metadata.visitorName ?? ticket.customer.name)
        : byAi
          ? 'AI agent'
          : (m.authorName ?? (m.authorType === 'system' ? 'System' : 'Support'));
      const meta = m.metadata?.ai;
      messages.push({
        id: m.id,
        kind: fromCustomer
          ? 'customer'
          : byAi
            ? 'ai'
            : m.authorType === 'agent'
              ? 'agent'
              : 'system',
        author,
        initials: byAi ? 'AI' : initials(author),
        authorId: m.authorUserId,
        body: m.body,
        at: new Date(m.createdAt),
        delivery: fromCustomer ? null : m.deliveryStatus,
        channel: c.channel,
        byAi,
        attachments: (m.attachments ?? []).map((a, i) => ({
          filename: a.filename,
          size: a.size,
          path: `/messages/${m.id}/attachments/${i}`,
        })),
        ai:
          byAi && meta
            ? {
                confidence: meta.confidence ?? null,
                rules: meta.rules ?? [],
                sources: meta.sources ?? [],
              }
            : null,
      });
    }
  }
  for (const n of notes) {
    const byAi = n.authorType === 'ai';
    const author = byAi ? 'AI agent' : (n.author?.name ?? 'Former user');
    messages.push({
      id: n.id,
      kind: 'note',
      author,
      initials: byAi ? 'AI' : initials(author),
      authorId: n.author?.id ?? null,
      body: n.body,
      at: new Date(n.createdAt),
      delivery: null,
      channel: null,
      byAi,
      attachments: [],
      ai: null,
    });
  }
  messages.sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    messages,
    aiControlled: conversations.some((c) => c.controller === 'ai'),
    conversations: conversations.map((c): Conversation => ({
      id: c.id,
      channel: c.channel,
      lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt) : null,
    })),
  };
}

/** The conversation a reply goes to: the most recently active one. */
export function replyTarget(thread: Thread): Conversation | null {
  const sorted = [...thread.conversations].sort(
    (a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0),
  );
  return sorted[0] ?? null;
}

export const channelLabels: Record<Channel, string> = {
  email: 'Email',
  webchat: 'Web chat',
  whatsapp: 'WhatsApp',
  voice: 'Phone',
  web_form: 'Web form',
  agent: 'Agent-created',
};

export const channelIcons = {
  email: 'mail',
  webchat: 'chat',
  whatsapp: 'chat',
  voice: 'phone',
  web_form: 'list',
  agent: 'user',
} as const satisfies Record<Channel, string>;

/** Minutes between `date` and `now`, never negative. */
export const minutesSince = (date: Date, now = new Date()) =>
  Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
