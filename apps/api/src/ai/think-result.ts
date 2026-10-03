import type { AiDecision, AiRule, MessageCard } from '@tms/shared';

/** What one pass of the agent came to: the model's answer once judged, or a fixed outcome. */
export interface ThinkResult {
  decision: Exclude<AiDecision, 'skipped'>;
  reply: string | null;
  confidence: number | null;
  selfConfidence: number | null;
  rules: AiRule[];
  handoverReason: string | null;
  language: string | null;
  intent: string | null;
  resolves: boolean;
  /** The model says the message has nothing to do with the company. */
  offTopic: boolean;
  ticketUpdate: { category?: string; priority?: 'urgent' | 'high' | 'normal' | 'low' };
  tools: Array<{ name: string; summary: string }>;
  sources: Array<{ chunkId: string; label: string }>;
  /** Items the reply shows as picture cards (WhatsApp only): ones a tool returned this turn. */
  cards: MessageCard[];
  seenSources: string[];
  model: string | null;
  costUsd: number;
  latencyMs: number;
  error: string | null;
}

/** A turn that did nothing yet: hands over unless the model says otherwise. */
export function blankResult(language: string | null): ThinkResult {
  return {
    decision: 'handover',
    reply: null,
    confidence: null,
    selfConfidence: null,
    rules: [],
    handoverReason: null,
    language,
    intent: null,
    resolves: false,
    offTopic: false,
    ticketUpdate: {},
    tools: [],
    sources: [],
    cards: [],
    seenSources: [],
    model: null,
    costUsd: 0,
    latencyMs: 0,
    error: null,
  };
}
