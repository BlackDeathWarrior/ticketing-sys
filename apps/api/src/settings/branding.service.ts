import { Injectable } from '@nestjs/common';
import { type Branding, BRANDING_KEY, brandingSchema, DEFAULT_BRANDING } from '@tms/shared';
import type { RequestCtx } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AppSettingsService } from './app-settings.service';

/** Who the helpdesk speaks for (ADR 0026), with the sample shop's defaults when unset. */
@Injectable()
export class BrandingService {
  constructor(private readonly settings: AppSettingsService) {}

  async get(): Promise<Branding> {
    return (await this.settings.get(BRANDING_KEY, brandingSchema)) ?? DEFAULT_BRANDING;
  }

  async save(ctx: RequestCtx, input: unknown): Promise<Branding> {
    const parsed = new ZodPipe(brandingSchema).transform(input);
    await this.settings.set(ctx, BRANDING_KEY, parsed);
    return parsed;
  }
}
