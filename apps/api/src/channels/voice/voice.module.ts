import { Controller, Get, Module, Param, ParseUUIDPipe, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { AiModule } from '../../ai/ai.module';
import { ChatModule } from '../../chat/chat.module';
import { Ctx, type RequestCtx, RequirePermission } from '../../common/request-context';
import { HandoverModule } from '../../handover/handover.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { TicketsService } from '../../tickets/tickets.service';
import { UsersModule } from '../../users/users.module';
import { ChannelsModule } from '../channels.module';
import { SarvamSpeech } from './sarvam-speech';
import { SPEECH_PROVIDER } from './speech';
import { VoiceCallsService } from './voice-calls.service';
import { VoiceAgentGateway, VoiceGateway } from './voice.gateway';
import { VoiceService } from './voice.service';

@ApiTags('voice')
@ApiBearerAuth()
@Controller()
export class VoiceController {
  constructor(
    private readonly records: VoiceCallsService,
    private readonly voice: VoiceService,
    private readonly tickets: TicketsService,
  ) {}

  /** A ticket's calls, newest first, with the live state of one in progress. */
  @Get('tickets/:id/voice-calls')
  @RequirePermission('ticket:read')
  async calls(@Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.tickets.get(id);
    return this.records.forTicket(ticket.id, (callId) => this.voice.stateOf(callId));
  }

  /** The stereo recording (caller left, our side right). Listening is audited. */
  @Get('voice/calls/:id/recording')
  @RequirePermission('voice:recording_read')
  async recording(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const { stream, bytes, type } = await this.records.recording(ctx, id);
    void res.header('content-type', type);
    if (bytes) void res.header('content-length', String(bytes));
    void res.header('content-disposition', `inline; filename="call-${id}.${type === 'audio/mpeg' ? 'mp3' : 'wav'}"`);
    return new StreamableFile(stream);
  }
}

/**
 * Live voice calls: API process only (the caller's and agent's sockets end
 * here). The call records and their retention job are in ChannelsModule and
 * the worker.
 */
@Module({
  imports: [ChannelsModule, ChatModule, AiModule, HandoverModule, UsersModule, TicketsModule],
  controllers: [VoiceController],
  providers: [
    SarvamSpeech,
    { provide: SPEECH_PROVIDER, useExisting: SarvamSpeech },
    VoiceService,
    VoiceGateway,
    VoiceAgentGateway,
  ],
  exports: [VoiceService],
})
export class VoiceModule {}
