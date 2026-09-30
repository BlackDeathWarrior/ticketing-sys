import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Database, type DbOrTx, mcpServers, toolCalls, tools } from '@tms/db';
import {
  type CreateMcpServerInput,
  createMcpServerSchema,
  type McpServerView,
  qualifiedToolName,
  slugify,
  type ToolTier,
  type ToolView,
  type UpdateMcpServerInput,
  type UpdateToolInput,
} from '@tms/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import { assertPublicUrl, UnsafeUrlError } from '../common/url-fetch';
import type { Env } from '../config/env';
import { DB, ENV } from '../infra/tokens';
import { SecretsService } from '../settings/secrets.service';
import { listTools, type McpTarget } from './mcp-client';

export type ServerRow = typeof mcpServers.$inferSelect;
export type ToolRow = typeof tools.$inferSelect;

/** A tool the AI may call right now, as the model sees it. */
export interface AgentTool {
  tool: ToolRow;
  server: ServerRow;
  qualifiedName: string;
  definition: ChatCompletionTool;
}

export const tokenKey = (slug: string) => `tool.${slug}.token`;

/**
 * The tool registry (ADR 0013): MCP servers an admin registers, and the tools
 * they list, with the admin's settings (enabled, tier, timeout, customer
 * argument). New tools start disabled; nothing is offered to the AI until an
 * admin turns it on.
 */
