import { Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { ChannelHealth } from '@tms/shared';
import { ChatGateway } from '../../chat/chat.gateway';
import { ChatModule } from '../../chat/chat.module';
import { RequirePermission } from '../../common/request-context';
import { ChannelsModule } from '../channels.module';
import { ChannelHealthService } from './channel-health.service';

/** The channel status lights: what is connected, what isn't, and why. */
@ApiTags('channels')
@ApiBearerAuth()
@Controller('channels/health')
export class ChannelHealthController {
  constructor(
    private readonly health: ChannelHealthService,
    private readonly chat: ChatGateway,
  ) {}

  @Get()
  @RequirePermission('settings:channels')
  list(): Promise<ChannelHealth[]> {
    return this.health.all({ visitors: this.chat.connected() });
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
  imports: [ChannelsModule, ChatModule],
  controllers: [ChannelHealthController],
})
export class ChannelHealthModule {}
