import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { UsersModule } from '../users/users.module';
import { KbConnectorsController } from './connectors/kb-connectors.controller';
import { KbConnectorsService } from './connectors/kb-connectors.service';
import { KbSearchService } from './kb-search.service';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';

/**
 * Knowledge base: documents, search (API and AI), and — in the worker —
 * indexing (KbIndexerService, KbIngestWorker; see worker.module.ts).
 */
@Module({
  imports: [LlmModule, UsersModule],
  controllers: [KbController, KbConnectorsController],
  providers: [KbService, KbSearchService, KbConnectorsService],
  exports: [KbService, KbSearchService, KbConnectorsService],
})
export class KbModule {}
