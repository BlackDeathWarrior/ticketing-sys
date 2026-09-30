import { Global, Module } from '@nestjs/common';
import { AppSettingsService } from './app-settings.service';
import { ChannelConfigService } from './channel-config.service';
import { SecretsService } from './secrets.service';
import { SettingsController } from './settings.controller';

/** Secrets, typed app settings and channel configuration; used by the API and the worker. */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SecretsService, AppSettingsService, ChannelConfigService],
  exports: [SecretsService, AppSettingsService, ChannelConfigService],
})
export class SettingsModule {}
