import { Module } from '@nestjs/common';
import { LiteLlmAdminClient } from './litellm-admin.client';
import { LlmClientService } from './llm-client.service';
import { LlmController } from './llm.controller';
import { LlmSettingsService } from './llm-settings.service';

/** LLM providers, models and roles on top of LiteLLM, and the client every AI feature uses. */
@Module({
  controllers: [LlmController],
  providers: [LiteLlmAdminClient, LlmSettingsService, LlmClientService],
  exports: [LlmClientService, LlmSettingsService],
})
export class LlmModule {}
