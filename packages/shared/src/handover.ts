import { z } from 'zod';

/**
 * Who is answering a ticket right now (ADR 0014), kept on the ticket so the
 * queue can filter and report on it:
 * - `none`: nobody yet (a new ticket in the queue);
 * - `ai`: the AI agent owns the conversation;
 * - `human`: a person took it over or replied;
 * - `handed_over`: the AI passed it on and a person hasn't picked it up yet.
 */
export const TICKET_HANDLING = ['none', 'ai', 'human', 'handed_over'] as const;
export type TicketHandling = (typeof TICKET_HANDLING)[number];

export const HANDLING_LABELS: Record<TicketHandling, string> = {
  none: 'In the queue',
  ai: 'AI handling',
  human: 'Human handling',
  handed_over: 'Handed over',
};

export const HANDOVER_SOURCES = ['ai', 'agent', 'customer'] as const;
export type HandoverSource = (typeof HANDOVER_SOURCES)[number];

export const requestHandoverSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  /** Route to this team instead of asking the routing rules. */
  teamId: z.string().uuid().optional(),
});
export type RequestHandoverInput = z.infer<typeof requestHandoverSchema>;

/** What a person needs to pick a conversation up without rereading it (the context pack). */
export interface ContextPack {
  summary: string;
  intent: string | null;
  customer: { name: string; type: string; email: string | null; ticketCount: number };
  ticket: { reference: string; subject: string; priority: string; category: string | null };
  /** What the AI already did: replies, tools, approvals. */
  actions: string[];
  /** Data it looked up (tool results, knowledge used), one line each. */
  retrieved: string[];
  recommendedNextStep: string;
  /** `model` when an LLM wrote summary and next step; `rules` when it fell back to a template. */
  writtenBy: 'model' | 'rules';
}

export interface HandoverView {
  id: string;
  ticketId: string;
  conversationId: string | null;
  source: HandoverSource;
  reason: string;
  rules: string[];
  pack: ContextPack | null;
  packStatus: 'pending' | 'ready' | 'failed';
  routedTeam: { id: string; name: string } | null;
  routedUser: { id: string; name: string } | null;
  requestedBy: { id: string; name: string } | null;
  createdAt: string;
}

export const copilotSchema = z.object({
  /** An optional instruction, e.g. "apologise and offer an exchange". */
  instruction: z.string().trim().max(500).optional(),
});
export type CopilotInput = z.infer<typeof copilotSchema>;

export interface CopilotSuggestion {
  suggestion: string;
  sources: Array<{ chunkId: string; label: string }>;
  model: string | null;
}
