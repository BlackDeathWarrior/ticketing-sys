import { Global, Module } from '@nestjs/common';
import { AiBehaviourService } from './ai-behaviour.service';
import { AppSettingsService } from './app-settings.service';
import { BrandingService } from './branding.service';
import { ChannelConfigService } from './channel-config.service';
import { ChannelSignalsService } from './channel-signals.service';
import { CustomerExperienceService } from './customer-experience.service';
import { PriorityRulesService } from './priority-rules.service';
import { SecretsService } from './secrets.service';
import { PriorityRulesController, SettingsController } from './settings.controller';
import { CustomerMail } from './customer-mail.service';
import { SystemMailer } from './system-mailer.service';

/** Secrets, typed app settings and channel configuration; used by the API and the worker. */
@Global()
@Module({
  controllers: [SettingsController, PriorityRulesController],
  providers: [
    PriorityRulesService,
    SecretsService,
    AppSettingsService,
    ChannelConfigService,
    ChannelSignalsService,
    AiBehaviourService,
    CustomerExperienceService,
    BrandingService,
    SystemMailer,
    CustomerMail,
  ],
  exports: [
    PriorityRulesService,
    SecretsService,
    AppSettingsService,
    ChannelConfigService,
    ChannelSignalsService,
    AiBehaviourService,
    CustomerExperienceService,
    BrandingService,
    SystemMailer,
    CustomerMail,
  ],
})
export class SettingsModule {}
