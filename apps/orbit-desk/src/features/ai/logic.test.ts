import { describe, expect, it } from 'vitest';
import { aiMetaText, classificationText, percent, ruleLabels } from './logic';

describe('AI display helpers', () => {
  it('formats confidence as a percentage', () => {
    expect(percent(0.9)).toBe('90%');
    expect(percent(null)).toBe('–');
  });

  it('describes a classification compactly, skipping neutral sentiment', () => {
    expect(
      classificationText({
        category: 'Billing',
        subcategory: 'Refund status',
        priority: 'high',
        language: 'hi',
        intent: 'refund_request',
        sentiment: 'neutral',
        confidence: 0.85,
        model: 'm',
        at: '2026-09-30T00:00:00Z',
      }),
    ).toBe('Billing › Refund status · refund_request · hi');
  });

  it('labels rules and ignores unknown ones', () => {
    expect(ruleLabels(['asked_for_human', 'something_else'])).toEqual([
      'The customer asked for a person',
    ]);
  });

  it('shows what an AI reply relied on', () => {
    expect(aiMetaText({ confidence: 0.9, sources: [{ label: 'Returns › Refund timing' }] })).toBe(
      'Confidence 90% · from Returns › Refund timing',
    );
    expect(aiMetaText({ confidence: 0.7, sources: [] })).toBe('Confidence 70% · no source cited');
  });
});
