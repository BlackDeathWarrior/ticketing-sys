import { Controller, Get, HttpCode, Inject, Module, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { ChannelHealth } from '@tms/shared';
import { ChatGateway } from '../../chat/chat.gateway';
import { ChatModule } from '../../chat/chat.module';
import { RequirePermission } from '../../common/request-context';
import type { Env } from '../../config/env';
import { ENV } from '../../infra/tokens';
import { ChannelsModule } from '../channels.module';
import { VoiceModule } from '../voice/voice.module';
import { VoiceService } from '../voice/voice.service';
import { ChannelHealthService } from './channel-health.service';

/** The channel status lights: what is connected, what isn't, and why. */
@ApiTags('channels')
@ApiBearerAuth()
@Controller('channels/health')
export class ChannelHealthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly health: ChannelHealthService,
    private readonly chat: ChatGateway,
    private readonly voice: VoiceService,
  ) {}

  @Get()
  @RequirePermission('settings:channels')
  list(): Promise<ChannelHealth[]> {
    return this.health.all({
      visitors: this.chat.connected(),
      lines: { active: this.voice.activeCalls, max: this.env.VOICE_MAX_CALLS },
    });
  }

  /** "Check now": tries the mail server and Meta, then returns the fresh lights. */
  @Post('check')
  @HttpCode(200)
  @RequirePermission('settings:channels')
  async check(): Promise<ChannelHealth[]> {
    await this.health.probe();
    return this.list();
  }
}

/** API only: it needs the chat gateway to count connected visitors. */
@Module({
  imports: [ChannelsModule, ChatModule, VoiceModule],
  controllers: [ChannelHealthController],
})
export class ChannelHealthModule {}
