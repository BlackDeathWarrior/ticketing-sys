import { Global, Module } from '@nestjs/common';
import { AiBehaviourService } from './ai-behaviour.service';
import { AppSettingsService } from './app-settings.service';
import { ChannelConfigService } from './channel-config.service';
import { ChannelSignalsService } from './channel-signals.service';
import { SecretsService } from './secrets.service';
import { SettingsController } from './settings.controller';

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
  ],
  exports: [
    SecretsService,
    AppSettingsService,
    ChannelConfigService,
    ChannelSignalsService,
    AiBehaviourService,
  ],
})
export class SettingsModule {}
