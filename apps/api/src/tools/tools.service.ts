import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Database, type DbOrTx, mcpServers, toolCalls, tools, users } from '@tms/db';
import {
  type CreateMcpServerInput,
  createMcpServerSchema,
  CUSTOM_TOOLS_SLUG,
  type CustomToolHttp,
  customToolInputSchema,
  customToolTokenKey,
  type McpServerView,
  type ParsedCustomTool,
  qualifiedToolName,
  slugify,
  type ToolTier,
  type ToolView,
  type ParsedCustomToolUpdate,
  type UpdateMcpServerInput,
  type UpdateToolInput,
} from '@tms/shared';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
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
    // The holder of custom tools is not a server anyone connects to.
    const rows = await this.db
      .select()
      .from(mcpServers)
      .where(ne(mcpServers.kind, 'custom'))
      .orderBy(asc(mcpServers.name));
    const counts = await this.db
      .select({ serverId: tools.serverId, n: sql<number>`count(*)::int` })
      .from(tools)
      .where(eq(tools.missing, false))
      .groupBy(tools.serverId);
    return Promise.all(rows.map(async (s) => this.serverView(s, counts)));
  }

  async server(id: string): Promise<ServerRow> {
    const [row] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!row || row.kind === 'custom') throw new NotFoundException('MCP server not found');
    return row;
  }

  async createServer(ctx: RequestCtx, input: CreateMcpServerInput): Promise<McpServerView> {
    const v = createMcpServerSchema.parse(input);
    await this.checkUrl(v.url);
    const taken = new Set(
      (await this.db.select({ slug: mcpServers.slug }).from(mcpServers)).map((r) => r.slug),
    );
    // Reserved for custom tools, whether or not one exists yet.
    taken.add(CUSTOM_TOOLS_SLUG);
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
      .select({ tool: tools, server: mcpServers, creator: users.name })
      .from(tools)
      .innerJoin(mcpServers, eq(mcpServers.id, tools.serverId))
      .leftJoin(users, eq(users.id, tools.createdBy))
      .orderBy(asc(mcpServers.name), asc(tools.name));
    return Promise.all(rows.map((r) => this.view(r.tool, r.server, r.creator)));
  }

  // ---- custom tools (ADR 0017) ----

  async listCustom(): Promise<ToolView[]> {
    return (await this.listTools()).filter((t) => t.custom);
  }

  /**
   * Creates a custom tool: an HTTP request described by an admin (or someone
   * an admin gave `tool:create`). Its address is checked like an MCP
   * server's, and it runs through the same gateway.
   */
  async createCustom(ctx: RequestCtx, v: ParsedCustomTool): Promise<ToolView> {
    await this.checkUrl(sampleUrl(v.url));
    const server = await this.customServer();
    const [taken] = await this.db
      .select({ id: tools.id })
      .from(tools)
      .where(and(eq(tools.serverId, server.id), eq(tools.name, v.name)));
    if (taken) throw new ConflictException(`A custom tool named ${v.name} already exists`);

    const row = await this.db.transaction(async (tx) => {
      const [t] = await tx
        .insert(tools)
        .values({
          serverId: server.id,
          name: v.name,
          title: v.title,
          description: v.description,
          inputSchema: customToolInputSchema(v.parameters),
          http: httpOf(v),
          tier: v.tier,
          customerArg: v.customerArg,
          timeoutMs: v.timeoutMs,
          enabled: v.enabled,
          createdBy: ctx.user?.id ?? null,
        })
        .returning();
      await this.changed(
        tx,
        ctx,
        'tool.custom_created',
        t!.id,
        { name: v.name, method: v.method, url: v.url, tier: v.tier, enabled: v.enabled },
        'tool',
      );
      return t!;
    });
    return this.view(row, server, ctx.user?.name ?? null);
  }

  /** Replaces a custom tool's definition. Its name stays: the model and the history use it. */
  async updateCustom(ctx: RequestCtx, id: string, v: ParsedCustomToolUpdate): Promise<ToolView> {
    const { tool, server } = await this.customTool(id);
    await this.checkUrl(sampleUrl(v.url));
    const row = await this.db.transaction(async (tx) => {
      const [t] = await tx
        .update(tools)
        .set({
          title: v.title,
          description: v.description,
          inputSchema: customToolInputSchema(v.parameters),
          http: httpOf(v),
          tier: v.tier,
          customerArg: v.customerArg,
          timeoutMs: v.timeoutMs,
          enabled: v.enabled,
          updatedAt: new Date(),
        })
        .where(eq(tools.id, id))
        .returning();
      await this.changed(
        tx,
        ctx,
        'tool.custom_updated',
        id,
        { name: tool.name, method: v.method, url: v.url, tier: v.tier, enabled: v.enabled },
        'tool',
      );
      return t!;
    });
    return this.view(row, server, null);
  }

  /** Removes a custom tool that was never used; one with history can only be switched off. */
  async deleteCustom(ctx: RequestCtx, id: string) {
    const { tool } = await this.customTool(id);
    const [used] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(toolCalls)
      .where(eq(toolCalls.toolId, id));
    if (used && used.n > 0) {
      throw new ConflictException('This tool has call history; switch it off instead');
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(tools).where(eq(tools.id, id));
      await this.changed(tx, ctx, 'tool.custom_deleted', id, { name: tool.name }, 'tool');
    });
    const key = customToolTokenKey(tool.name);
    if ((await this.secrets.has(key)).set) await this.secrets.delete(ctx, key);
  }

  async customTool(id: string): Promise<{ tool: ToolRow; server: ServerRow }> {
    const found = await this.tool(id);
    if (!found.tool.http) throw new NotFoundException('Custom tool not found');
    return found;
  }

  /** The token a custom tool sends, read server-side. */
  customToken(tool: ToolRow): Promise<string | null> {
    return tool.http?.authHeader
      ? this.secrets.get(customToolTokenKey(tool.name))
      : Promise.resolve(null);
  }

  get privateHosts(): string[] {
    return this.env.TOOL_PRIVATE_HOSTS;
  }

  /** The built-in holder of custom tools, created the first time one is needed. */
  private async customServer(): Promise<ServerRow> {
    const [existing] = await this.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.slug, CUSTOM_TOOLS_SLUG));
    if (existing) return existing;
    const [created] = await this.db
      .insert(mcpServers)
      .values({ name: 'Custom tools', slug: CUSTOM_TOOLS_SLUG, url: '', kind: 'custom' })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [raced] = await this.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.slug, CUSTOM_TOOLS_SLUG));
    return raced!;
  }

  private async view(t: ToolRow, s: ServerRow, creator: string | null): Promise<ToolView> {
    const base = toolView(t, s);
    if (!t.http) return base;
    const key = customToolTokenKey(t.name);
    return {
      ...base,
      custom: {
        ...t.http,
        token: { key, ...(await this.secrets.has(key)) },
        createdBy: t.createdBy ? { id: t.createdBy, name: creator ?? 'Former user' } : null,
      },
    };
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
    return this.view(row, server, null);
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
              `${tool.http ? (tool.title ?? tool.name) : server.name}: ${tool.description || tool.title || tool.name}${approval}`.slice(
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
    custom: null,
  };
}

/** A URL with its placeholders filled in, for checking where it points. */
const sampleUrl = (url: string) => url.replace(/\{[^{}]*\}/g, 'x');

const httpOf = (v: ParsedCustomToolUpdate): CustomToolHttp => ({
  method: v.method,
  url: v.url,
  authHeader: v.authHeader,
  parameters: v.parameters,
});

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
