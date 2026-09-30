import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, kbChunks, kbDocuments } from '@tms/db';
import { KB_EMBEDDING_DIMENSIONS } from '@tms/shared';
import { eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { SYSTEM_CTX } from '../common/request-context';
import type { Env } from '../config/env';
import { DB, ENV } from '../infra/tokens';
import { LlmClientService, LlmUnavailableError } from '../llm/llm-client.service';
import { StorageService } from '../storage/storage.service';
import { chunkText } from './chunker';
import { detectKind, extractText, htmlTitle, htmlToText } from './extract';
import { contentHash, KbService } from './kb.service';
import { fetchPublicUrl } from './url-fetch';

const EMBED_BATCH = 32;

export type IndexOutcome = 'indexed' | 'skipped';

/**
 * Turns a document version into chunks: extract text (file, URL or the
 * stored content), chunk it by heading, embed through the pinned
 * `embedding` role, and swap the chunks in one transaction. Without an
 * embedding model the document is indexed for keyword search only.
 */
@Injectable()
export class KbIndexerService {
  private readonly logger = new Logger(KbIndexerService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly kb: KbService,
    private readonly storage: StorageService,
    private readonly llm: LlmClientService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async index(documentId: string, version: number | null): Promise<IndexOutcome> {
    const doc = await this.kb.row(documentId).catch(() => null);
    if (!doc) return 'skipped';
    // A newer version is (or will be) queued; let that job do the work.
    if (version !== null && doc.version !== version) return 'skipped';

    await this.kb.markIndexing(doc.id);
    const { text, title } = await this.textFor(doc);
    const body = doc.source === 'faq' ? `# ${doc.title}\n\n${text}` : text;
    const chunks = chunkText(body);
    if (!chunks.length) throw new Error('No text could be extracted from this document');

    let vectors: Array<number[] | null> = chunks.map(() => null);
    let modelId: string | null = null;
    let mode: 'hybrid' | 'keyword' = 'hybrid';
    let note: string | null = null;
    try {
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const r = await this.llm.embed(
          batch.map((c) => (c.section ? `${c.section}\n${c.content}` : c.content)),
          { dimensions: KB_EMBEDDING_DIMENSIONS },
        );
        if (r.vectors.some((v) => v.length !== KB_EMBEDDING_DIMENSIONS)) {
          throw new DimensionError(r.vectors[0]?.length ?? 0);
        }
        vectors.splice(i, batch.length, ...r.vectors);
        modelId = r.modelId;
      }
    } catch (err) {
      if (!(err instanceof LlmUnavailableError) && !(err instanceof DimensionError)) throw err;
      vectors = chunks.map(() => null);
      modelId = null;
      mode = 'keyword';
      note = err.message;
      this.logger.warn(`indexing ${doc.id} for keyword search only: ${err.message}`);
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(kbChunks).where(eq(kbChunks.documentId, doc.id));
      await tx.insert(kbChunks).values(
        chunks.map((c, i) => ({
          documentId: doc.id,
          version: doc.version,
          ordinal: c.ordinal,
          section: c.section,
          content: c.content,
          tokens: c.tokens,
          embedding: vectors[i] ?? null,
          embeddingModelId: vectors[i] ? modelId : null,
        })),
      );
      const extracted = doc.source === 'file' || doc.source === 'url';
      const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
      const betterTitle =
        doc.metadata.titleFromFilename === true ? (title ?? heading)?.slice(0, 200) : undefined;
      await tx
        .update(kbDocuments)
        .set({
          indexState: 'indexed',
          indexError: null,
          indexMode: mode,
          indexedVersion: doc.version,
          indexedAt: new Date(),
          ...(extracted ? { content: text } : {}),
          ...(betterTitle ? { title: betterTitle } : {}),
          ...(doc.source === 'url' ? { contentHash: contentHash(text) } : {}),
          metadata: {
            ...doc.metadata,
            ...(betterTitle ? { titleFromFilename: false } : {}),
            chunks: chunks.length,
            ...(title ? { pageTitle: title } : {}),
            ...(note ? { indexNote: note } : {}),
          },
        })
        .where(eq(kbDocuments.id, doc.id));
      const data = { version: doc.version, chunks: chunks.length, mode, embeddingModelId: modelId };
      await this.audit.record(tx, SYSTEM_CTX, {
        action: 'kb.document_indexed',
        targetType: 'kb_document',
        targetId: doc.id,
        data,
      });
      await this.outbox.publish(tx, SYSTEM_CTX, {
        type: 'kb.document_indexed',
        aggregateType: 'kb',
        aggregateId: doc.id,
        payload: { documentId: doc.id, ok: true, ...data },
      });
    });
    this.logger.log(`indexed ${doc.id} v${doc.version}: ${chunks.length} chunks (${mode})`);
    return 'indexed';
  }

  /** Records a final failure so the document shows why it isn't searchable. */
  async markFailed(documentId: string, error: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(kbDocuments)
        .set({ indexState: 'failed', indexError: error.slice(0, 500) })
        .where(eq(kbDocuments.id, documentId))
        .returning({ id: kbDocuments.id });
      if (!row) return;
      await this.audit.record(tx, SYSTEM_CTX, {
        action: 'kb.document_index_failed',
        targetType: 'kb_document',
        targetId: documentId,
        data: { error: error.slice(0, 500) },
      });
      await this.outbox.publish(tx, SYSTEM_CTX, {
        type: 'kb.document_indexed',
        aggregateType: 'kb',
        aggregateId: documentId,
        payload: { documentId, ok: false, error: error.slice(0, 200) },
      });
    });
  }

  private async textFor(
    doc: typeof kbDocuments.$inferSelect,
  ): Promise<{ text: string; title?: string | null }> {
    if (doc.source === 'faq' || doc.source === 'text') return { text: doc.content ?? '' };
    if (doc.source === 'url') {
      const page = await fetchPublicUrl(doc.url!, this.env.KB_ALLOW_PRIVATE_URLS);
      const html = page.body.toString('utf8');
      const isHtml = (page.contentType ?? '').includes('html') || /<html|<body|<p[\s>]/i.test(html);
      return isHtml ? { text: htmlToText(html), title: htmlTitle(html) } : { text: html.trim() };
    }
    const kind = detectKind(doc.filename ?? '', doc.contentType);
    if (!kind || !doc.s3Key) throw new Error('Unsupported or missing file');
    const content = await this.storage.getBuffer(doc.s3Key);
    return { text: await extractText(content, kind) };
  }
}

class DimensionError extends Error {
  constructor(got: number) {
    super(
      `The embedding model returns ${got}-dimension vectors; the knowledge base needs ${KB_EMBEDDING_DIMENSIONS}. Indexed for keyword search only.`,
    );
  }
}
