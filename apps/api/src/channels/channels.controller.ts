import {
  Body,
  Controller,
  Get,
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
  type ReplyInput,
  replySchema,
  type StartConversationInput,
  startConversationSchema,
} from '@tms/shared';
import type { FastifyReply } from 'fastify';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
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

  /** Starts a new conversation on a ticket (email only for now). */
  @Post('tickets/:id/conversations')
  @RequirePermission('message:send')
  start(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(startConversationSchema)) body: StartConversationInput,
  ) {
    return this.outbound.startEmailConversation(ctx, id, body.body);
  }

  /** Replies on the conversation's own channel. */
  @Post('conversations/:id/messages')
  @RequirePermission('message:send')
  reply(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(replySchema)) body: ReplyInput,
  ) {
    return this.outbound.reply(ctx, id, body.body);
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
