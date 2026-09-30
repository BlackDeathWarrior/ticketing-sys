import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { AttachmentRef } from '@tms/shared';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';

/** Object storage for attachments (any S3-compatible service). */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client?: S3Client;
  private bucketReady?: Promise<void>;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY) {
      this.client = new S3Client({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      });
    }
  }

  get enabled(): boolean {
    return !!this.client;
  }

  /** Stores an attachment under attachments/YYYY/MM/<uuid>/<filename>. */
  async putAttachment(file: {
    filename: string;
    contentType: string;
    content: Buffer;
  }): Promise<AttachmentRef> {
    const client = this.requireClient();
    await this.ensureBucket();
    const now = new Date();
    const safeName = file.filename.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
    const key = `attachments/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}/${safeName}`;
    await client.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: key,
        Body: file.content,
        ContentType: file.contentType,
      }),
    );
    return {
      key,
      filename: file.filename,
      contentType: file.contentType,
      size: file.content.length,
    };
  }

  async get(key: string): Promise<Readable> {
    const res = await this.requireClient().send(
      new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }),
    );
    return res.Body as Readable;
  }

  private requireClient(): S3Client {
    if (!this.client) throw new ServiceUnavailableException('Object storage is not configured');
    return this.client;
  }

  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const client = this.requireClient();
      try {
        await client.send(new HeadBucketCommand({ Bucket: this.env.S3_BUCKET }));
      } catch {
        this.logger.log(`creating bucket ${this.env.S3_BUCKET}`);
        await client.send(new CreateBucketCommand({ Bucket: this.env.S3_BUCKET }));
      }
    })().catch((err) => {
      this.bucketReady = undefined;
      throw err;
    });
    return this.bucketReady;
  }
}
