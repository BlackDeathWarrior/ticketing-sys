import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AgentGateway } from './agent.gateway';

/** API-side sockets for agent consoles. The worker publishes through emitterProvider. */
@Module({
  imports: [AuthModule, UsersModule],
  providers: [AgentGateway],
})
export class RealtimeModule {}
