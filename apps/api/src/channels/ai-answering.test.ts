import { describe, expect, it } from 'vitest';
import { aiIsAnswering } from './ai-answering';

const answering = { heldBy: 'ai', mode: 'auto' as const, customerWroteLast: true };

describe('"the assistant is answering"', () => {
  it('is true while the AI holds the conversation, sends by itself and the customer wrote last', () => {
    expect(aiIsAnswering(answering)).toBe(true);
  });

  it.each([
    ['a person holds the conversation', { heldBy: 'human' }],
    ['the AI only drafts on this channel', { mode: 'draft' as const }],
    ['the AI is off on this channel', { mode: 'off' as const }],
    ['we wrote last', { customerWroteLast: false }],
    ['the ticket is resolved or closed', { settled: true }],
  ])('is false when %s', (_why, change) => {
    expect(aiIsAnswering({ ...answering, ...change })).toBe(false);
  });
});
