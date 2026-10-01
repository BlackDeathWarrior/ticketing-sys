import { Module } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { IntegrationIdentityController, IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

/**
 * Outside apps and their API keys (ADR 0022). AuthModule imports this for
 * `ApiKeysService`, so it must not depend on modules that need authentication.
 */
@Module({
  controllers: [IntegrationsController, IntegrationIdentityController],
  providers: [ApiKeysService, IntegrationsService],
  exports: [ApiKeysService, IntegrationsService],
})
export class IntegrationsModule {}
