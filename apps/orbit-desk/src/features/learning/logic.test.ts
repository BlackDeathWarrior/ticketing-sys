import type { LearningOverview } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import { answerHeading, kbDraft, learningKpis, trendText, weekLabel } from './logic';

const none = { responses: 0, average: null, satisfied: null };
const overview = (over: Partial<LearningOverview> = {}): LearningOverview => ({
  enabled: true,
  windowDays: 90,
  aiRating: {
    current: { responses: 6, average: 4.33, satisfied: 0.83 },
    previous: { responses: 4, average: 3.75, satisfied: 0.5 },
  },
  weekly: [],
  openReviews: 2,
  activeLessons: 3,
  cautions: [{ kind: 'document', id: 'd1', name: 'Returns policy', average: 1.7, ratings: 3 }],
  ...over,
});

describe('learning figures', () => {
  it('says how the AI’s rating moved', () => {
    const o = overview();
    expect(trendText(o.aiRating.current, o.aiRating.previous)).toBe('6 ratings · up from 3.8');
    expect(trendText({ ...o.aiRating.current, average: 3.2 }, o.aiRating.previous)).toBe(
      '6 ratings · down from 3.8',
    );
    expect(trendText({ ...o.aiRating.current, average: 3.76 }, o.aiRating.previous)).toBe(
      '6 ratings · the same as the 30 days before',
    );
    expect(trendText(o.aiRating.current, none)).toBe('6 ratings · none in the 30 days before');
    expect(trendText(none, o.aiRating.previous)).toBe('No ratings in the last 30 days');
  });

  it('builds the four figures', () => {
    const kpis = learningKpis(overview());
    expect(kpis.map((k) => [k.id, k.value])).toEqual([
      ['ai-rating', '4.3 / 5'],
      ['reviews', '2'],
      ['lessons', '3'],
      ['cautions', '1'],
    ]);
    expect(kpis[3]!.context).toBe('A topic or document customers rated badly');
    const quiet = learningKpis(
      overview({ openReviews: 0, cautions: [], aiRating: { current: none, previous: none } }),
    );
    expect(quiet.map((k) => k.value)).toEqual(['—', '0', '3', '0']);
    expect(quiet[1]!.context).toBe('Nothing to review');
    expect(quiet[3]!.context).toBe('No topic or document is rated badly');
  });

  it('labels a week by its first day', () => {
    expect(weekLabel('2026-10-06')).toBe('6 Oct');
  });
});

describe('reviews', () => {
  const review = {
    ticket: { id: 't', reference: 'TMS-46', subject: 'Chat: damaged cargo bike' },
    question: '  My cargo bike\narrived damaged. What now? ',
    answer: ' Send two photos within 14 days. ',
  };

  it('says who answered', () => {
    expect(answerHeading({ kind: 'low_rating' })).toBe('The AI answered');
    expect(answerHeading({ kind: 'good_answer' })).toBe('A person answered');
  });

  it('starts a knowledge base draft from the question and the answer', () => {
    expect(kbDraft(review)).toEqual({
      title: 'My cargo bike arrived damaged. What now?',
      content: 'Send two photos within 14 days.',
    });
    // No question on record: the ticket's subject stands in. Long ones are cut.
    expect(kbDraft({ ...review, question: null }).title).toBe('Chat: damaged cargo bike');
    expect(kbDraft({ ...review, question: 'x'.repeat(300) }).title).toHaveLength(188);
    expect(kbDraft({ ...review, answer: null }).content).toBe('');
  });
});
