import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type ApproveDraftInput,
  approveDraftSchema,
  type ParsedSendTemplate,
  type ReplyInput,
  replySchema,
  sendTemplateSchema,
  type StartConversationInput,
  startConversationSchema,
} from '@tms/shared';
import type { FastifyReply } from 'fastify';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { ActsOnTicket } from '../tickets/ticket-access';
import { ConversationsService } from '../conversations/conversations.service';
import { StorageService } from '../storage/storage.service';
import { TicketsService } from '../tickets/tickets.service';
import { OutboundService } from './outbound.service';

@ApiTags('conversations')
@ApiBearerAuth()
@Controller()
export class ChannelsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly outbound: OutboundService,
    private readonly tickets: TicketsService,
    private readonly storage: StorageService,
  ) {}

  @Get('tickets/:id/conversations')
  @RequirePermission('ticket:read')
  async list(@Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.tickets.get(id);
    return this.conversations.listForTicket(ticket.id);
  }

  /** Starts a new conversation on a ticket: an email, or a WhatsApp template. */
  @Post('tickets/:id/conversations')
  @RequirePermission('message:send')
  @ActsOnTicket('ticket')
  start(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(startConversationSchema)) body: StartConversationInput,
  ) {
    return body.channel === 'whatsapp'
      ? this.outbound.startWhatsAppConversation(ctx, id, body.template)
      : this.outbound.startEmailConversation(ctx, id, body.body);
  }

  /** Sends an approved WhatsApp template on a conversation (needed once the 24-hour window closes). */
  @Post('conversations/:id/whatsapp-template')
  @RequirePermission('message:send')
  @ActsOnTicket('conversation')
  template(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(sendTemplateSchema)) body: ParsedSendTemplate,
  ) {
    return this.outbound.replyWithTemplate(ctx, id, body);
  }

  /** Replies on the conversation's own channel. */
  @Post('conversations/:id/messages')
  @RequirePermission('message:send')
  @ActsOnTicket('conversation')
  reply(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(replySchema)) body: ReplyInput,
  ) {
    return this.outbound.reply(ctx, id, body.body);
  }

  /** Sends an AI draft, optionally edited. */
  @Post('messages/:id/approve')
  @HttpCode(200)
  @RequirePermission('message:approve_draft')
  @ActsOnTicket('message')
  approve(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(approveDraftSchema)) body: ApproveDraftInput,
  ) {
    return this.outbound.approveDraft(ctx, id, body.body);
  }

  /** Throws an AI draft away; the customer never sees it. */
  @Post('messages/:id/discard')
  @HttpCode(200)
  @RequirePermission('message:approve_draft')
  @ActsOnTicket('message')
  discard(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.outbound.discardDraft(ctx, id);
  }

  @Get('messages/:id/attachments/:index')
  @RequirePermission('ticket:read')
  async attachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const { message } = await this.conversations.getMessage(id);
    const file = message.attachments[index];
    if (!file) throw new NotFoundException('Attachment not found');
    const stream = await this.storage.get(file.key);
    void res.header('content-type', file.contentType);
    void res.header(
      'content-disposition',
      `attachment; filename="${encodeURIComponent(file.filename)}"`,
    );
    return new StreamableFile(stream);
  }
}
