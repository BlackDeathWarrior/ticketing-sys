import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createCustomToolSchema,
  type CreateMcpServerInput,
  createMcpServerSchema,
  type DecideApprovalInput,
  decideApprovalSchema,
  listApprovalsQuerySchema,
  type ParsedCustomTool,
  type ParsedCustomToolUpdate,
  testToolSchema,
  updateCustomToolSchema,
  type UpdateMcpServerInput,
  updateMcpServerSchema,
  type UpdateToolInput,
  updateToolSchema,
} from '@tms/shared';
import type { z } from 'zod';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { TicketsService } from '../tickets/tickets.service';
import { ApprovalsService } from './approvals.service';
import { forModel, ToolGatewayService } from './tool-gateway.service';
import { ToolsService } from './tools.service';

/** Settings → Tools & MCP: servers, their tools, and test calls. Admin only. */
@ApiTags('tools')
@ApiBearerAuth()
@Controller('tools')
export class ToolsController {
  constructor(
    private readonly tools: ToolsService,
    private readonly gateway: ToolGatewayService,
  ) {}

  @Get('servers')
  @RequirePermission('tool:manage')
  servers() {
    return this.tools.listServers();
  }

  @Post('servers')
  @RequirePermission('tool:manage')
  createServer(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(createMcpServerSchema)) body: CreateMcpServerInput,
  ) {
    return this.tools.createServer(ctx, body);
  }

  @Patch('servers/:id')
  @RequirePermission('tool:manage')
  updateServer(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateMcpServerSchema)) body: UpdateMcpServerInput,
  ) {
    return this.tools.updateServer(ctx, id, body);
  }

  @Delete('servers/:id')
  @HttpCode(204)
  @RequirePermission('tool:manage')
  async deleteServer(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.tools.deleteServer(ctx, id);
  }

  /** Lists the server's tools and stores them; new tools start disabled. */
  @Post('servers/:id/sync')
  @HttpCode(200)
  @RequirePermission('tool:manage')
  sync(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.tools.sync(ctx, id);
  }

  @Get()
  @RequirePermission('tool:manage')
  list() {
    return this.tools.listTools();
  }

  // ---- Custom tools: for admins and for roles an admin gave `tool:create` (ADR 0017) ----

  @Get('custom')
  @RequirePermission('tool:create')
  listCustom() {
    return this.tools.listCustom();
  }

  @Post('custom')
  @RequirePermission('tool:create')
  createCustom(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(createCustomToolSchema)) body: ParsedCustomTool,
  ) {
    return this.tools.createCustom(ctx, body);
  }

  @Put('custom/:id')
  @RequirePermission('tool:create')
  updateCustom(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateCustomToolSchema)) body: ParsedCustomToolUpdate,
  ) {
    return this.tools.updateCustom(ctx, id, body);
  }

  @Delete('custom/:id')
  @HttpCode(204)
  @RequirePermission('tool:create')
  async deleteCustom(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.tools.deleteCustom(ctx, id);
  }

  /** Runs a custom read or write tool once, recorded like any call. */
  @Post('custom/:id/test')
  @HttpCode(200)
  @RequirePermission('tool:create')
  async testCustom(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(testToolSchema)) body: z.output<typeof testToolSchema>,
  ) {
    await this.tools.customTool(id);
    return this.test(ctx, id, body);
  }

  @Patch(':id')
  @RequirePermission('tool:manage')
  update(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateToolSchema)) body: UpdateToolInput,
  ) {
    return this.tools.updateTool(ctx, id, body);
  }

  /**
   * Runs a read or write tool once with the given arguments, recorded like any
   * call. Transactional tools can't be tested here: they only run after an
   * approval on a real ticket.
   */
  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission('tool:manage')
  async test(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(testToolSchema)) body: z.output<typeof testToolSchema>,
  ) {
    const { tool, server } = await this.tools.tool(id);
    if (tool.tier === 'transactional') {
      throw new BadRequestException(
        'Transactional tools run only after an approval, so they cannot be tested here',
      );
    }
    const r = await this.gateway.invoke(ctx, {
      tool,
      server,
      args: body.args,
      ticketId: null,
      conversationId: null,
      customerEmail: body.customerEmail ?? null,
    });
    return { status: r.status, ...forModel(r) };
  }
}

/** The approvals inbox, and a ticket's tool calls. */
@ApiTags('approvals')
@ApiBearerAuth()
@Controller()
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly gateway: ToolGatewayService,
    private readonly tickets: TicketsService,
  ) {}

  /** The requests the caller may decide: their teams', and with `approval:approve` the rest (ADR 0031). */
  @Get('approvals')
  @RequirePermission('ticket:read')
  list(
    @Ctx() ctx: RequestCtx,
    @Query(new ZodPipe(listApprovalsQuerySchema)) q: z.output<typeof listApprovalsQuerySchema>,
  ) {
    return this.approvals.list(ctx.user!, q);
  }

  @Get('approvals/:id')
  @RequirePermission('ticket:read')
  get(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.get(ctx.user!, id);
  }

  /** Any member of the deciding team, or a super admin; the service checks which (ADR 0031). */
  @Post('approvals/:id/decide')
  @HttpCode(200)
  @RequirePermission('ticket:read')
  decide(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decideApprovalSchema)) body: DecideApprovalInput,
  ) {
    return this.approvals.decide(ctx, id, body);
  }

  /** What the AI did in company systems on this ticket, with any approvals. */
  @Get('tickets/:id/tool-calls')
  @RequirePermission('ticket:read')
  async calls(@Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.tickets.get(id);
    return this.gateway.callsForTicket(ticket.id);
  }
}
