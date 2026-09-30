import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChannelsModule } from '../channels/channels.module';
import { ChatGateway } from './chat.gateway';
import { ChatSessionService } from './chat-session.service';

/** Web chat channel (API process only: it hosts the /chat socket namespace). */
@Module({
  // Secrets are passed per call: session tokens use JWT_SECRET, identity tokens CHAT_IDENTITY_SECRET.
  imports: [ChannelsModule, JwtModule.register({})],
  providers: [ChatGateway, ChatSessionService],
})
export class ChatModule {}
