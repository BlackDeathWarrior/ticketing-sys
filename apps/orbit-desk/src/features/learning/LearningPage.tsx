import {
  type Caution,
  cautionText,
  CSAT_LABELS,
  LEARNING_MIN_RATINGS,
  type LearningOverview,
  type LearningReviewView,
  type LessonView,
  REVIEW_KIND_LABELS,
} from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Dialog, Input, Select, Textarea } from '../../components/ui';
import { cx } from '../../lib/format';
import { useGet } from '../../lib/useGet';
import settings from '../settings/Settings.module.css';
import { answerHeading, kbDraft, learningKpis, weekLabel } from './logic';
import styles from './Learning.module.css';

type Category = { id: string; name: string; isActive: boolean };
type DialogState =
  | { kind: 'lesson'; review?: LearningReviewView; lesson?: LessonView }
  | { kind: 'kb'; review: LearningReviewView }
  | null;

/**
 * Learning (#/learning): what customer ratings taught the AI. Reviewers turn
 * rated tickets into lessons or knowledge; the page also shows where the AI
 * holds answers back because customers rated them badly (ADR 0020).
 */
export function LearningPage({
  liveTick,
  onOpenTicket,
}: {
  liveTick: number;
  onOpenTicket: (id: string) => void;
}) {
  const overview = useGet<LearningOverview>('/learning/overview');
  const reviews = useGet<LearningReviewView[]>('/learning/reviews?status=open');
  const lessons = useGet<LessonView[]>('/learning/lessons');
  const categories = useGet<Category[]>('/categories');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadAll = () => {
    void overview.reload();
    void reviews.reload();
    void lessons.reload();
  };
  const { reload: reloadOverview } = overview;
  const { reload: reloadReviews } = reviews;
  useEffect(() => {
    if (!liveTick) return;
    void reloadOverview();
    void reloadReviews();
  }, [liveTick, reloadOverview, reloadReviews]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
    reloadAll();
  };

  const o = overview.data;
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Learning</p>
        <h1 className={styles.heading}>What ratings taught the AI</h1>
        <p className={styles.lede}>
          Customers rate solved tickets. Badly rated answers make the AI ask a person first; you
          decide what it should say instead. Customers’ comments are for you to read: the AI never
          takes instructions from them.
        </p>
      </header>

      {(overview.error ?? error) && (
        <p className={settings.error} role="alert">
          {overview.error ?? error}
        </p>
      )}
      {o && !o.enabled && (
        <p className={settings.note} role="status">
          Learning from ratings is switched off in Settings → AI behaviour: the AI ignores lessons
          and holds nothing back.
        </p>
      )}

      {o && (
        <>
          <section className={styles.kpis} aria-label="Learning figures">
            {learningKpis(o).map((k) => (
              <Card key={k.id} as="article" className={styles.kpi} data-kpi={k.id}>
                <p className={styles.kpiLabel}>{k.label}</p>
                <p className={cx(styles.kpiValue, 'tabular')}>{k.value}</p>
                <p className={styles.kpiContext}>{k.context}</p>
              </Card>
            ))}
          </section>

          <Card padding="md" aria-labelledby="weekly-title">
            <CardHeader
              id="weekly-title"
              title="Week by week"
              subtitle="The average rating of tickets the AI handled alone, for each of the last eight weeks"
            />
            <ol className={styles.weeks} aria-label="Average rating per week">
              {o.weekly.map((w) => (
                <li key={w.week} data-empty={w.responses === 0 || undefined}>
                  <span className={cx(styles.weekValue, 'tabular')}>
                    {w.average === null ? '—' : w.average.toFixed(1)}
                  </span>
                  <span className={styles.weekMeta}>
                    {w.responses} {w.responses === 1 ? 'rating' : 'ratings'}
                  </span>
                  <span className={styles.weekMeta}>from {weekLabel(w.week)}</span>
                </li>
              ))}
            </ol>
          </Card>
        </>
      )}

      <Card padding="md" aria-labelledby="reviews-title">
        <CardHeader
          id="reviews-title"
          title="To review"
          subtitle="Answers by the AI that were rated 1 or 2, and answers by people (after the AI passed the ticket on) that were rated 4 or 5"
        />
        {reviews.data?.length === 0 && (
          <p className={settings.note}>Nothing to review. New ratings appear here by themselves.</p>
        )}
        <ul className={styles.reviews}>
          {(reviews.data ?? []).map((r) => (
            <li key={r.id} className={styles.review} data-review={r.ticket.reference}>
              <p className={styles.reviewHead}>
                <span className={styles.kind}>{REVIEW_KIND_LABELS[r.kind]}</span>
                <span className="tabular">
                  {r.rating} / 5 · {CSAT_LABELS[r.rating]}
                </span>
              </p>
              <button
                type="button"
                className={styles.ticketLink}
                onClick={() => onOpenTicket(r.ticket.id)}
              >
                <span className={styles.reference}>{r.ticket.reference}</span>
                {r.ticket.subject}
              </button>
              <dl className={styles.exchange}>
                {r.question && (
                  <div>
                    <dt>The customer asked</dt>
                    <dd>{r.question}</dd>
                  </div>
                )}
                {r.answer && (
                  <div>
                    <dt>{answerHeading(r)}</dt>
                    <dd>{r.answer}</dd>
                  </div>
                )}
                {r.comment && (
                  <div>
                    <dt>The customer’s comment</dt>
                    <dd>“{r.comment}”</dd>
                  </div>
                )}
                {r.sources.length > 0 && (
                  <div>
                    <dt>Knowledge the AI used</dt>
                    <dd>{r.sources.join(' · ')}</dd>
                  </div>
                )}
              </dl>
              <div className={styles.reviewActions}>
                <Button size="sm" onClick={() => setDialog({ kind: 'lesson', review: r })}>
                  Write a lesson
                </Button>
                <Button size="sm" onClick={() => setDialog({ kind: 'kb', review: r })}>
                  Add to knowledge base
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void act(() =>
                      api('POST', `/learning/reviews/${r.id}/resolve`, { outcome: 'none' }),
                    )
                  }
                >
                  Nothing to change
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card padding="md" aria-labelledby="lessons-title">
        <CardHeader
          id="lessons-title"
          title="Lessons"
          subtitle="Short instructions the AI follows. Write them yourself, in your own words."
          actions={<Button onClick={() => setDialog({ kind: 'lesson' })}>Add lesson</Button>}
        />
        {lessons.data?.length === 0 && <p className={settings.note}>No lessons yet.</p>}
        <ul className={settings.ruleList}>
          {(lessons.data ?? []).map((l) => (
            <li key={l.id} className={settings.ruleRow} data-lesson={l.id}>
              <div className={l.active ? undefined : settings.dim}>
                <p className={styles.lessonBody}>{l.body}</p>
                <p className={settings.muted}>
                  {l.category ? `For ${l.category.name} tickets` : 'For every ticket'}
                  {l.sourceTicket ? ` · from ${l.sourceTicket.reference}` : ''}
                  {l.createdBy ? ` · by ${l.createdBy}` : ''}
                  {l.active ? '' : ' · switched off'}
                </p>
              </div>
              <div className={settings.actions}>
                <Button size="sm" onClick={() => setDialog({ kind: 'lesson', lesson: l })}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void act(() => api('PATCH', `/learning/lessons/${l.id}`, { active: !l.active }))
                  }
                >
                  {l.active ? 'Switch off' : 'Switch on'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm('Delete this lesson? The AI stops following it.'))
                      void act(() => api('DELETE', `/learning/lessons/${l.id}`));
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {o && <Cautions cautions={o.cautions} windowDays={o.windowDays} />}

      <LessonDialog
        state={dialog?.kind === 'lesson' ? dialog : null}
        categories={(categories.data ?? []).filter((c) => c.isActive)}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null);
          reloadAll();
        }}
      />
      <KbDialog
        review={dialog?.kind === 'kb' ? dialog.review : null}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null);
          reloadAll();
        }}
      />
    </div>
  );
}

