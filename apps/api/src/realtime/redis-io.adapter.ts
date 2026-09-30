import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { Env } from '../config/env';

/**
 * Socket.IO over Redis pub/sub, so events emitted by any API instance or by
 * the worker (through @socket.io/redis-emitter) reach every connected client.
 */
export class RedisIoAdapter extends IoAdapter {
  private pub?: Redis;
  private sub?: Redis;
  private quitting?: Promise<void>;

  constructor(
    app: INestApplicationContext,
    private readonly env: Env,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const allowAny = this.env.CHAT_ORIGINS.includes('*');
    const allowed = new Set([...this.env.CORS_ORIGINS, ...this.env.CHAT_ORIGINS]);
    const server: Server = super.createIOServer(port, {
      ...options,
      cors: {
        // Browsers send Origin; agent and chat sockets authenticate with tokens, not cookies.
        origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
          cb(null, !origin || allowAny || allowed.has(origin)),
        credentials: false,
      },
    });
    if (!this.pub || !this.sub) {
      this.pub = new Redis(this.env.REDIS_URL);
      this.sub = this.pub.duplicate();
      // Errors during shutdown (EPIPE, closed connection) are expected; don't crash on them.
      for (const client of [this.pub, this.sub]) client.on('error', () => undefined);
    }
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  /** Nest calls this once per gateway namespace; the Redis clients are shared, so quit them once. */
  override async close(server: Server): Promise<void> {
    await super.close(server);
    this.quitting ??= Promise.allSettled(
      [this.pub, this.sub].map((c) => (c && c.status !== 'end' ? c.quit() : undefined)),
    ).then(() => undefined);
    await this.quitting;
  }
}
