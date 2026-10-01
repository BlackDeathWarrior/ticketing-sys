import { Global, Module } from '@nestjs/common';
import { AiBehaviourService } from './ai-behaviour.service';
import { AppSettingsService } from './app-settings.service';
import { ChannelConfigService } from './channel-config.service';
import { ChannelSignalsService } from './channel-signals.service';
import { CustomerExperienceService } from './customer-experience.service';
import { SecretsService } from './secrets.service';
import { SettingsController } from './settings.controller';
import { SystemMailer } from './system-mailer.service';

/** Secrets, typed app settings and channel configuration; used by the API and the worker. */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [
    SecretsService,
    AppSettingsService,
    ChannelConfigService,
    ChannelSignalsService,
    AiBehaviourService,
    CustomerExperienceService,
    SystemMailer,
  ],
  exports: [
    SecretsService,
    AppSettingsService,
    ChannelConfigService,
    ChannelSignalsService,
    AiBehaviourService,
    CustomerExperienceService,
    SystemMailer,
  ],
})
export class SettingsModule {}
