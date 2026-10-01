import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Database, waTemplates } from '@tms/db';
import {
  type ParsedSendTemplate,
  templatePreview,
  type WaHeaderType,
  type WaTemplateSend,
  type WaTemplateSyncResult,
  type WaTemplateView,
} from '@tms/shared';
import { and, asc, eq, notInArray } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service';
import { OutboxService } from '../../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import {
  ChannelConfigService,
  type ResolvedWhatsappConfig,
} from '../../settings/channel-config.service';
import { listMessageTemplates, subscribeWabaToApp } from './meta-api';
import { explainMetaError } from './meta-errors';
import { buildSendComponents } from './template-send-builder';
import { templateRow } from './webhook-payload';

type TemplateRow = typeof waTemplates.$inferSelect;

/**
 * The local copy of Meta's message templates. Meta owns them (they are
 * written and approved in WhatsApp Manager); TMS syncs the list and sends
 * approved ones.
 */
@Injectable()
export class WhatsAppTemplatesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly channels: ChannelConfigService,
  ) {}

  async list(opts: { approvedOnly: boolean }): Promise<WaTemplateView[]> {
    const rows = await this.db
      .select()
      .from(waTemplates)
      .where(opts.approvedOnly ? eq(waTemplates.status, 'APPROVED') : undefined)
      .orderBy(asc(waTemplates.name), asc(waTemplates.language));
    return rows.map(toView);
  }

  /**
   * Checks a template send and builds what the sender will post. The preview
   * is the text the customer reads; it becomes the message body in TMS.
   */
  async prepare(input: ParsedSendTemplate): Promise<{ send: WaTemplateSend; preview: string }> {
    const [row] = await this.db
      .select()
      .from(waTemplates)
      .where(eq(waTemplates.id, input.templateId));
    if (!row) throw new NotFoundException('Template not found. Sync templates and try again.');
    if (row.status !== 'APPROVED') {
      throw new BadRequestException(
        `Meta has not approved the template "${row.name}" (it is ${row.status.toLowerCase()})`,
      );
    }
    let components: unknown[];
    try {
      components = buildSendComponents(row, input);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return {
      send: { name: row.name, language: row.language, components },
      preview: templatePreview(toView(row), input),
    };
  }

  /** Replaces the local list with Meta's. Templates Meta no longer has are removed. */
  async sync(ctx: RequestCtx): Promise<WaTemplateSyncResult> {
    const config = await this.requireAccount();
    let rows: ReturnType<typeof templateRow>[];
    try {
      rows = (
        await listMessageTemplates({
          graph: config.graph,
          accessToken: config.accessToken,
          wabaId: config.wabaId,
        })
      ).map(templateRow);
    } catch (err) {
      throw new BadGatewayException(explainMetaError(err).summary);
    }

    return this.db.transaction(async (tx) => {
      const syncedAt = new Date();
      const kept: string[] = [];
      for (const r of rows) {
        const [saved] = await tx
          .insert(waTemplates)
          .values({ ...r, syncedAt })
          .onConflictDoUpdate({
            target: [waTemplates.name, waTemplates.language],
            set: { ...r, syncedAt },
          })
          .returning({ id: waTemplates.id });
        kept.push(saved!.id);
      }
      const removed = await tx
        .delete(waTemplates)
        .where(kept.length ? notInArray(waTemplates.id, kept) : undefined)
        .returning({ id: waTemplates.id });
      const result = {
        total: rows.length,
        approved: rows.filter((r) => r.status === 'APPROVED').length,
        removed: removed.length,
      };
      await this.audit.record(tx, ctx, {
        action: 'whatsapp.templates_synced',
        targetType: 'setting',
        targetId: 'whatsapp.templates',
        data: result,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'whatsapp.templates_changed',
        aggregateType: 'settings',
        aggregateId: 'whatsapp.templates',
        payload: result,
      });
      return result;
    });
  }

  /** Meta approved, rejected, paused or disabled a template (a webhook). */
  async applyStatus(name: string, language: string, event: string): Promise<boolean> {
    const status = event.toUpperCase();
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(waTemplates)
        .where(and(eq(waTemplates.name, name), eq(waTemplates.language, language)))
        .for('update');
      if (!row || row.status === status) return false;
      await tx.update(waTemplates).set({ status }).where(eq(waTemplates.id, row.id));
      const data = { name, language, from: row.status, to: status };
      await this.audit.record(tx, SYSTEM_CTX, {
        action: 'whatsapp.template_status_changed',
        targetType: 'setting',
        targetId: 'whatsapp.templates',
        data,
      });
      await this.outbox.publish(tx, SYSTEM_CTX, {
        type: 'whatsapp.templates_changed',
        aggregateType: 'settings',
        aggregateId: 'whatsapp.templates',
        payload: data,
      });
      return true;
    });
  }

  /** Tells Meta to send this account's webhooks to the app the token belongs to. */
  async subscribe(ctx: RequestCtx): Promise<{ subscribed: true }> {
    const config = await this.requireAccount();
    try {
      await subscribeWabaToApp({
        graph: config.graph,
        accessToken: config.accessToken,
        wabaId: config.wabaId,
      });
    } catch (err) {
      throw new BadGatewayException(explainMetaError(err).summary);
    }
    await this.db.transaction(async (tx) => {
      const data = { wabaId: config.wabaId };
      await this.audit.record(tx, ctx, {
        action: 'whatsapp.webhook_subscribed',
        targetType: 'setting',
        targetId: 'channel.whatsapp',
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'settings.updated',
        aggregateType: 'settings',
        aggregateId: 'channel.whatsapp',
        payload: { key: 'channel.whatsapp', action: 'webhook_subscribed' },
      });
    });
    return { subscribed: true };
  }

  private async requireAccount(): Promise<
    ResolvedWhatsappConfig & { accessToken: string; wabaId: string }
  > {
    const config = await this.channels.whatsapp();
    if (!config) throw new BadRequestException('Save the WhatsApp settings first');
    if (!config.wabaId) {
      throw new BadRequestException('Add the WhatsApp Business account ID in the settings');
    }
    if (!config.accessToken) throw new BadRequestException('Set the WhatsApp access token first');
    return { ...config, accessToken: config.accessToken, wabaId: config.wabaId };
  }
}

function toView(row: TemplateRow): WaTemplateView {
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    status: row.status,
    category: row.category,
    headerType: row.headerType as WaHeaderType | null,
    headerText: row.headerText,
    bodyText: row.bodyText,
    footerText: row.footerText,
    buttons: row.buttons,
    syncedAt: row.syncedAt.toISOString(),
  };
}
