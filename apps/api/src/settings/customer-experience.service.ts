import { Injectable } from '@nestjs/common';
import {
  CUSTOMER_EXPERIENCE_KEY,
  type CustomerExperience,
  customerExperienceSchema,
  DEFAULT_CUSTOMER_EXPERIENCE,
} from '@tms/shared';
import type { RequestCtx } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AppSettingsService } from './app-settings.service';

/** The customer portal and rating settings (ADR 0019), with defaults when unset. */
@Injectable()
export class CustomerExperienceService {
  constructor(private readonly settings: AppSettingsService) {}

  async get(): Promise<CustomerExperience> {
    return (
      (await this.settings.get(CUSTOMER_EXPERIENCE_KEY, customerExperienceSchema)) ??
      DEFAULT_CUSTOMER_EXPERIENCE
    );
  }

  async save(ctx: RequestCtx, input: unknown): Promise<CustomerExperience> {
    const parsed = new ZodPipe(customerExperienceSchema).transform(input);
    await this.settings.set(ctx, CUSTOMER_EXPERIENCE_KEY, parsed);
    return parsed;
  }
}
