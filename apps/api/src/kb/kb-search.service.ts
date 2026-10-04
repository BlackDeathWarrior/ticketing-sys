import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, kbChunks, kbDocuments } from '@tms/db';
import {
  type CurrentUser,
  KB_EMBEDDING_DIMENSIONS,
  type KbSearchHit,
  type KbSearchQuery,
  type KbSearchResult,
  type KbVisibility,
  reciprocalRankFusion,
} from '@tms/shared';
import { and, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import { DB } from '../infra/tokens';
import { LlmClientService } from '../llm/llm-client.service';
import { KbService } from './kb.service';

/** How many candidates each method contributes before fusion. */
const CANDIDATES = 40;
const SNIPPET_CHARS = 320;

export interface SearchContext {
  user?: CurrentUser;
  ticketId?: string | null;
}

/**
 * Hybrid search (ADR 0010): pgvector cosine similarity and Postgres full-text
 * rank, fused with reciprocal rank fusion. Only approved, indexed documents,
 * and only what the caller may read; `audience: 'customer'` keeps to public
 * documents. Without an embedding model it falls back to keywords.
 */
@Injectable()
export class KbSearchService {
  private readonly logger = new Logger(KbSearchService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly kb: KbService,
    private readonly llm: LlmClientService,
  ) {}

  async search(ctx: SearchContext, q: KbSearchQuery): Promise<KbSearchResult> {
    const where: SQL[] = [
      eq(kbDocuments.indexState, 'indexed'),
      eq(kbChunks.version, kbDocuments.indexedVersion),
      q.includeDrafts && ctx.user?.permissions.includes('kb:manage')
        ? inArray(kbDocuments.status, ['draft', 'approved'])
        : eq(kbDocuments.status, 'approved'),
    ];
    if (q.audience === 'customer') where.push(eq(kbDocuments.visibility, 'public'));
    else {
      const access = await this.kb.accessCondition(ctx.user);
      if (access) where.push(access);
    }

    const vector = await this.embedQuery(q.q, ctx.ticketId);
    const base = () =>
      this.db
        .select({ id: kbChunks.id })
        .from(kbChunks)
        .innerJoin(kbDocuments, eq(kbDocuments.id, kbChunks.documentId));

    // Any meaningful word may match (questions rarely contain every word of
    // the answer); ts_rank_cd rewards chunks that match more of them.
    const terms = keywordTerms(q.q);
    const tsquery = sql`to_tsquery('simple', ${terms.join(' | ') || 'x'})`;
    const [vectorRows, keywordRows] = await Promise.all([
      vector
        ? this.db
            .select({
              id: kbChunks.id,
              similarity: sql<number>`1 - (${kbChunks.embedding} <=> ${vector}::vector)`,
            })
            .from(kbChunks)
            .innerJoin(kbDocuments, eq(kbDocuments.id, kbChunks.documentId))
            .where(and(...where, isNotNull(kbChunks.embedding)))
            .orderBy(sql`${kbChunks.embedding} <=> ${vector}::vector`)
            .limit(CANDIDATES)
        : Promise.resolve([]),
      terms.length
        ? base()
            .where(and(...where, sql`${kbChunks.tsv} @@ ${tsquery}`))
            .orderBy(sql`ts_rank_cd(${kbChunks.tsv}, ${tsquery}, 1) desc`)
            .limit(CANDIDATES)
        : Promise.resolve([]),
    ]);

    const fused = reciprocalRankFusion([
      vectorRows.map((r) => r.id),
      keywordRows.map((r) => r.id),
    ]).slice(0, q.limit);
    if (!fused.length) return { query: q.q, mode: vector ? 'hybrid' : 'keyword', hits: [] };

    const similarity = new Map(vectorRows.map((r) => [r.id, r.similarity]));
    const keywordIds = new Set(keywordRows.map((r) => r.id));
    const rows = await this.db
      .select({
        chunk: kbChunks,
        title: kbDocuments.title,
        visibility: kbDocuments.visibility,
        source: kbDocuments.source,
        url: kbDocuments.url,
        s3Key: kbDocuments.s3Key,
      })
      .from(kbChunks)
      .innerJoin(kbDocuments, eq(kbDocuments.id, kbChunks.documentId))
      .where(
        inArray(
          kbChunks.id,
          fused.map((f) => f.id),
        ),
      );
    const byId = new Map(rows.map((r) => [r.chunk.id, r]));

    const hits: KbSearchHit[] = fused.flatMap(({ id, score }) => {
      const r = byId.get(id);
      if (!r) return [];
      const section = withinDocument(r.chunk.section, r.title);
      const matchedBy: KbSearchHit['matchedBy'] = [];
      if (similarity.has(id)) matchedBy.push('vector');
      if (keywordIds.has(id)) matchedBy.push('keyword');
      return [
        {
          chunkId: id,
          documentId: r.chunk.documentId,
          title: r.title,
          section,
          snippet: snippet(r.chunk.content, q.q),
          score,
          similarity: similarity.has(id) ? Math.max(0, Math.min(1, similarity.get(id)!)) : null,
          matchedBy,
          visibility: r.visibility as KbVisibility,
          version: r.chunk.version,
          citation: {
            label: section ? `${r.title} › ${section}` : r.title,
            url: r.url ?? (r.s3Key ? `/api/v1/kb/documents/${r.chunk.documentId}/file` : null),
          },
        },
      ];
    });
    return { query: q.q, mode: vector ? 'hybrid' : 'keyword', hits };
  }

  /** The query's embedding as a pgvector literal, or null to search by keywords only. */
  private async embedQuery(text: string, ticketId?: string | null): Promise<string | null> {
    try {
      const { vectors } = await this.llm.embed([text], {
        dimensions: KB_EMBEDDING_DIMENSIONS,
        ticketId,
      });
      const v = vectors[0];
      if (!v || v.length !== KB_EMBEDDING_DIMENSIONS) return null;
      return `[${v.join(',')}]`;
    } catch (err) {
      this.logger.warn(`query embedding failed, using keywords only: ${(err as Error).message}`);
      return null;
    }
  }
}

/**
 * The heading trail without the document's own title, which is usually the
 * top heading: "Billing FAQ › I was charged twice" under "Billing FAQ"
 * becomes "I was charged twice".
 */
export function withinDocument(section: string | null, title: string): string | null {
  if (!section) return null;
  if (section === title) return null;
  const prefix = `${title} › `;
  return section.startsWith(prefix) ? section.slice(prefix.length) : section;
}

/** Common English words that would match nearly every chunk. */
const STOPWORDS = new Set(
  'a an and are as at be by can do does for from has have how i if in is it its me my of on or our so that the their them then there these they this to was we what when where which who why will with you your'.split(
    ' ',
  ),
);

/** Lower-case words of a query, safe to join into a to_tsquery expression. */
export function keywordTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 30);
}

/** A window of the chunk around the first query word it contains. */
export function snippet(content: string, query: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= SNIPPET_CHARS) return text;
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  const lower = text.toLowerCase();
  const at =
    words
      .map((w) => lower.indexOf(w))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(at - 80, text.length - SNIPPET_CHARS));
  const piece = text.slice(start, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${piece.trim()}${start + SNIPPET_CHARS < text.length ? '…' : ''}`;
}