function Cautions({ cautions, windowDays }: { cautions: Caution[]; windowDays: number }) {
  return (
    <Card padding="md" aria-labelledby="cautions-title">
      <CardHeader
        id="cautions-title"
        title="Where the AI asks a person first"
        subtitle={`Topics and documents whose answers customers rated 2.5 or lower on average, with at least ${LEARNING_MIN_RATINGS} ratings in ${windowDays} days. The AI still writes the answer; a person approves it.`}
      />
      {cautions.length === 0 ? (
        <p className={settings.note}>Nothing is held back: no topic or document is rated badly.</p>
      ) : (
        <ul className={styles.cautions} aria-label="Held back">
          {cautions.map((c) => (
            <li key={`${c.kind}-${c.id}`} data-caution={c.kind}>
              <span>{cautionText(c)}</span>
              <span className={settings.muted}>
                {c.kind === 'document'
                  ? 'Check the document in the Knowledge base.'
                  : 'Write a lesson, or improve the articles on this topic.'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function LessonDialog({
  state,
  categories,
  onClose,
  onSaved,
}: {
  state: { review?: LearningReviewView; lesson?: LessonView } | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [body, setBody] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setBody(state?.lesson?.body ?? '');
    setCategoryId(state?.lesson?.category?.id ?? state?.review?.category?.id ?? '');
    setError(null);
  }, [state]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const lesson = { body: body.trim(), categoryId: categoryId || null };
    try {
      if (state?.lesson) await api('PATCH', `/learning/lessons/${state.lesson.id}`, lesson);
      else if (state?.review) {
        await api('POST', `/learning/reviews/${state.review.id}/resolve`, {
          outcome: 'lesson',
          ...lesson,
        });
      } else await api('POST', '/learning/lessons', lesson);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={state !== null} onClose={onClose} labelledBy="lesson-dialog-title">
      <form className={settings.form} onSubmit={save} aria-label="Lesson">
        <h2 id="lesson-dialog-title" className={settings.dialogTitle}>
          {state?.lesson ? 'Edit the lesson' : 'Write a lesson for the AI'}
        </h2>
        {state?.review && (
          <p className={settings.dialogLede}>
            From {state.review.ticket.reference}, rated {state.review.rating} out of 5.
          </p>
        )}
        <Textarea
          id="lesson-body"
          label="What should the AI do?"
          rows={4}
          minLength={10}
          maxLength={500}
          placeholder="When customers ask about …, tell them: …"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
        />
        <p className={settings.note}>
          Write it yourself. Don’t paste what a customer wrote: the AI follows lessons like
          instructions.
        </p>
        <Select
          id="lesson-category"
          label="Applies to"
          value={categoryId}
          options={[
            { value: '', label: 'Every ticket' },
            ...categories.map((c) => ({ value: c.id, label: `${c.name} tickets` })),
          ]}
          onChange={(e) => setCategoryId(e.target.value)}
        />
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.formActions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            Save lesson
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function KbDialog({
  review,
  onClose,
  onSaved,
}: {
  review: LearningReviewView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const draft = review ? kbDraft(review) : { title: '', content: '' };
    setTitle(draft.title);
    setContent(draft.content);
    setError(null);
  }, [review]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!review) return;
    setSaving(true);
    setError(null);
    try {
      await api('POST', `/learning/reviews/${review.id}/resolve`, {
        outcome: 'kb',
        title: title.trim(),
        content: content.trim(),
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={review !== null} onClose={onClose} labelledBy="kb-dialog-title">
      <form className={settings.form} onSubmit={save} aria-label="Knowledge base draft">
        <h2 id="kb-dialog-title" className={settings.dialogTitle}>
          Add to the knowledge base
        </h2>
        <p className={settings.dialogLede}>
          Saved as a draft question and answer. Customers and the AI see it once someone approves it
          in the Knowledge base.
        </p>
        <Input
          id="kb-title"
          label="The question, as a customer would ask it"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <Textarea
          id="kb-content"
          label="The answer"
          rows={6}
          minLength={10}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
        />
        <p className={settings.note}>
          Remove names, order numbers and anything else about this one customer.
        </p>
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.formActions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            Save draft
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
