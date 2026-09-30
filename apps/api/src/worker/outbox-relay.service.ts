import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import type { Database } from '@tms/db';
import { DOMAIN_EVENTS_QUEUE } from '@tms/shared';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { Client } from 'pg';
import type { Env } from '../config/env';
import { DB, ENV } from '../infra/tokens';
import { relayOutboxBatch } from './outbox-relay';

/**
 * Moves committed outbox rows onto the domain-events queue. It LISTENs for the
 * NOTIFY that the outbox insert trigger sends, so events usually move within
 * milliseconds; polling every OUTBOX_POLL_MS is the fallback.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly connection: Redis;
  readonly queue: Queue;
  private listener?: Client;
  private stopping = false;
  private loop?: Promise<void>;
  private pendingWake = false;
  private wake?: () => void;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(DOMAIN_EVENTS_QUEUE, { connection: this.connection });
  }

  onApplicationBootstrap() {
    void this.listen();
    this.loop = this.run();
  }

  async beforeApplicationShutdown() {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    await this.listener?.end().catch(() => undefined);
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }

  private async run() {
    while (!this.stopping) {
      try {
        const n = await relayOutboxBatch(this.db, this.queue, this.env.OUTBOX_BATCH_SIZE);
        if (n > 0) this.logger.debug(`relayed ${n} event(s)`);
        // A full batch means more is waiting: go again straight away.
        if (n < this.env.OUTBOX_BATCH_SIZE) await this.sleep(this.env.OUTBOX_POLL_MS);
      } catch (err) {
        this.logger.error(`outbox relay failed: ${(err as Error).message}`);
        await this.sleep(this.env.OUTBOX_POLL_MS * 4);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.pendingWake || this.stopping) {
      this.pendingWake = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = () => {
        this.wake = undefined;
        done();
      };
    });
  }

  private onNotify = () => {
    if (this.wake) this.wake();
    else this.pendingWake = true;
  };

  private async listen() {
    if (this.stopping) return;
    const client = new Client({ connectionString: this.env.DATABASE_URL });
    const retry = () => {
      client.removeAllListeners();
      if (!this.stopping) setTimeout(() => void this.listen(), 2000);
    };
    client.on('notification', this.onNotify);
    client.on('error', (err) => {
      this.logger.warn(`outbox LISTEN connection lost: ${err.message}`);
      retry();
    });
    try {
      await client.connect();
      await client.query('LISTEN outbox_events');
      this.listener = client;
    } catch (err) {
      this.logger.warn(`could not LISTEN for outbox events: ${(err as Error).message}`);
      await client.end().catch(() => undefined);
      retry();
    }
  }
}
