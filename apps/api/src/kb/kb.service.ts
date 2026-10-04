import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type Database,
  type DbOrTx,
  kbChunks,
  kbConnectors,
  kbDocuments,
  teams,
  users,
} from '@tms/db';
import {
  type CreateKbDocumentInput,
  type CurrentUser,
  type KbDocumentDetail,
  type KbDocumentView,
  type KbIndexState,
  type KbSource,
  type KbStatus,
  type KbVisibility,
  type UpdateKbDocumentInput,
} from '@tms/shared';
import { aliasedTable, and, desc, eq, ilike, inArray, or, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import type { Env } from '../config/env';
import { DB, ENV } from '../infra/tokens';
import { StorageService } from '../storage/storage.service';
import { UsersService } from '../users/users.service';
import { detectKind } from './extract';
import { assertPublicUrl, UnsafeUrlError } from '../common/url-fetch';

type DocRow = typeof kbDocuments.$inferSelect;

const creators = aliasedTable(users, 'kb_creators');
const approvers = aliasedTable(users, 'kb_approvers');

export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Knowledge base documents (ADR 0010). Every change is audited and emits
 * `kb.document_changed`; the worker indexes the new version. Agents see
 * approved documents they may read; managers (`kb:manage`) see everything.
 */
@Injectable()
export class KbService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageService,
    private readonly users: UsersService,
  ) {}

  /** SQL limiting documents to what `user` may read. */
  async accessCondition(user: CurrentUser | undefined): Promise<SQL | undefined> {
    if (!user) return eq(kbDocuments.visibility, 'public');
    if (user.permissions.includes('kb:manage')) return undefined;
    const teamIds = await this.users.teamIds(user.id);
    return or(
      inArray(kbDocuments.visibility, ['public', 'internal']),
      teamIds.length
        ? and(eq(kbDocuments.visibility, 'team'), inArray(kbDocuments.teamId, teamIds))
        : sql`false`,
    );
  }

  async list(user: CurrentUser | undefined, q: { status?: KbStatus; q?: string; limit: number }) {
    const where: SQL[] = [];
    const access = await this.accessCondition(user);
    if (access) where.push(access);
    const manager = !!user?.permissions.includes('kb:manage');
    if (q.status) where.push(eq(kbDocuments.status, q.status));
    else if (!manager) where.push(eq(kbDocuments.status, 'approved'));
    if (q.q) where.push(ilike(kbDocuments.title, `%${q.q.replace(/[%_]/g, (m) => `\\${m}`)}%`));
    const rows = await this.baseSelect()
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(kbDocuments.updatedAt))
      .limit(q.limit);
    return rows.map(toView);
  }

  /**
   * The approved FAQ entries a customer may be told: the question (the title)
   * and the stored answer. With `revision`, which changes whenever any
   * approved document does, so a cached answer is never served from an older
   * knowledge base.
   */
  async publicFaqs(): Promise<{
    revision: string;
    faqs: Array<{ id: string; question: string; answer: string }>;
  }> {
    const [rows, [state]] = await Promise.all([
      this.db
        .select({ id: kbDocuments.id, title: kbDocuments.title, content: kbDocuments.content })
        .from(kbDocuments)
        .where(
          and(
            eq(kbDocuments.source, 'faq'),
            eq(kbDocuments.status, 'approved'),
            eq(kbDocuments.visibility, 'public'),
          ),
        )
        .limit(500),
      this.db
        .select({
          latest: sql<string | null>`max(${kbDocuments.updatedAt})::text`,
          total: sql<number>`count(*)::int`,
        })
        .from(kbDocuments)
        .where(eq(kbDocuments.status, 'approved')),
    ]);
    return {
      revision: `${state?.total ?? 0}:${state?.latest ?? ''}`,
      faqs: rows
        .filter((r) => r.content?.trim())
        .map((r) => ({ id: r.id, question: r.title, answer: r.content!.trim() })),
    };
  }

  async get(user: CurrentUser | undefined, id: string): Promise<KbDocumentDetail> {
    const access = await this.accessCondition(user);
    const [row] = await this.baseSelect().where(and(eq(kbDocuments.id, id), access));
    if (!row) throw new NotFoundException('Document not found');
    return { ...toView(row), content: row.doc.content };
  }

  async create(ctx: RequestCtx, input: CreateKbDocumentInput): Promise<KbDocumentDetail> {
    if (input.source === 'url') {
      try {
        // Checked again, hop by hop, when the worker fetches it.
        await assertPublicUrl(input.url, this.env.KB_ALLOW_PRIVATE_URLS);
      } catch (err) {
        const message =
          err instanceof UnsafeUrlError ? err.message : 'That address could not be resolved';
        throw new BadRequestException(message);
      }
    }
    const content = input.source === 'url' ? null : input.content;
    const id = await this.insert(ctx, {
      title: input.title,
      source: input.source,
      visibility: input.visibility,
      teamId: input.teamId,
      language: input.language,
      content,
      contentHash: content ? contentHash(content) : null,
      url: input.source === 'url' ? input.url : null,
    });
    return this.get(ctx.user, id);
  }

  /** Stores an uploaded file in object storage and creates its document. */
  async upload(
    ctx: RequestCtx,
    file: { filename: string; contentType: string; content: Buffer },
    fields: {
      title?: string;
      visibility: KbVisibility;
      teamId: string | null;
      language: string | null;
    },
  ): Promise<KbDocumentDetail> {
    const kind = detectKind(file.filename, file.contentType);
    if (!kind) {
      throw new BadRequestException('Unsupported file type: use PDF, DOCX, Markdown, HTML or text');
    }
    const id = randomUUID();
    const key = this.fileKey(id, 1, file.filename);
    await this.storage.put(key, file.content, file.contentType);
    await this.insert(ctx, {
      id,
      title: fields.title || file.filename.replace(/\.[^.]+$/, ''),
      // Without a title, indexing replaces the file name with the document's own heading.
      metadata: fields.title ? {} : { titleFromFilename: true },
      source: 'file',
      visibility: fields.visibility,
      teamId: fields.teamId,
      language: fields.language,
      s3Key: key,
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.content.length,
      contentHash: contentHash(file.content.toString('base64')),
    });
    return this.get(ctx.user, id);
  }

  /** A new file for an existing file document: a new version, indexed again. */
  async replaceFile(
    ctx: RequestCtx,
    id: string,
    file: { filename: string; contentType: string; content: Buffer },
  ): Promise<KbDocumentDetail> {
    const current = await this.row(id);
    if (current.source !== 'file')
      throw new BadRequestException('Only file documents take a new file');
    if (!detectKind(file.filename, file.contentType)) {
      throw new BadRequestException('Unsupported file type: use PDF, DOCX, Markdown, HTML or text');
    }
    const version = current.version + 1;
    const key = this.fileKey(id, version, file.filename);
    await this.storage.put(key, file.content, file.contentType);
    await this.db.transaction(async (tx) => {
      await tx
        .update(kbDocuments)
        .set({
          version,
          s3Key: key,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.content.length,
          contentHash: contentHash(file.content.toString('base64')),
          indexState: 'pending',
          indexError: null,
        })
        .where(eq(kbDocuments.id, id));
      await this.changed(tx, ctx, id, version, 'kb.document_updated', {
        fields: ['file'],
        filename: file.filename,
      });
    });
    return this.get(ctx.user, id);
  }

  async update(
    ctx: RequestCtx,
    id: string,
    input: UpdateKbDocumentInput,
  ): Promise<KbDocumentDetail> {
    const current = await this.row(id);
    if (input.content !== undefined && current.source !== 'faq' && current.source !== 'text') {
      throw new BadRequestException('Only FAQ and text documents can be edited here');
    }
    const visibility = input.visibility ?? (current.visibility as KbVisibility);
    const teamId = input.teamId === undefined ? current.teamId : input.teamId;
    if (visibility === 'team' && !teamId)
      throw new BadRequestException('Pick the team that may see it');

    const contentChanged =
      input.content !== undefined && contentHash(input.content) !== current.contentHash;
    // FAQ titles are the question, so they are indexed too.
    const reindex =
      contentChanged ||
      (current.source === 'faq' && input.title !== undefined && input.title !== current.title);
    const version = reindex ? current.version + 1 : current.version;
    await this.db.transaction(async (tx) => {
      await tx
        .update(kbDocuments)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          visibility,
          teamId: visibility === 'team' ? teamId : null,
          ...(input.language !== undefined ? { language: input.language } : {}),
          ...(contentChanged
            ? { content: input.content, contentHash: contentHash(input.content!) }
            : {}),
          ...(reindex ? { version, indexState: 'pending' as KbIndexState, indexError: null } : {}),
        })
        .where(eq(kbDocuments.id, id));
      await this.changed(tx, ctx, id, version, 'kb.document_updated', {
        fields: Object.keys(input),
        reindex,
      });
    });
    return this.get(ctx.user, id);
  }

  async setStatus(ctx: RequestCtx, id: string, status: KbStatus): Promise<KbDocumentDetail> {
    const current = await this.row(id);
    if (current.status === status) return this.get(ctx.user, id);
    await this.db.transaction(async (tx) => {
      await tx
        .update(kbDocuments)
        .set({
          status,
          ...(status === 'approved'
            ? { approvedBy: ctx.user?.id ?? null, approvedAt: new Date() }
            : { approvedBy: null, approvedAt: null }),
        })
        .where(eq(kbDocuments.id, id));
      await this.changed(tx, ctx, id, current.version, 'kb.document_status_changed', {
        from: current.status,
        to: status,
      });
    });
    return this.get(ctx.user, id);
  }

  async delete(ctx: RequestCtx, id: string): Promise<void> {
    const current = await this.row(id);
    await this.db.transaction(async (tx) => {
      await tx.delete(kbDocuments).where(eq(kbDocuments.id, id));
      const data = { title: current.title, source: current.source };
      await this.audit.record(tx, ctx, {
        action: 'kb.document_deleted',
        targetType: 'kb_document',
        targetId: id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'kb.document_deleted',
        aggregateType: 'kb',
        aggregateId: id,
        payload: { documentId: id, s3Key: current.s3Key },
      });
    });
    if (current.s3Key) await this.storage.delete(current.s3Key).catch(() => undefined);
  }

  /** Re-index one document, or every document when `id` is omitted. */
  async requestReindex(ctx: RequestCtx, id?: string) {
    if (id) await this.row(id);
    await this.db.transaction(async (tx) => {
      await tx
        .update(kbDocuments)
        .set({ indexState: 'pending', indexError: null })
        .where(id ? eq(kbDocuments.id, id) : undefined);
      await this.audit.record(tx, ctx, {
        action: 'kb.reindex_requested',
        targetType: id ? 'kb_document' : 'kb',
        targetId: id ?? null,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'kb.reindex_requested',
        aggregateType: 'kb',
        aggregateId: id ?? 'all',
        payload: { documentId: id ?? null },
      });
    });
    return { queued: true };
  }

  async file(
    user: CurrentUser | undefined,
    id: string,
  ): Promise<{ stream: Readable; doc: DocRow }> {
    await this.get(user, id);
    const doc = await this.row(id);
    if (!doc.s3Key) throw new NotFoundException('This document has no file');
    return { stream: await this.storage.get(doc.s3Key), doc };
  }

  // ---- connectors (ADR 0033) ----

  /** What a connector brought in before: by its item id, with the version it had and its text's hash. */
  async connectorDocuments(connectorId: string) {
    const rows = await this.db
      .select({
        id: kbDocuments.id,
        externalId: kbDocuments.externalId,
        status: kbDocuments.status,
        contentHash: kbDocuments.contentHash,
        metadata: kbDocuments.metadata,
      })
      .from(kbDocuments)
      .where(eq(kbDocuments.connectorId, connectorId));
    return new Map(
      rows
        .filter((r) => r.externalId)
        .map((r) => [
          r.externalId!,
          {
            ...r,
            sourceVersion: String((r.metadata as { sourceVersion?: unknown }).sourceVersion ?? ''),
          },
        ]),
    );
  }

  /** How many documents each connector keeps (archived ones not counted). */
  async connectorCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ connectorId: kbDocuments.connectorId, n: sql<number>`count(*)::int` })
      .from(kbDocuments)
      .where(
        and(sql`${kbDocuments.connectorId} is not null`, sql`${kbDocuments.status} <> 'archived'`),
      )
      .groupBy(kbDocuments.connectorId);
    return new Map(rows.map((r) => [r.connectorId!, r.n]));
  }

  /** A new item from a connector: a text document, a draft unless the connector approves its own. */
  async addFromConnector(
    ctx: RequestCtx,
    c: { id: string; visibility: string; teamId: string | null; autoApprove: boolean },
    item: { externalId: string; title: string; text: string; url: string | null; version: string },
  ): Promise<string> {
    return this.insert(ctx, {
      source: 'text',
      title: item.title.slice(0, 300),
      content: item.text,
      contentHash: contentHash(item.text),
      url: item.url,
      visibility: c.visibility,
      teamId: c.visibility === 'team' ? c.teamId : null,
      status: c.autoApprove ? 'approved' : 'draft',
      ...(c.autoApprove ? { approvedAt: new Date() } : {}),
      connectorId: c.id,
      externalId: item.externalId,
      metadata: { sourceVersion: item.version },
    });
  }

  /**
   * An item that changed in its source: the new text becomes a new version
   * and is indexed again. An item that came back after being archived is
   * a draft again (approved again, with `approve`).
   */
  async updateFromConnector(
    ctx: RequestCtx,
    id: string,
    item: { title: string; text: string; url: string | null; version: string },
    opts: { approve: boolean; changed: boolean },
  ): Promise<void> {
    const current = await this.row(id);
    const version = opts.changed ? current.version + 1 : current.version;
    const status =
      current.status === 'archived' ? (opts.approve ? 'approved' : 'draft') : current.status;
    await this.db.transaction(async (tx) => {
      await tx
        .update(kbDocuments)
        .set({
          title: item.title.slice(0, 300),
          url: item.url,
          status,
          metadata: { ...current.metadata, sourceVersion: item.version },
          ...(opts.changed
            ? {
                content: item.text,
                contentHash: contentHash(item.text),
                version,
                indexState: 'pending' as KbIndexState,
                indexError: null,
              }
            : {}),
        })
        .where(eq(kbDocuments.id, id));
      if (opts.changed || status !== current.status) {
        await this.changed(tx, ctx, id, version, 'kb.document_updated', {
          fields: opts.changed ? ['content'] : ['status'],
          reindex: opts.changed,
          connector: current.connectorId,
        });
      }
    });
  }

  // ---- worker side ----

  /** The document each chunk belongs to. Chunks replaced by a re-index are simply missing. */
  async documentsOfChunks(chunkIds: string[]): Promise<Map<string, { id: string; title: string }>> {
    if (!chunkIds.length) return new Map();
    const rows = await this.db
      .select({ chunkId: kbChunks.id, id: kbDocuments.id, title: kbDocuments.title })
      .from(kbChunks)
      .innerJoin(kbDocuments, eq(kbDocuments.id, kbChunks.documentId))
      .where(inArray(kbChunks.id, chunkIds));
    return new Map(rows.map((r) => [r.chunkId, { id: r.id, title: r.title }]));
  }

  async titles(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.db
      .select({ id: kbDocuments.id, title: kbDocuments.title })
      .from(kbDocuments)
      .where(inArray(kbDocuments.id, ids));
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  async row(id: string): Promise<DocRow> {
    const [row] = await this.db.select().from(kbDocuments).where(eq(kbDocuments.id, id));
    if (!row) throw new NotFoundException('Document not found');
    return row;
  }

  async allIds(): Promise<Array<{ id: string; version: number }>> {
    return this.db.select({ id: kbDocuments.id, version: kbDocuments.version }).from(kbDocuments);
  }

  /** Marks a document as being indexed (a progress marker, not a reviewable change). */
  async markIndexing(id: string) {
    await this.db.update(kbDocuments).set({ indexState: 'indexing' }).where(eq(kbDocuments.id, id));
  }

  private async insert(
    ctx: RequestCtx,
    values: Omit<typeof kbDocuments.$inferInsert, 'createdBy'> & { source: KbSource },
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(kbDocuments)
        .values({ ...values, createdBy: ctx.user?.id ?? null })
        .returning({ id: kbDocuments.id, version: kbDocuments.version });
      await this.changed(tx, ctx, row!.id, row!.version, 'kb.document_created', {
        title: values.title,
        source: values.source,
        visibility: values.visibility,
      });
      return row!.id;
    });
  }

  private async changed(
    tx: DbOrTx,
    ctx: RequestCtx,
    id: string,
    version: number,
    action: string,
    data: Record<string, unknown>,
  ) {
    await this.audit.record(tx, ctx, { action, targetType: 'kb_document', targetId: id, data });
    await this.outbox.publish(tx, ctx, {
      type: 'kb.document_changed',
      aggregateType: 'kb',
      aggregateId: id,
      payload: { documentId: id, version, action },
    });
  }

  private fileKey(id: string, version: number, filename: string) {
    const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
    return `kb/${id}/v${version}/${safe}`;
  }

  private baseSelect() {
    return this.db
      .select({
        doc: kbDocuments,
        team: { id: teams.id, name: teams.name },
        creator: { id: creators.id, name: creators.name },
        approver: { id: approvers.id, name: approvers.name },
        connector: { id: kbConnectors.id, name: kbConnectors.name },
        chunkCount: sql<number>`(select count(*)::int from ${kbChunks} where ${kbChunks.documentId} = ${kbDocuments.id} and ${kbChunks.version} = ${kbDocuments.indexedVersion})`,
      })
      .from(kbDocuments)
      .leftJoin(teams, eq(teams.id, kbDocuments.teamId))
      .leftJoin(creators, eq(creators.id, kbDocuments.createdBy))
      .leftJoin(approvers, eq(approvers.id, kbDocuments.approvedBy))
      .leftJoin(kbConnectors, eq(kbConnectors.id, kbDocuments.connectorId));
  }
}

type Row = Awaited<ReturnType<KbService['baseSelect']>>[number];

function toView(r: Row): KbDocumentView {
  const d = r.doc;
  return {
    id: d.id,
    title: d.title,
    source: d.source as KbSource,
    visibility: d.visibility as KbVisibility,
    team: r.team?.id ? r.team : null,
    language: d.language,
    status: d.status as KbStatus,
    indexState: d.indexState as KbIndexState,
    indexError: d.indexError,
    indexMode: (d.indexMode as KbDocumentView['indexMode']) ?? null,
    version: d.version,
    chunkCount: r.chunkCount ?? 0,
    url: d.url,
    filename: d.filename,
    sizeBytes: d.sizeBytes,
    createdBy: r.creator?.id ? r.creator : null,
    approvedBy: r.approver?.id ? r.approver : null,
    connector: r.connector?.id ? r.connector : null,
    approvedAt: d.approvedAt?.toISOString() ?? null,
    indexedAt: d.indexedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}
