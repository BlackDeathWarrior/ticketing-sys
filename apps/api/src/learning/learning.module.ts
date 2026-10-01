import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type DomainEvent,
  type DomainEventType,
  type LessonInput,
  lessonSchema,
  listReviewsQuerySchema,
  type ResolveReviewInput,
  resolveReviewSchema,
  updateLessonSchema,
} from '@tms/shared';
import type { z } from 'zod';
import { AiRunsModule } from '../ai/ai-runs.module';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { ConversationsModule } from '../conversations/conversations.module';
import { CsatModule } from '../csat/csat.module';
import { KbModule } from '../kb/kb.module';
import { OrgModule } from '../org/org.module';
import { TicketsModule } from '../tickets/tickets.module';
import type { DomainEventHandler } from '../worker/domain-events';
import { LearningService } from './learning.service';

/** What the AI learned from ratings, and the reviewer's inbox (ADR 0020). */
@ApiTags('learning')
@ApiBearerAuth()
@Controller('learning')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  @Get('overview')
  @RequirePermission('learning:manage')
  overview() {
    return this.learning.overview();
  }

  @Get('reviews')
  @RequirePermission('learning:manage')
  reviews(@Query(new ZodPipe(listReviewsQuerySchema)) q: z.output<typeof listReviewsQuerySchema>) {
    return this.learning.listReviews(q);
  }

  @Post('reviews/:id/resolve')
  @HttpCode(200)
  @RequirePermission('learning:manage')
  resolve(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(resolveReviewSchema)) body: ResolveReviewInput,
  ) {
    return this.learning.resolveReview(ctx, id, body);
  }

  @Get('lessons')
  @RequirePermission('learning:manage')
  lessons() {
    return this.learning.listLessons();
  }

  @Post('lessons')
  @RequirePermission('learning:manage')
  createLesson(@Ctx() ctx: RequestCtx, @Body(new ZodPipe(lessonSchema)) body: LessonInput) {
    return this.learning.createLesson(ctx, body);
  }

  @Patch('lessons/:id')
  @HttpCode(204)
  @RequirePermission('learning:manage')
  updateLesson(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateLessonSchema)) body: z.output<typeof updateLessonSchema>,
  ) {
    return this.learning.updateLesson(ctx, id, body);
  }

  @Delete('lessons/:id')
  @HttpCode(204)
  @RequirePermission('learning:manage')
  deleteLesson(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.learning.deleteLesson(ctx, id);
  }
}

/** Worker: every rating becomes feedback on the AI's work, and maybe a review. */
@Injectable()
export class LearningHandler implements DomainEventHandler {
  readonly name = 'learning';

  constructor(private readonly learning: LearningService) {}

  handles(type: DomainEventType): boolean {
    return type === 'csat.submitted';
  }

  async handle(event: DomainEvent): Promise<void> {
    await this.learning.onRating(event.aggregateId);
  }
}

@Module({
  imports: [CsatModule, TicketsModule, AiRunsModule, KbModule, ConversationsModule, OrgModule],
  controllers: [LearningController],
  providers: [LearningService, LearningHandler],
  exports: [LearningService, LearningHandler],
})
export class LearningModule {}
