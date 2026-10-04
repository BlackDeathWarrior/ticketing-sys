import { AI_RULE_LABELS, type AiClassification, type AiDecision, type AiRule } from '@tms/shared';

export const DECISION_LABELS: Record<AiDecision, string> = {
  sent: 'Answered',
  drafted: 'Drafted for review',
  handover: 'Handed over',
  skipped: 'Skipped',
  error: 'Failed',
  closed: 'Closed the conversation',
};

export const percent = (c: number | null) => (c === null ? '–' : `${Math.round(c * 100)}%`);

export function ruleLabels(rules: string[]): string[] {
  return rules.filter((r): r is AiRule => r in AI_RULE_LABELS).map((r) => AI_RULE_LABELS[r]);
}

/** "Billing › Refund status · refund_request · negative · hi" */
export function classificationText(c: AiClassification): string {
  return [
    c.category ? `${c.category}${c.subcategory ? ` › ${c.subcategory}` : ''}` : null,
    c.intent,
    c.sentiment && c.sentiment !== 'neutral' ? c.sentiment : null,
    c.language,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The line under an AI reply: its confidence and what it relied on. */
export function aiMetaText(ai: {
  confidence: number | null;
  sources: Array<{ label: string }>;
}): string {
  const sources = ai.sources.map((s) => s.label).join(', ');
  return [
    `Confidence ${percent(ai.confidence)}`,
    sources ? `from ${sources}` : 'no source cited',
  ].join(' · ');
}
