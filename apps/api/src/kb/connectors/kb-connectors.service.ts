import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { type Database, kbConnectors } from '@tms/db';
import {
  type CreateKbConnectorInput,
  KB_CONNECTOR_SECRETS,
  KB_CONNECTOR_TYPES,
  kbConnectorConfigSchemas,
  kbConnectorSecretKey,
  type KbConnectorStatus,
  type KbConnectorType,
  type KbConnectorView,
  type UpdateKbConnectorInput,
} from '@tms/shared';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service';
import { OutboxService } from '../../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../../common/request-context';
import type { Env } from '../../config/env';
import { DB, ENV } from '../../infra/tokens';
import { SecretsService } from '../../settings/secrets.service';
import { contentHash, KbService } from '../kb.service';
import { type ConnectorSource, MAX_ITEMS, sourceFor, SourceError } from './sources';

type Row = typeof kbConnectors.$inferSelect;
const MAX_TEXT = 200_000;

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Knowledge-base connectors (ADR 0033): outside sources kept in sync. Their
 * settings live in `kb_connectors`, their credentials in secrets. A sync
 * lists the source, brings in what is new, a new version of what changed
 * (indexed again by the usual pipeline), and archives what disappeared.
 */
@Injectable()
export class KbConnectorsService {
  private readonly logger = new Logger(KbConnectorsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly secrets: SecretsService,
    private readonly kb: KbService,
  ) {}

  async list(): Promise<KbConnectorView[]> {
    const [rows, counts] = await Promise.all([
      this.db.select().from(kbConnectors).orderBy(desc(kbConnectors.createdAt)),
      this.kb.connectorCounts(),
    ]);
    return Promise.all(rows.map((r) => this.view(r, counts.get(r.id) ?? 0)));
  }

  async get(id: string): Promise<KbConnectorView> {
    const r = await this.row(id);
    return this.view(r, (await this.kb.connectorCounts()).get(r.id) ?? 0);
  }

