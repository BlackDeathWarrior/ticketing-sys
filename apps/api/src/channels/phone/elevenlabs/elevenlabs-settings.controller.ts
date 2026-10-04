import { BadRequestException, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { ElevenlabsSyncState } from '@tms/shared';
import { RequirePermission } from '../../../common/request-context';
import { AppSettingsService } from '../../../settings/app-settings.service';
import { ELEVENLABS_SYNC_KEY, syncStateSchema } from './elevenlabs-sync-state';
import { ElevenLabsSyncQueue } from './elevenlabs-sync.queue';
import { ElevenLabsClient, ElevenLabsError, type ElevenLabsNumber } from './elevenlabs.client';

/**
 * The ElevenLabs card's own actions in Orbit Desk (ADR 0040): asking for a
 * set-up or sync, reading how the last one went, and listing the numbers
 * connected at ElevenLabs. None of them returns a secret.
 */
@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings/channels/elevenlabs')
export class ElevenLabsSettingsController {
  constructor(
    private readonly queue: ElevenLabsSyncQueue,
    private readonly settings: AppSettingsService,
    private readonly client: ElevenLabsClient,
  ) {}

  /** The worker does the work: this only asks for it. It writes secrets, so it needs that right. */
  @Post('sync')
  @HttpCode(202)
  @RequirePermission('settings:secrets')
  async sync(): Promise<{ requested: true }> {
    await this.queue.request('button');
    return { requested: true };
  }

  @Get('sync')
  @RequirePermission('settings:channels')
  async state(): Promise<ElevenlabsSyncState> {
    return (
      (await this.settings.get(ELEVENLABS_SYNC_KEY, syncStateSchema, { fresh: true })) ??
      syncStateSchema.parse({})
    );
  }

  /** Asked for by a person on the card, never by itself. */
  @Get('numbers')
  @RequirePermission('settings:channels')
  async numbers(): Promise<ElevenLabsNumber[]> {
    try {
      return await this.client.listPhoneNumbers();
    } catch (err) {
      if (err instanceof ElevenLabsError) throw new BadRequestException(err.message);
      throw err;
    }
  }
}
