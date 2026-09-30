import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { UsersModule } from '../users/users.module';
import { KbSearchService } from './kb-search.service';
import { KbController } from './kb.controller';
import { KbService } from './kb.service';

/**
 * Knowledge base: documents, search (API and AI), and — in the worker —
 * indexing (KbIndexerService, KbIngestWorker; see worker.module.ts).
 */
@Module({
  imports: [LlmModule, UsersModule],
  controllers: [KbController],
  providers: [KbService, KbSearchService],
  exports: [KbService, KbSearchService],
})
export class KbModule {}