@Injectable()
export class ToolsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly secrets: SecretsService,
  ) {}

  // ---- servers ----

  async listServers(): Promise<McpServerView[]> {
    const rows = await this.db.select().from(mcpServers).orderBy(asc(mcpServers.name));
    const counts = await this.db
      .select({ serverId: tools.serverId, n: sql<number>`count(*)::int` })
      .from(tools)
      .where(eq(tools.missing, false))
      .groupBy(tools.serverId);
    return Promise.all(rows.map(async (s) => this.serverView(s, counts)));
  }

  async server(id: string): Promise<ServerRow> {
    const [row] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!row) throw new NotFoundException('MCP server not found');
    return row;
  }

  async createServer(ctx: RequestCtx, input: CreateMcpServerInput): Promise<McpServerView> {
    const v = createMcpServerSchema.parse(input);
    await this.checkUrl(v.url);
    const taken = new Set(
      (await this.db.select({ slug: mcpServers.slug }).from(mcpServers)).map((r) => r.slug),
    );
    const base = slugify(v.name);
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base}_${i}`;

    const row = await this.db.transaction(async (tx) => {
      const [s] = await tx
        .insert(mcpServers)
        .values({ name: v.name, slug, url: v.url, authHeader: v.authHeader })
        .returning();
      await this.changed(tx, ctx, 'tool.server_created', s!.id, { name: v.name, slug, url: v.url });
      return s!;
    });
    return this.serverView(row);
  }

  async updateServer(ctx: RequestCtx, id: string, input: UpdateMcpServerInput) {
    await this.server(id);
    if (input.url) await this.checkUrl(input.url);
    const row = await this.db.transaction(async (tx) => {
      const [s] = await tx
        .update(mcpServers)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(mcpServers.id, id))
        .returning();
      await this.changed(tx, ctx, 'tool.server_updated', id, input);
      return s!;
    });
    return this.serverView(row);
  }

  /** Removes a server that was never used; one with history can only be disabled. */
  async deleteServer(ctx: RequestCtx, id: string) {
    const s = await this.server(id);
    const [used] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(toolCalls)
      .innerJoin(tools, eq(tools.id, toolCalls.toolId))
      .where(eq(tools.serverId, id));
    if (used && used.n > 0) {
      throw new ConflictException('This server has tool-call history; disable it instead');
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(mcpServers).where(eq(mcpServers.id, id));
      await this.changed(tx, ctx, 'tool.server_deleted', id, { name: s.name, slug: s.slug });
    });
    if ((await this.secrets.has(tokenKey(s.slug))).set) {
      await this.secrets.delete(ctx, tokenKey(s.slug));
    }
  }

  /**
   * Lists the server's tools and stores them. Known tools keep the admin's
   * settings; new ones start disabled with a tier guessed from the server's
   * hints; tools that disappeared are marked missing.
   */
  async sync(ctx: RequestCtx, id: string): Promise<ToolView[]> {
    const s = await this.server(id);
    let listed;
    try {
      listed = await listTools(await this.target(s));
    } catch (err) {
      const message = errorText(err);
      await this.db.transaction(async (tx) => {
        await tx
          .update(mcpServers)
          .set({ lastError: message, updatedAt: new Date() })
          .where(eq(mcpServers.id, id));
        await this.changed(tx, ctx, 'tool.server_synced', id, { ok: false, error: message });
      });
      throw new BadRequestException(`Could not list the server's tools: ${message}`);
    }

    await this.db.transaction(async (tx) => {
      const existing = await tx.select().from(tools).where(eq(tools.serverId, id));
      const seen = new Set<string>();
      let added = 0;
      for (const t of listed) {
        seen.add(t.name);
        const known = existing.find((e) => e.name === t.name);
        if (known) {
          await tx
            .update(tools)
            .set({
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: t.annotations,
              missing: false,
              updatedAt: new Date(),
            })
            .where(eq(tools.id, known.id));
        } else {
          added++;
          await tx.insert(tools).values({
            serverId: id,
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
            tier: guessTier(t.annotations),
            customerArg: guessCustomerArg(t.inputSchema),
          });
        }
      }
      const gone = existing.filter((e) => !seen.has(e.name) && !e.missing);
      for (const e of gone) {
        await tx
          .update(tools)
          .set({ missing: true, updatedAt: new Date() })
          .where(eq(tools.id, e.id));
      }
      await tx
        .update(mcpServers)
        .set({ lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(eq(mcpServers.id, id));
      await this.changed(tx, ctx, 'tool.server_synced', id, {
        ok: true,
        tools: listed.length,
        added,
        missing: gone.length,
      });
    });
    return (await this.listTools()).filter((t) => t.serverId === id);
  }

  // ---- tools ----

  async listTools(): Promise<ToolView[]> {
    const rows = await this.db
      .select({ tool: tools, server: mcpServers })
      .from(tools)
      .innerJoin(mcpServers, eq(mcpServers.id, tools.serverId))
      .orderBy(asc(mcpServers.name), asc(tools.name));
    return rows.map((r) => toolView(r.tool, r.server));
  }

  async tool(id: string): Promise<{ tool: ToolRow; server: ServerRow }> {
    const [row] = await this.db
      .select({ tool: tools, server: mcpServers })
      .from(tools)
      .innerJoin(mcpServers, eq(mcpServers.id, tools.serverId))
      .where(eq(tools.id, id));
    if (!row) throw new NotFoundException('Tool not found');
    return row;
  }

  async updateTool(ctx: RequestCtx, id: string, input: UpdateToolInput): Promise<ToolView> {
    const { tool, server } = await this.tool(id);
    if (input.customerArg && !schemaProperties(tool.inputSchema)[input.customerArg]) {
      throw new BadRequestException(`The tool has no argument named ${input.customerArg}`);
    }
    if (input.enabled && tool.missing) {
      throw new ConflictException('This tool is no longer offered by its server');
    }
    const row = await this.db.transaction(async (tx) => {
      const [t] = await tx
        .update(tools)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(tools.id, id))
        .returning();
      await this.changed(tx, ctx, 'tool.updated', id, { name: tool.name, ...input }, 'tool');
      return t!;
    });
    return toolView(row, server);
  }

  /** Enabled tools on enabled servers, shaped for the model (customer argument hidden). */
  async agentTools(): Promise<AgentTool[]> {
    const rows = await this.db
      .select({ tool: tools, server: mcpServers })
      .from(tools)
      .innerJoin(mcpServers, eq(mcpServers.id, tools.serverId))
      .where(and(eq(tools.enabled, true), eq(tools.missing, false), eq(mcpServers.enabled, true)));
    return rows.map(({ tool, server }) => {
      const qualifiedName = qualifiedToolName(server.slug, tool.name);
      const approval =
        tool.tier === 'transactional'
          ? ' Needs a supervisor’s approval: calling it submits a request, it does not happen straight away.'
          : '';
      return {
        tool,
        server,
        qualifiedName,
        definition: {
          type: 'function',
          function: {
            name: qualifiedName,
            description:
              `${server.name}: ${tool.description || tool.title || tool.name}${approval}`.slice(
                0,
                1000,
              ),
            parameters: modelSchema(tool.inputSchema, tool.customerArg),
          },
        },
      };
    });
  }

  /** Connection details for a server, with its token read server-side. */
  async target(s: ServerRow): Promise<McpTarget> {
    const token = s.authHeader ? await this.secrets.get(tokenKey(s.slug)) : null;
    return {
      url: s.url,
      auth: s.authHeader && token ? { header: s.authHeader, value: token } : null,
      privateHosts: this.env.TOOL_PRIVATE_HOSTS,
    };
  }

  private async checkUrl(url: string) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      await assertPublicUrl(url, this.env.TOOL_PRIVATE_HOSTS.includes(host));
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new BadRequestException(err.message);
      throw new BadRequestException('The server address could not be resolved');
    }
  }

  private async serverView(
    s: ServerRow,
    counts?: Array<{ serverId: string; n: number }>,
  ): Promise<McpServerView> {
    const key = tokenKey(s.slug);
    const token = await this.secrets.has(key);
    const toolCount =
      counts?.find((c) => c.serverId === s.id)?.n ??
      (
        await this.db
          .select({ n: sql<number>`count(*)::int` })
          .from(tools)
          .where(and(eq(tools.serverId, s.id), eq(tools.missing, false)))
      )[0]?.n ??
      0;
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      url: s.url,
      enabled: s.enabled,
      authHeader: s.authHeader,
      token: { key, ...token },
      lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
      lastError: s.lastError,
      toolCount,
    };
  }

  private async changed(
    tx: DbOrTx,
    ctx: RequestCtx,
    action: string,
    targetId: string,
    data: Record<string, unknown>,
    targetType: 'mcp_server' | 'tool' = 'mcp_server',
  ) {
    await this.audit.record(tx, ctx, { action, targetType, targetId, data });
    await this.outbox.publish(tx, ctx, {
      type: 'tool.config_changed',
      aggregateType: 'tool',
      aggregateId: targetId,
      payload: { action, ...data },
    });
  }
}

