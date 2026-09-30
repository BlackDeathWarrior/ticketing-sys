import { Logger } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { AGENT_NAMESPACE, AGENTS_ROOM } from '@tms/shared';
import type { Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { UsersService } from '../users/users.service';

/**
 * Live updates for agent consoles. Clients authenticate with their access
 * token; the worker pushes `event` messages ({type, ticketId, ...}) to the
 * `agents` room and clients refetch what they display.
 */
@WebSocketGateway({ namespace: AGENT_NAMESPACE })
export class AgentGateway implements OnGatewayConnection {
  private readonly logger = new Logger(AgentGateway.name);

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  async handleConnection(socket: Socket) {
    const token = (socket.handshake.auth as { token?: unknown })?.token;
    const payload = typeof token === 'string' ? await this.auth.verifyAccessToken(token) : null;
    const user = payload ? await this.users.getAuthContext(payload.sub) : null;
    if (!user || !user.permissions.includes('ticket:read')) {
      socket.emit('error', { message: 'Unauthorized' });
      socket.disconnect(true);
      return;
    }
    socket.data.userId = user.id;
    await socket.join([AGENTS_ROOM, `user:${user.id}`]);
    this.logger.debug(`agent ${user.email} connected`);
  }
}
