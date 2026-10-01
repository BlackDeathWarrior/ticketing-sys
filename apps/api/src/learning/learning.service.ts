import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { aiFeedback, aiLessons, type Database, learningReviews, users } from '@tms/db';
import {
  type Caution,
  type CsatSummary,
  type HandledBy,
  isLowRating,
  isPoorlyRated,
  isSatisfied,
  LEARNING_WINDOW_DAYS,
  type LearningOverview,
  type LearningReviewView,
  type LessonInput,
  LESSONS_PER_TURN,
  type LessonView,
  lessonSchema,
  rate,
  type ResolveReviewInput,
  type ReviewKind,
  type ReviewStatus,
} from '@tms/shared';
import { and, desc, eq, gte, isNull, or } from 'drizzle-orm';
import { AiRunsService } from '../ai/ai-runs.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import { ConversationsService } from '../conversations/conversations.service';
import { CsatService } from '../csat/csat.service';
import { DB } from '../infra/tokens';
import { KbService } from '../kb/kb.service';
import { OrgService } from '../org/org.service';
import { AiBehaviourService } from '../settings/ai-behaviour.service';
import { TicketsService } from '../tickets/tickets.service';

const DAY_MS = 86_400_000;
const SIGNALS_TTL_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Score {
  average: number;
  ratings: number;
}

interface Signals {
  at: number;
  topics: Map<string, Score>;
  documents: Map<string, Score>;
}

type Lesson = typeof aiLessons.$inferSelect;
type Review = typeof learningReviews.$inferSelect;

/**
 * The learning loop (ADR 0020). Ratings of tickets the AI answered are kept
 * as feedback; from it the service works out which topics and documents
 * customers rated badly (the AI then sends those answers to a person first),
 * and puts the tickets worth learning from in front of a reviewer, who can
 * turn them into a lesson or a knowledge base draft.
 */
