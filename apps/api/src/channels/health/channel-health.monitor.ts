import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HEALTH_CHANNEL_LABELS } from '@tms/shared';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Env } from '../../config/env';
import { ENV } from '../../infra/tokens';
import { NotificationsService } from '../../notifications/notifications.service';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { ChannelSignalsService } from '../../settings/channel-signals.service';
import { UsersService } from '../../users/users.service';

export const CHANNEL_HEALTH_QUEUE = 'channel-health';
const MONITORED = ['email', 'whatsapp'] as const;

/**
 * Checks the live channels on a timer, so the status lights stay true while
 * nobody is looking, and tells the people who manage channels when one that
 * was working stops (ADR 0016). One run at a time across workers.
 */
@Injectable()
export class ChannelHealthMonitor implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ChannelHealthMonitor.name);
  private connection?: Redis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly channels: ChannelConfigService,
    private readonly signals: ChannelSignalsService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
  ) {}

  async onApplicationBootstrap() {
    const seconds = this.env.CHANNEL_CHECK_SECONDS;
    if (seconds === 0) return;
    this.connection = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(CHANNEL_HEALTH_QUEUE, { connection: this.connection });
    this.worker = new Worker(CHANNEL_HEALTH_QUEUE, () => this.run(), {
      connection: this.connection.duplicate(),
      concurrency: 1,
    });
    await this.queue.upsertJobScheduler(
      'channel-check',
      { every: seconds * 1000 },
      { name: 'check', opts: { removeOnComplete: 20, removeOnFail: 20 } },
    );
    // The first scheduled run is a full interval away; look once shortly after start.
    await this.queue.add('check', {}, { delay: 5_000, removeOnComplete: true, removeOnFail: 20 });
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }

  /** Probes each channel that is switched on; returns the ones that just went down. */
  async run(): Promise<string[]> {
    const wentDown: string[] = [];
    for (const kind of MONITORED) {
      const config =
        kind === 'email' ? await this.channels.email() : await this.channels.whatsapp();
      if (!config?.enabled) continue;
      if (kind === 'whatsapp' && !(await this.channels.whatsapp())?.accessToken) continue;

      const before = (await this.signals.get(kind)).probe;
      const after = await this.channels.probe(kind);
      // Only a change from working to not working is news; a channel that never worked is not.
      if (before?.ok && !after.ok) {
        wentDown.push(kind);
        const label = HEALTH_CHANNEL_LABELS[kind];
        this.logger.warn(`${label} stopped working: ${after.error}`);
        const admins = await this.users.withPermission('settings:channels');
        await this.notifications.notify(
          admins.map((u) => u.id),
          {
            kind: 'channel.down',
            title: `${label} stopped working`,
            body: `${after.error ?? 'The connection check failed.'} See Settings → Channels.`,
            // One notification per outage hour, however often the check runs.
            dedupeKey: `channel-down:${kind}:${after.at.slice(0, 13)}`,
          },
        );
      }
    }
    return wentDown;
  }
}
