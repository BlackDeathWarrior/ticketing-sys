import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AiBehaviour } from '@tms/shared';
import type Redis from 'ioredis';
import { REDIS } from '../infra/tokens';
import { KbService } from '../kb/kb.service';
import { LlmClientService } from '../llm/llm-client.service';

/** An answer that needed no chat model. */
export interface FastAnswer {
  route: 'smalltalk' | 'faq' | 'cache' | 'card_link';
  reply: string;
  confidence: number;
  intent: string;
  /** Whether the reply settles what was asked (it then ends with "anything else?"). */
  resolves: boolean;
  sources: Array<{ chunkId: string; label: string }>;
  /** One line for the AI run, e.g. "FAQ: When will my refund arrive? (0.91)". */
  summary: string;
}

/** An answer the AI gave before, kept for the next person who asks the same thing. */
interface CachedAnswer {
  reply: string;
  confidence: number;
  intent: string | null;
  sources: Array<{ chunkId: string; label: string }>;
}

/** How much closer the best FAQ entry must be than the next one, so two similar entries are not guessed between. */
const FAQ_MARGIN = 0.03;
const FAQ_MAX_QUESTION = 200;
const FAQ_MAX_ANSWER = 1500;
const CACHE_MAX_QUESTION = 300;
const FAQ_LIST_TTL_MS = 30_000;
const CACHE_PREFIX = 'tms:ai:answer:';
const SAVED_PREFIX = 'tms:ai:saved:';

/** A message that points at something of the customer's own (an order, an amount): never answered from a general entry. */
const SPECIFIC = /\b[A-Z]{2,5}-?\d{3,}\b|\d{5,}|@/;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const normalise = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();

/**
 * Answers that cost no chat-model tokens (feature "fast paths", ADR 0030):
 *
 * - an approved FAQ entry whose own question is what the customer asked: its
 *   stored answer is the reply. The questions are compared by embedding, so
 *   "how long do refunds take" finds "When will my refund arrive?";
 * - the answer the AI gave the last time this exact first question was
 *   asked, while the knowledge base has not changed since.
 *
 * Both are only for a general question: a message that names an order, or a
 * ticket that came with context from the app, goes to the model.
 */
@Injectable()
export class AiFastPathsService {
  private readonly logger = new Logger(AiFastPathsService.name);
  private faqs?: { at: number; value: Awaited<ReturnType<KbService['publicFaqs']>> };

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly kb: KbService,
    private readonly llm: LlmClientService,
  ) {}

  private async knowledge() {
    if (!this.faqs || Date.now() - this.faqs.at > FAQ_LIST_TTL_MS) {
      this.faqs = { at: Date.now(), value: await this.kb.publicFaqs() };
    }
    return this.faqs.value;
  }

  /** The FAQ entry that answers `question`, if one clearly does. */
  async faq(
    question: string,
    settings: AiBehaviour['fastPaths'],
    ctx: { ticketId?: string | null },
  ): Promise<FastAnswer | null> {
    if (!settings.faq || question.length > FAQ_MAX_QUESTION || SPECIFIC.test(question)) return null;
    try {
      const { faqs } = await this.knowledge();
      if (!faqs.length) return null;
      // Query embeddings are cached by the client, so the FAQ questions are embedded once.
      const [asked, ...entries] = (
        await this.llm.embed([question, ...faqs.map((f) => f.question)], {
          ticketId: ctx.ticketId ?? undefined,
        })
      ).vectors;
      const ranked = entries
        .map((v, i) => ({ faq: faqs[i]!, similarity: cosine(asked!, v) }))
        .sort((a, b) => b.similarity - a.similarity);
      const best = ranked[0]!;
      const next = ranked[1]?.similarity ?? 0;
      if (best.similarity < settings.faqMinSimilarity || best.similarity - next < FAQ_MARGIN) {
        return null;
      }
      return {
        route: 'faq',
        reply: best.faq.answer.slice(0, FAQ_MAX_ANSWER),
        confidence: Math.min(1, Math.round(best.similarity * 100) / 100),
        intent: 'faq',
        resolves: true,
        sources: [{ chunkId: `faq:${best.faq.id}`, label: `FAQ · ${best.faq.question}` }],
        summary: `FAQ entry "${best.faq.question.slice(0, 80)}" (${best.similarity.toFixed(2)}); no model was asked`,
      };
    } catch (err) {
      // No embedding model, or it failed: the model path still works.
      this.logger.debug(`FAQ match skipped: ${(err as Error).message}`);
      return null;
    }
  }

  private async cacheKey(question: string, scope: string): Promise<string | null> {
    const q = normalise(question);
    if (!q || question.length > CACHE_MAX_QUESTION || SPECIFIC.test(question)) return null;
    const { revision } = await this.knowledge();
    return CACHE_PREFIX + createHash('sha256').update(`${scope}|${revision}|${q}`).digest('hex');
  }

  /** The answer given before to this exact first question, in the same scope. */
  async cached(
    question: string,
    scope: string,
    settings: AiBehaviour['fastPaths'],
  ): Promise<FastAnswer | null> {
    if (!settings.answerCache) return null;
    try {
      const key = await this.cacheKey(question, scope);
      const raw = key ? await this.redis.get(key) : null;
      if (!raw) return null;
      const hit = JSON.parse(raw) as CachedAnswer;
      return {
        route: 'cache',
        reply: hit.reply,
        confidence: hit.confidence,
        intent: hit.intent ?? 'repeat_question',
        resolves: true,
        sources: hit.sources,
        summary: 'The same question was answered before; no model was asked',
      };
    } catch (err) {
      this.logger.debug(`answer cache read skipped: ${(err as Error).message}`);
      return null;
    }
  }

  /** Keeps an answer for the next person who asks the same first question. Losing it is harmless. */
  async remember(
    question: string,
    scope: string,
    settings: AiBehaviour['fastPaths'],
    answer: CachedAnswer,
  ): Promise<void> {
    if (!settings.answerCache) return;
    try {
      const key = await this.cacheKey(question, scope);
      if (key) {
        await this.redis.set(key, JSON.stringify(answer), 'EX', settings.answerCacheHours * 3600);
      }
    } catch (err) {
      this.logger.debug(`answer cache write skipped: ${(err as Error).message}`);
    }
  }

  /** Counts a turn answered without a chat model, by day, for the usage page. */
  async count(route: FastAnswer['route'] | 'closing' | 'guard'): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.redis
      .multi()
      .hincrby(`${SAVED_PREFIX}${day}`, route, 1)
      .expire(`${SAVED_PREFIX}${day}`, 40 * 86_400)
      .exec()
      .catch(() => undefined);
  }

  /** Turns answered without a chat model over the last `days` days, by route. */
  async saved(days = 30): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    try {
      for (let i = 0; i < days; i++) {
        const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
        const row = await this.redis.hgetall(`${SAVED_PREFIX}${day}`);
        for (const [route, n] of Object.entries(row)) {
          totals[route] = (totals[route] ?? 0) + Number(n);
        }
      }
    } catch {
      // Redis away: nothing to show, nothing lost.
    }
    return totals;
  }
}
