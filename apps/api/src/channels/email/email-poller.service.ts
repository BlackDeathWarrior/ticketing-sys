import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import type { AttachmentRef } from '@tms/shared';
import { ImapFlow } from 'imapflow';
import Redis from 'ioredis';
import { simpleParser } from 'mailparser';
import { REDIS } from '../../infra/tokens';
import {
  ChannelConfigService,
  type ResolvedEmailConfig,
} from '../../settings/channel-config.service';
import { StorageService } from '../../storage/storage.service';
import { InboundService } from '../inbound.service';
import { emailToEnvelope } from './email.util';

const LOCK_TTL_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Reads the support mailbox over IMAP. One worker holds a Redis lock and
 * owns the connection; it processes unseen mail when the server announces
 * new messages (IDLE) and on a fallback timer, then marks each message seen.
 * The mailbox comes from Settings (or env vars); `restart()` reconnects after
 * a settings change.
 */
@Injectable()
export class EmailPollerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(EmailPollerService.name);
  private readonly instanceId = randomUUID();
  private lockKey = '';
  private config?: ResolvedEmailConfig;
  private client?: ImapFlow;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly channels: ChannelConfigService,
    private readonly inbound: InboundService,
    private readonly storage: StorageService,
  ) {}

  onApplicationBootstrap() {
    this.loop = this.run();
  }

  async beforeApplicationShutdown() {
    this.stopped = true;
    this.wake?.();
    await this.client?.logout().catch(() => undefined);
    await this.loop;
    await this.releaseLock();
  }

  /** Drops the current session so the loop reconnects with the latest settings. */
  async restart() {
    this.logger.log('email settings changed; reconnecting');
    const client = this.client;
    this.wake?.();
    await client?.logout().catch(() => client.close());
  }

  /** Processes whatever is unseen now; calls queue up so runs never overlap. */
  poll(): Promise<void> {
    this.queue = this.queue
      .then(() => this.processUnseen())
      .catch((err) => this.logger.error(`mailbox poll failed: ${(err as Error).message}`));
    return this.queue;
  }

  private async run() {
    while (!this.stopped) {
      const config = await this.channels.email().catch((err: Error) => {
        this.logger.error(`could not load email settings: ${err.message}`);
        return null;
      });
      if (!config?.enabled) {
        await this.releaseLock();
        this.config = undefined;
        await this.idle(30_000);
        continue;
      }
      const key = `tms:lock:imap:${config.imapUser}@${config.imapHost}`;
      if (key !== this.lockKey) await this.releaseLock();
      this.lockKey = key;
      this.config = config;
      if (!(await this.acquireLock())) {
        await this.idle(LOCK_TTL_MS / 2);
        continue;
      }
      try {
        await this.watch(config);
      } catch (err) {
        this.logger.warn(`IMAP session ended: ${(err as Error).message}`);
      }
      if (!this.stopped) await this.idle(5_000);
    }
  }

  /** Sleeps, unless restart() or shutdown wakes it early. */
  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /** Holds one IMAP session until it closes or the lock is lost. */
  private async watch(config: ResolvedEmailConfig) {
    const client = new ImapFlow({
      host: config.imapHost,
      port: config.imapPort,
      secure: config.imapSecure,
      auth: { user: config.imapUser, pass: config.imapPassword },
      logger: false,
    });
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.on('error', (err: Error) => this.logger.warn(`IMAP error: ${err.message}`));
    await client.connect();
    await client.mailboxOpen(config.imapMailbox);
    this.client = client;
    this.logger.log(`watching ${config.imapUser}/${config.imapMailbox}`);

    client.on('exists', () => void this.poll());
    const fallback = setInterval(() => void this.poll(), config.pollSeconds * 1000);
    const renew = setInterval(async () => {
      if (!(await this.renewLock())) {
        this.logger.warn('lost the mailbox lock; disconnecting');
        await client.logout().catch(() => client.close());
      }
    }, LOCK_TTL_MS / 3);

    await this.poll();
    await closed;
    clearInterval(fallback);
    clearInterval(renew);
    this.client = undefined;
  }

  private async processUnseen() {
    const client = this.client;
    if (!client?.usable) return;
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids) {
      if (this.stopped || !client.usable) return;
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const ok = await this.processOne(uid, msg.source);
      // Leave the message unseen when intake failed for a transient reason, so it is retried.
      if (ok) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    }
  }

  /** Returns true when the message is handled (stored or deliberately skipped). */
  private async processOne(uid: number, source: Buffer): Promise<boolean> {
    let mail;
    try {
      mail = await simpleParser(source);
    } catch (err) {
      this.logger.error(`unparseable message uid ${uid}: ${(err as Error).message}`);
      await this.client?.messageFlagsAdd(String(uid), ['\\Flagged'], { uid: true });
      return true;
    }

    try {
      const attachments: AttachmentRef[] = [];
      for (const a of mail.attachments) {
        if (!this.storage.enabled || a.size > MAX_ATTACHMENT_BYTES) {
          this.logger.warn(`skipping attachment ${a.filename ?? '(unnamed)'} (${a.size} bytes)`);
          continue;
        }
        attachments.push(
          await this.storage.putAttachment({
            filename: a.filename ?? 'attachment',
            contentType: a.contentType,
            content: a.content,
          }),
        );
      }
      const result = emailToEnvelope(mail, {
        ourAddress: this.config!.address,
        attachments,
        fallbackId: `<imap-${uid}-${Date.now()}@tms.invalid>`,
      });
      if (!result.ok) {
        this.logger.log(`skipped email uid ${uid}: ${result.reason}`);
        return true;
      }
      const r = await this.inbound.handle(result.envelope);
      this.logger.log(
        `email uid ${uid} → ticket ${r.ticketId}${r.duplicate ? ' (duplicate)' : r.createdTicket ? ' (new)' : ''}`,
      );
      return true;
    } catch (err) {
      this.logger.error(`email uid ${uid} failed, will retry: ${(err as Error).message}`);
      return false;
    }
  }

  private async acquireLock(): Promise<boolean> {
    const res = await this.redis
      .set(this.lockKey, this.instanceId, 'PX', LOCK_TTL_MS, 'NX')
      .catch(() => null);
    return res === 'OK' || (await this.renewLock());
  }

  private async releaseLock() {
    if (!this.lockKey) return;
    await this.redis.eval(RELEASE_LOCK, 1, this.lockKey, this.instanceId).catch(() => undefined);
  }

  private async renewLock(): Promise<boolean> {
    const res = await this.redis
      .eval(RENEW_LOCK, 1, this.lockKey, this.instanceId, String(LOCK_TTL_MS))
      .catch(() => 0);
    return res === 1;
  }
}

const RENEW_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
