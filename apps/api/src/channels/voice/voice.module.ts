import {
  type BeforeApplicationShutdown,
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  Param,
  ParseUUIDPipe,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Queue, Worker } from 'bullmq';
import type { FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { AiModule } from '../../ai/ai.module';
import { ChatModule } from '../../chat/chat.module';
import { Ctx, type RequestCtx, RequirePermission } from '../../common/request-context';
import type { Env } from '../../config/env';
import { HandoverModule } from '../../handover/handover.module';
import { ENV } from '../../infra/tokens';
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
    const { stream, bytes } = await this.records.recording(ctx, id);
    void res.header('content-type', 'audio/wav');
    if (bytes) void res.header('content-length', String(bytes));
    void res.header('content-disposition', `inline; filename="call-${id}.wav"`);
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

export const VOICE_RETENTION_QUEUE = 'voice-retention';

/** Worker side: once a day, deletes recordings older than the retention period. */
@Injectable()
export class VoiceRetentionWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(VoiceRetentionWorker.name);
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker?: Worker;

  constructor(
    @Inject(ENV) env: Env,
    private readonly records: VoiceCallsService,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(VOICE_RETENTION_QUEUE, { connection: this.connection });
  }

  async onApplicationBootstrap() {
    this.worker = new Worker(
      VOICE_RETENTION_QUEUE,
      async () => {
        const purged = await this.records.purgeRecordings();
        if (purged) this.logger.log(`deleted ${purged} call recording(s) past retention`);
      },
      { connection: this.connection.duplicate(), concurrency: 1 },
    );
    await this.queue.upsertJobScheduler(
      'voice-retention',
      { every: 24 * 3_600_000 },
      { name: 'purge', opts: { removeOnComplete: 10, removeOnFail: 10 } },
    );
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }
}