@Injectable()
export class LearningService {
  private signals?: Signals;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly behaviour: AiBehaviourService,
    private readonly csat: CsatService,
    private readonly tickets: TicketsService,
    private readonly runs: AiRunsService,
    private readonly kb: KbService,
    private readonly conversations: ConversationsService,
    private readonly org: OrgService,
  ) {}

  // ---- what the AI is given each turn ----

  /** The lessons that apply to a ticket in this category: the general ones and its own. */
  async lessonsFor(categoryId: string | null): Promise<string[]> {
    if (!(await this.behaviour.get()).learnFromRatings) return [];
    const rows = await this.db
      .select({ body: aiLessons.body })
      .from(aiLessons)
      .where(
        and(
          eq(aiLessons.active, true),
          categoryId
            ? or(isNull(aiLessons.categoryId), eq(aiLessons.categoryId, categoryId))
            : isNull(aiLessons.categoryId),
        ),
      )
      .orderBy(desc(aiLessons.updatedAt))
      .limit(LESSONS_PER_TURN);
    return rows.map((r) => r.body);
  }

  /**
   * Reasons to hold an answer back for a person: customers rated the AI's
   * answers on this topic, or from these knowledge sources, badly.
   */
  async cautionFor(i: { categoryId: string | null; chunkIds: string[] }): Promise<Caution[]> {
    if (!(await this.behaviour.get()).learnFromRatings) return [];
    const s = await this.readSignals();
    if (!s.topics.size && !s.documents.size) return [];
    const out: Caution[] = [];
    const topic = i.categoryId ? s.topics.get(i.categoryId) : undefined;
    if (topic && isPoorlyRated(topic.average, topic.ratings)) {
      const name = (await this.categoryNames()).get(i.categoryId!) ?? 'this topic';
      out.push({ kind: 'topic', id: i.categoryId!, name, ...topic });
    }
    const chunks = i.chunkIds.filter((id) => UUID.test(id));
    if (chunks.length && s.documents.size) {
      const docs = await this.kb.documentsOfChunks(chunks);
      for (const doc of new Map([...docs.values()].map((d) => [d.id, d])).values()) {
        const score = s.documents.get(doc.id);
        if (score && isPoorlyRated(score.average, score.ratings)) {
          out.push({ kind: 'document', id: doc.id, name: doc.title, ...score });
        }
      }
    }
    return out;
  }

  // ---- ratings arriving ----

  /**
   * Called when a customer rates a ticket (or changes the rating). Keeps the
   * feedback row, and opens or withdraws the review for it.
   */
  async onRating(ticketId: string): Promise<void> {
    const rating = await this.csat.detail(ticketId);
    const turns = (await this.runs.forTicket(ticketId)).filter((r) => r.kind !== 'classify');
    const sent = turns.filter((r) => r.decision === 'sent');
    if (!rating || !turns.length || rating.handling === 'human') {
      // Not about the AI's work (any more).
      await this.db.delete(aiFeedback).where(eq(aiFeedback.ticketId, ticketId));
      await this.withdrawReview(ticketId);
      this.signals = undefined;
      return;
    }
    const ticket = await this.tickets.get(ticketId);
    const chunkIds = [...new Set(sent.flatMap((r) => r.sources.map((s) => s.chunkId)))].filter(
      (id) => UUID.test(id),
    );
    const documentIds = [
      ...new Set([...(await this.kb.documentsOfChunks(chunkIds)).values()].map((d) => d.id)),
    ];
    const values = {
      rating: rating.rating,
      handledBy: rating.handling,
      categoryId: ticket.categoryId,
      documentIds,
      ratedAt: new Date(),
    };
    await this.db
      .insert(aiFeedback)
      .values({ ticketId, ...values })
      .onConflictDoUpdate({ target: aiFeedback.ticketId, set: values });
    this.signals = undefined;

    const kind: ReviewKind | null =
      rating.handling === 'ai' && isLowRating(rating.rating)
        ? 'low_rating'
        : rating.handling === 'ai_then_human' && isSatisfied(rating.rating)
          ? 'good_answer'
          : null;
    if (!kind) return this.withdrawReview(ticketId);

    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(learningReviews)
        .where(eq(learningReviews.ticketId, ticketId))
        .for('update');
      if (existing) {
        // Someone already decided; a changed rating doesn't reopen it.
        if (existing.status !== 'open') return;
        await tx
          .update(learningReviews)
          .set({ kind, rating: rating.rating })
          .where(eq(learningReviews.id, existing.id));
        return;
      }
      const [row] = await tx
        .insert(learningReviews)
        .values({ ticketId, kind, rating: rating.rating })
        .returning({ id: learningReviews.id });
      const data = { reviewId: row!.id, ticketId, kind, rating: rating.rating };
      await this.audit.record(tx, SYSTEM_CTX, {
        action: 'learning.review_opened',
        targetType: 'ticket',
        targetId: ticketId,
        data,
      });
      await this.outbox.publish(tx, SYSTEM_CTX, {
        type: 'learning.review_opened',
        aggregateType: 'learning',
        aggregateId: row!.id,
        payload: data,
      });
    });
  }

  // ---- the reviewer's inbox ----

  async listReviews(q: { status: ReviewStatus; limit: number }): Promise<LearningReviewView[]> {
    const rows = await this.db
      .select()
      .from(learningReviews)
      .where(eq(learningReviews.status, q.status))
      .orderBy(desc(learningReviews.createdAt))
      .limit(q.limit);
    const out: LearningReviewView[] = [];
    for (const r of rows) {
      const view = await this.reviewView(r).catch(() => null);
      if (view) out.push(view);
    }
    return out;
  }

  /** The reviewer's decision: a lesson for the AI, a knowledge base draft, or nothing. */
  async resolveReview(
    ctx: RequestCtx,
    id: string,
    input: ResolveReviewInput,
  ): Promise<LearningReviewView> {
    const [review] = await this.db.select().from(learningReviews).where(eq(learningReviews.id, id));
    if (!review) throw new NotFoundException('Review not found');
    if (review.status !== 'open') return this.reviewView(review);

    let lessonId: string | null = null;
    let documentId: string | null = null;
    if (input.outcome === 'lesson') {
      lessonId = (
        await this.createLesson(
          ctx,
          { body: input.body, categoryId: input.categoryId },
          review.ticketId,
        )
      ).id;
    } else if (input.outcome === 'kb') {
      // A draft: it reaches customers only after someone approves it in the knowledge base.
      documentId = (
        await this.kb.create(ctx, {
          source: 'faq',
          title: input.title,
          content: input.content,
          visibility: 'public',
          teamId: null,
          language: null,
        })
      ).id;
    }
    const [updated] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(learningReviews)
        .set({
          status: input.outcome === 'none' ? 'dismissed' : 'done',
          outcome: input.outcome,
          lessonId,
          documentId,
          closedBy: ctx.user?.id ?? null,
          closedAt: new Date(),
        })
        .where(eq(learningReviews.id, id))
        .returning();
      const data = { reviewId: id, outcome: input.outcome, lessonId, documentId };
      await this.audit.record(tx, ctx, {
        action: 'learning.review_closed',
        targetType: 'ticket',
        targetId: review.ticketId,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'learning.review_closed',
        aggregateType: 'learning',
        aggregateId: id,
        payload: data,
      });
      return rows;
    });
    return this.reviewView(updated!);
  }

  // ---- lessons ----

  async listLessons(): Promise<LessonView[]> {
    const rows = await this.db
      .select({ lesson: aiLessons, author: users.name })
      .from(aiLessons)
      .leftJoin(users, eq(users.id, aiLessons.createdBy))
      .orderBy(desc(aiLessons.createdAt));
    const names = await this.categoryNames();
    const out: LessonView[] = [];
    for (const { lesson, author } of rows) {
      const ticket = lesson.sourceTicketId
        ? await this.tickets.get(lesson.sourceTicketId).catch(() => null)
        : null;
      out.push(lessonView(lesson, author, names, ticket));
    }
    return out;
  }

  async createLesson(
    ctx: RequestCtx,
    input: LessonInput,
    sourceTicketId: string | null = null,
  ): Promise<LessonView> {
    const parsed = lessonSchema.parse(input);
    const row = await this.db.transaction(async (tx) => {
      const [lesson] = await tx
        .insert(aiLessons)
        .values({ ...parsed, sourceTicketId, createdBy: ctx.user?.id ?? null })
        .returning();
      await this.lessonChanged(tx, ctx, lesson!.id, 'created', {
        categoryId: parsed.categoryId,
        active: parsed.active,
      });
      return lesson!;
    });
    return lessonView(row, ctx.user?.name ?? null, await this.categoryNames(), null);
  }

  async updateLesson(ctx: RequestCtx, id: string, patch: Partial<LessonInput>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(aiLessons)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(aiLessons.id, id))
        .returning({ id: aiLessons.id });
      if (!rows.length) throw new NotFoundException('Lesson not found');
      await this.lessonChanged(tx, ctx, id, 'updated', {
        fields: Object.keys(patch),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      });
    });
  }

  async deleteLesson(ctx: RequestCtx, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(aiLessons)
        .where(eq(aiLessons.id, id))
        .returning({ id: aiLessons.id });
      if (!rows.length) throw new NotFoundException('Lesson not found');
      await this.lessonChanged(tx, ctx, id, 'deleted', {});
    });
  }

  // ---- the overview ----

  async overview(now = new Date()): Promise<LearningOverview> {
    const since = new Date(now.getTime() - LEARNING_WINDOW_DAYS * DAY_MS);
    const rows = await this.db
      .select({ rating: aiFeedback.rating, ratedAt: aiFeedback.ratedAt })
      .from(aiFeedback)
      .where(and(eq(aiFeedback.handledBy, 'ai'), gte(aiFeedback.ratedAt, since)));
    const between = (fromDays: number, toDays: number) =>
      summary(
        rows
          .filter((r) => {
            const age = (now.getTime() - r.ratedAt.getTime()) / DAY_MS;
            return age >= toDays && age < fromDays;
          })
          .map((r) => r.rating),
      );
    // Eight weeks, oldest first; a week starts 7, 14, … days before now.
    const weekly = Array.from({ length: 8 }, (_, i) => {
      const s = between((8 - i) * 7, (7 - i) * 7);
      return {
        week: new Date(now.getTime() - (8 - i) * 7 * DAY_MS).toISOString().slice(0, 10),
        average: s.average,
        responses: s.responses,
      };
    });
    const [signals, openReviews, activeLessons, behaviour] = await Promise.all([
      this.readSignals(true),
      this.db.$count(learningReviews, eq(learningReviews.status, 'open')),
      this.db.$count(aiLessons, eq(aiLessons.active, true)),
      this.behaviour.get(),
    ]);
    return {
      enabled: behaviour.learnFromRatings,
      windowDays: LEARNING_WINDOW_DAYS,
      aiRating: { current: between(30, 0), previous: between(60, 30) },
      weekly,
      openReviews,
      activeLessons,
      cautions: await this.cautions(signals),
    };
  }

  // ---- internals ----

  private async cautions(s: Signals): Promise<Caution[]> {
    const poor = (m: Map<string, Score>) =>
      [...m.entries()].filter(([, v]) => isPoorlyRated(v.average, v.ratings));
    const topics = poor(s.topics);
    const documents = poor(s.documents);
    const [names, titles] = await Promise.all([
      this.categoryNames(),
      this.kb.titles(documents.map(([id]) => id)),
    ]);
    return [
      ...topics.map(([id, v]): Caution => ({
        kind: 'topic',
        id,
        name: names.get(id) ?? 'A category',
        ...v,
      })),
      ...documents.map(([id, v]): Caution => ({
        kind: 'document',
        id,
        name: titles.get(id) ?? 'A deleted document',
        ...v,
      })),
    ].sort((a, b) => a.average - b.average);
  }

  /** How customers rated the AI's own answers, by topic and by document, over the window. */
  private async readSignals(fresh = false): Promise<Signals> {
    if (!fresh && this.signals && Date.now() - this.signals.at < SIGNALS_TTL_MS) {
      return this.signals;
    }
    const since = new Date(Date.now() - LEARNING_WINDOW_DAYS * DAY_MS);
    const rows = await this.db
      .select()
      .from(aiFeedback)
      .where(and(eq(aiFeedback.handledBy, 'ai'), gte(aiFeedback.ratedAt, since)));
    const topics = new Map<string, number[]>();
    const documents = new Map<string, number[]>();
    const add = (m: Map<string, number[]>, key: string, rating: number) =>
      m.set(key, [...(m.get(key) ?? []), rating]);
    for (const r of rows) {
      if (r.categoryId) add(topics, r.categoryId, r.rating);
      for (const id of r.documentIds) add(documents, id, r.rating);
    }
    const score = (m: Map<string, number[]>) =>
      new Map(
        [...m.entries()].map(([k, v]) => [
          k,
          { average: round2(v.reduce((a, b) => a + b, 0) / v.length), ratings: v.length },
        ]),
      );
    this.signals = { at: Date.now(), topics: score(topics), documents: score(documents) };
    return this.signals;
  }

  /** A rating changed so that the ticket is no longer worth a review: close the open one. */
  private async withdrawReview(ticketId: string): Promise<void> {
    await this.db
      .update(learningReviews)
      .set({ status: 'dismissed', outcome: 'none', closedAt: new Date() })
      .where(and(eq(learningReviews.ticketId, ticketId), eq(learningReviews.status, 'open')));
  }

  private async reviewView(r: Review): Promise<LearningReviewView> {
    const ticket = await this.tickets.get(r.ticketId);
    const [convs, rating, runs] = await Promise.all([
      this.conversations.listForTicket(ticket.id),
      this.csat.detail(ticket.id),
      this.runs.forTicket(ticket.id),
    ]);
    const messages = convs
      .flatMap((c) => c.messages)
      .filter((m) => m.deliveryStatus !== 'draft' && m.deliveryStatus !== 'discarded')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const answeredBy = r.kind === 'low_rating' ? 'ai' : 'agent';
    return {
      id: r.id,
      kind: r.kind as ReviewKind,
      status: r.status as ReviewStatus,
      outcome: r.outcome as LearningReviewView['outcome'],
      ticket: { id: ticket.id, reference: ticket.reference, subject: ticket.subject },
      category: ticket.category?.id ? { id: ticket.category.id, name: ticket.category.name } : null,
      rating: rating?.rating ?? r.rating,
      comment: rating?.comment ?? null,
      handledBy: (rating?.handling ?? 'ai') as HandledBy,
      question: messages.find((m) => m.authorType === 'customer')?.body ?? null,
      answer: messages.filter((m) => m.authorType === answeredBy).at(-1)?.body ?? null,
      sources: [
        ...new Set(
          runs
            // Drafts count too: an approved draft is an answer the customer got.
            .filter((x) => x.decision === 'sent' || x.decision === 'drafted')
            .flatMap((x) => x.sources.map((s) => s.label)),
        ),
      ],
      createdAt: r.createdAt.toISOString(),
    };
  }

  private async categoryNames(): Promise<Map<string, string>> {
    const tree = await this.org.listCategories();
    return new Map(tree.flatMap((c) => [c, ...c.children]).map((c) => [c.id, c.name]));
  }

  private async lessonChanged(
    tx: Parameters<AuditService['record']>[0],
    ctx: RequestCtx,
    id: string,
    change: 'created' | 'updated' | 'deleted',
    data: Record<string, unknown>,
  ) {
    await this.audit.record(tx, ctx, {
      action: `learning.lesson_${change}`,
      targetType: 'ai_lesson',
      targetId: id,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'learning.lesson_changed',
      aggregateType: 'learning',
      aggregateId: id,
      payload: { change, ...data },
    });
  }
}

function lessonView(
  lesson: Lesson,
  author: string | null,
  categories: Map<string, string>,
  ticket: { id: string; reference: string } | null,
): LessonView {
  return {
    id: lesson.id,
    body: lesson.body,
    category: lesson.categoryId
      ? { id: lesson.categoryId, name: categories.get(lesson.categoryId) ?? 'A category' }
      : null,
    active: lesson.active,
    sourceTicket: ticket ? { id: ticket.id, reference: ticket.reference } : null,
    createdBy: author,
    createdAt: lesson.createdAt.toISOString(),
  };
}

function summary(ratings: number[]): CsatSummary {
  const n = ratings.length;
  return {
    responses: n,
    average: n ? round2(ratings.reduce((a, b) => a + b, 0) / n) : null,
    satisfied: rate(ratings.filter(isSatisfied).length, n),
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
