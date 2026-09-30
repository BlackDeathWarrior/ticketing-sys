import { Module } from '@nestjs/common';
import { AiRunsService } from './ai-runs.service';

/** The AI's run records on their own, so handover can read them without the whole AI module. */
@Module({
  providers: [AiRunsService],
  exports: [AiRunsService],
})
export class AiRunsModule {}