export function toolView(t: ToolRow, s: ServerRow): ToolView {
  return {
    id: t.id,
    serverId: s.id,
    serverName: s.name,
    name: t.name,
    qualifiedName: qualifiedToolName(s.slug, t.name),
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    enabled: t.enabled,
    tier: t.tier as ToolTier,
    timeoutMs: t.timeoutMs,
    customerArg: t.customerArg,
    missing: t.missing,
  };
}

const schemaProperties = (schema: Record<string, unknown>) =>
  (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

/** The tool's input schema without the customer argument, which TMS fills in. */
export function modelSchema(
  schema: Record<string, unknown>,
  customerArg: string | null,
): Record<string, unknown> {
  const properties = { ...schemaProperties(schema) };
  if (customerArg) delete properties[customerArg];
  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((r) => r !== customerArg)
    : [];
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/** Read-only hints mean `read`; destructive ones mean money or commitments, so `transactional`. */
export function guessTier(annotations: Record<string, unknown>): ToolTier {
  if (annotations.readOnlyHint === true) return 'read';
  if (annotations.destructiveHint === true) return 'transactional';
  return 'write';
}

export function guessCustomerArg(schema: Record<string, unknown>): string | null {
  const props = schemaProperties(schema);
  return ['customer_email', 'email'].find((p) => p in props) ?? null;
}

export function errorText(err: unknown): string {
  const e = err as Error & { cause?: { code?: string } };
  return (e.cause?.code ? `${e.message} (${e.cause.code})` : e.message || String(err)).slice(
    0,
    300,
  );
}