  async create(ctx: RequestCtx, input: CreateKbConnectorInput): Promise<KbConnectorView> {
    if (input.visibility === 'team' && !input.teamId) {
      throw new BadRequestException('Pick the team that may see what it brings in');
    }
    const [row] = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(kbConnectors)
        .values({
          name: input.name,
          type: input.type,
          config: input.config,
          visibility: input.visibility,
          teamId: input.visibility === 'team' ? (input.teamId ?? null) : null,
          autoApprove: input.autoApprove,
          scheduleMinutes: input.scheduleMinutes,
          createdBy: ctx.user?.id ?? null,
        })
        .returning();
      await this.changed(tx, ctx, inserted[0]!.id, 'kb.connector_created', {
        name: input.name,
        type: input.type,
      });
      return inserted;
    });
    await this.saveSecrets(ctx, row!, input.secrets);
    return this.get(row!.id);
  }

  async update(
    ctx: RequestCtx,
    id: string,
    input: UpdateKbConnectorInput,
  ): Promise<KbConnectorView> {
    const current = await this.row(id);
    const { secrets, config, ...fields } = input;
    const parsedConfig = config
      ? kbConnectorConfigSchemas[current.type as KbConnectorType].safeParse(config)
      : null;
    if (parsedConfig && !parsedConfig.success) {
      throw new BadRequestException(parsedConfig.error.issues.map((i) => i.message).join('; '));
    }
    const visibility = fields.visibility ?? current.visibility;
    const teamId = fields.teamId === undefined ? current.teamId : fields.teamId;
    if (visibility === 'team' && !teamId) throw new BadRequestException('Pick the team');
    await this.db.transaction(async (tx) => {
      await tx
        .update(kbConnectors)
        .set({
          ...fields,
          visibility,
          teamId: visibility === 'team' ? teamId : null,
          ...(parsedConfig?.success ? { config: parsedConfig.data } : {}),
        })
        .where(eq(kbConnectors.id, id));
      await this.changed(tx, ctx, id, 'kb.connector_updated', {
        fields: [
          ...Object.keys(fields),
          ...(config ? ['config'] : []),
          ...(secrets ? ['secrets'] : []),
        ],
      });
    });
    await this.saveSecrets(ctx, current, secrets);
    return this.get(id);
  }

  /** Removes the connector. What it brought in stays, as ordinary documents. */
  async delete(ctx: RequestCtx, id: string): Promise<void> {
    const current = await this.row(id);
    await this.db.transaction(async (tx) => {
      await tx.delete(kbConnectors).where(eq(kbConnectors.id, id));
      await this.changed(tx, ctx, id, 'kb.connector_deleted', { name: current.name });
    });
    for (const s of KB_CONNECTOR_SECRETS[current.type as KbConnectorType] ?? []) {
      await this.secrets.delete(ctx, kbConnectorSecretKey(id, s.field)).catch(() => undefined);
    }
  }

  /** Asks the worker to sync now. */
  async requestSync(ctx: RequestCtx, id: string): Promise<void> {
    await this.row(id);
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, ctx, {
        action: 'kb.connector_sync_requested',
        targetType: 'kb_connector',
        targetId: id,
        data: {},
      });
      await this.outbox.publish(tx, ctx, {
        type: 'kb.connector_sync_requested',
        aggregateType: 'kb',
        aggregateId: id,
        payload: { connectorId: id },
      });
    });
  }

  /**
   * Lists the source once, without changing anything: whether the address
   * and credentials work, and what a sync would find. Only run when a person
   * asks for it.
   */
  async test(
    id: string,
  ): Promise<{ ok: boolean; found: number; sample: string[]; error: string | null }> {
    const r = await this.row(id);
    try {
      const items = await this.source(r).list();
      return {
        ok: true,
        found: items.length,
        sample: items.slice(0, 5).map((i) => i.title),
        error: null,
      };
    } catch (err) {
      return { ok: false, found: 0, sample: [], error: this.reason(err) };
    }
  }

  /** Connectors whose schedule says they are due. */
  async due(now = new Date()): Promise<string[]> {
    const rows = await this.db
      .select({
        id: kbConnectors.id,
        every: kbConnectors.scheduleMinutes,
        last: kbConnectors.lastSyncAt,
      })
      .from(kbConnectors)
      .where(
        and(
          eq(kbConnectors.enabled, true),
          sql`${kbConnectors.scheduleMinutes} > 0`,
          or(
            isNull(kbConnectors.lastSyncAt),
            lt(
              kbConnectors.lastSyncAt,
              sql`${now.toISOString()}::timestamptz - make_interval(mins => ${kbConnectors.scheduleMinutes})`,
            ),
          ),
        ),
      );
    return rows.map((r) => r.id);
  }

  /** One sync of one connector. Safe to run twice; a run that fails leaves the documents as they were. */
  async sync(id: string): Promise<void> {
    const c = await this.row(id).catch(() => null);
    if (!c || !c.enabled) return;
    await this.setStatus(id, 'syncing');
    const stats = { found: 0, added: 0, updated: 0, archived: 0, skipped: 0 };
    let firstError: string | null = null;
    try {
      const source = this.source(c);
      const items = (await source.list()).slice(0, MAX_ITEMS);
      stats.found = items.length;
      const known = await this.kb.connectorDocuments(c.id);
      const seen = new Set<string>();
      for (const item of items) {
        seen.add(item.externalId);
        const doc = known.get(item.externalId);
        if (
          doc &&
          item.version &&
          doc.sourceVersion === item.version &&
          doc.status !== 'archived'
        ) {
          stats.skipped++;
          continue;
        }
        let fetched;
        try {
          fetched = await source.fetch(item);
        } catch (err) {
          firstError ??= `${item.title}: ${this.reason(err)}`;
          stats.skipped++;
          continue;
        }
        const text = fetched?.text.trim().slice(0, MAX_TEXT);
        if (!fetched || !text) {
          stats.skipped++;
          continue;
        }
        const version = item.version || contentHash(text).slice(0, 32);
        const entry = {
          title: fetched.title || item.title,
          text,
          url: fetched.url ?? item.url ?? null,
          version,
        };
        if (!doc) {
          await this.kb.addFromConnector(SYSTEM_CTX, c, { externalId: item.externalId, ...entry });
          stats.added++;
          continue;
        }
        const changed = contentHash(text) !== doc.contentHash;
        if (!changed && doc.status !== 'archived') {
          stats.skipped++;
          // Remember the version, so the next run does not fetch it again.
          await this.kb.updateFromConnector(SYSTEM_CTX, doc.id, entry, {
            approve: c.autoApprove,
            changed,
          });
          continue;
        }
        await this.kb.updateFromConnector(SYSTEM_CTX, doc.id, entry, {
          approve: c.autoApprove,
          changed,
        });
        stats.updated++;
      }
      // Gone from the source: archived, not deleted (a person can bring it back).
      // Only after a full listing: a capped one says nothing about what is missing.
      if (items.length < MAX_ITEMS) {
        for (const [externalId, doc] of known) {
          if (seen.has(externalId) || doc.status === 'archived') continue;
          await this.kb.setStatus(SYSTEM_CTX, doc.id, 'archived').catch(() => undefined);
          stats.archived++;
        }
      }
      await this.finish(id, 'ok', stats, firstError);
    } catch (err) {
      this.logger.warn(`connector ${c.name} failed: ${this.reason(err)}`);
      await this.finish(id, 'failed', stats, this.reason(err));
    }
  }

  private source(c: Row): ConnectorSource {
    return sourceFor(c.type as KbConnectorType, {
      config: c.config,
      secret: (field) => this.secrets.get(kbConnectorSecretKey(c.id, field)),
      privateHosts: list(this.env.KB_CONNECTOR_PRIVATE_HOSTS),
      folderRoots: list(this.env.KB_CONNECTOR_PATHS),
    });
  }

  private reason(err: unknown): string {
    if (err instanceof SourceError) return err.message;
    const message = err instanceof Error ? err.message : String(err);
    return message.slice(0, 300);
  }

  private async saveSecrets(ctx: RequestCtx, c: Row, secrets?: Record<string, string>) {
    if (!secrets) return;
    const fields = KB_CONNECTOR_SECRETS[c.type as KbConnectorType] ?? [];
    for (const [field, value] of Object.entries(secrets)) {
      if (!fields.some((f) => f.field === field)) {
        throw new BadRequestException(`A ${c.type} connector has no credential called ${field}`);
      }
      if (value.trim())
        await this.secrets.set(ctx, kbConnectorSecretKey(c.id, field), value.trim());
    }
  }

  private async setStatus(id: string, status: KbConnectorStatus) {
    await this.db.update(kbConnectors).set({ status }).where(eq(kbConnectors.id, id));
  }

  /** The outcome of a run: a progress record, not a reviewable change (like an index state). */
  private async finish(
    id: string,
    status: KbConnectorStatus,
    stats: Record<string, number>,
    error: string | null,
  ) {
    await this.db
      .update(kbConnectors)
      .set({ status, stats, lastError: error, lastSyncAt: new Date() })
      .where(eq(kbConnectors.id, id));
  }

  private async changed(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    ctx: RequestCtx,
    id: string,
    action: string,
    data: Record<string, unknown>,
  ) {
    await this.audit.record(tx, ctx, { action, targetType: 'kb_connector', targetId: id, data });
    await this.outbox.publish(tx, ctx, {
      type: 'kb.connector_changed',
      aggregateType: 'kb',
      aggregateId: id,
      payload: { connectorId: id, action },
    });
  }

  private async row(id: string): Promise<Row> {
    const [r] = await this.db.select().from(kbConnectors).where(eq(kbConnectors.id, id));
    if (!r || !(KB_CONNECTOR_TYPES as readonly string[]).includes(r.type)) {
      throw new NotFoundException('Connector not found');
    }
    return r;
  }

  private async view(r: Row, documents: number): Promise<KbConnectorView> {
    const fields = KB_CONNECTOR_SECRETS[r.type as KbConnectorType] ?? [];
    return {
      id: r.id,
      name: r.name,
      type: r.type as KbConnectorType,
      config: r.config,
      visibility: r.visibility as KbConnectorView['visibility'],
      teamId: r.teamId,
      autoApprove: r.autoApprove,
      scheduleMinutes: r.scheduleMinutes,
      enabled: r.enabled,
      status: r.status as KbConnectorStatus,
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
      lastError: r.lastError,
      stats: (r.stats as KbConnectorView['stats']) ?? null,
      secrets: await Promise.all(
        fields.map(async (f) => ({
          field: f.field,
          set: (await this.secrets.has(kbConnectorSecretKey(r.id, f.field))).set,
        })),
      ),
      documents,
    };
  }
}
