import type { CsatSummary, LearningOverview, LearningReviewView } from '@tms/shared';

export interface LearningKpi {
  id: string;
  label: string;
  value: string;
  context: string;
}

/** "up from 3.8", "down from 4.6", "the same as before", or what is missing. */
export function trendText(current: CsatSummary, previous: CsatSummary): string {
  if (current.average === null) return 'No ratings in the last 30 days';
  if (previous.average === null) return `${current.responses} ratings · none in the 30 days before`;
  const diff = Math.round((current.average - previous.average) * 10) / 10;
  const was = previous.average.toFixed(1);
  if (diff === 0) return `${current.responses} ratings · the same as the 30 days before`;
  return `${current.responses} ratings · ${diff > 0 ? 'up' : 'down'} from ${was}`;
}

export function learningKpis(o: LearningOverview): LearningKpi[] {
  const held = o.cautions.length;
  return [
    {
      id: 'ai-rating',
      label: 'Rating of the AI’s own tickets',
      value:
        o.aiRating.current.average === null ? '—' : `${o.aiRating.current.average.toFixed(1)} / 5`,
      context: trendText(o.aiRating.current, o.aiRating.previous),
    },
    {
      id: 'reviews',
      label: 'Waiting for review',
      value: String(o.openReviews),
      context: o.openReviews ? 'Rated tickets worth learning from' : 'Nothing to review',
    },
    {
      id: 'lessons',
      label: 'Lessons the AI follows',
      value: String(o.activeLessons),
      context: 'Written by staff after reading ratings',
    },
    {
      id: 'cautions',
      label: 'Held back for a person',
      value: String(held),
      context: held
        ? `${held === 1 ? 'A topic or document' : 'Topics and documents'} customers rated badly`
        : 'No topic or document is rated badly',
    },
  ];
}

/** "6 Oct" for a week's first day. */
export function weekLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** Who gave the answer under review, as a heading. */
export const answerHeading = (r: Pick<LearningReviewView, 'kind'>) =>
  r.kind === 'low_rating' ? 'The AI answered' : 'A person answered';

/**
 * A starting point for the knowledge base draft from a review: the question
 * as the title, the answer as the text. The reviewer edits both.
 */
export function kbDraft(r: Pick<LearningReviewView, 'question' | 'answer' | 'ticket'>) {
  const question = (r.question ?? r.ticket.subject).replace(/\s+/g, ' ').trim();
  return {
    title: question.length > 190 ? `${question.slice(0, 187)}…` : question,
    content: (r.answer ?? '').trim(),
  };
}
