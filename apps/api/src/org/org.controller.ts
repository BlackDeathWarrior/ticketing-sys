import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  createCategorySchema,
  createTeamSchema,
  type UpdateCategoryInput,
  updateCategorySchema,
  type UpdateTeamInput,
  updateTeamSchema,
} from '@tms/shared';
import type { z } from 'zod';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { OrgService } from './org.service';

@ApiTags('org')
@ApiBearerAuth()
@Controller()
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('teams')
  @RequirePermission('ticket:read')
  listTeams() {
    return this.org.listTeams();
  }

  @Post('teams')
  @RequirePermission('team:manage')
  createTeam(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(createTeamSchema)) body: z.infer<typeof createTeamSchema>,
  ) {
    return this.org.createTeam(ctx, body);
  }

  @Patch('teams/:id')
  @RequirePermission('team:manage')
  updateTeam(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateTeamSchema)) body: UpdateTeamInput,
  ) {
    return this.org.updateTeam(ctx, id, body);
  }

  @Delete('teams/:id')
  @HttpCode(204)
  @RequirePermission('team:manage')
  deleteTeam(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.org.deleteTeam(ctx, id);
  }

  @Get('categories')
  @RequirePermission('ticket:read')
  listCategories() {
    return this.org.listCategories();
  }

  @Post('categories')
  @RequirePermission('settings:categories')
  createCategory(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(createCategorySchema)) body: z.infer<typeof createCategorySchema>,
  ) {
    return this.org.createCategory(ctx, body);
  }

  @Patch('categories/:id')
  @RequirePermission('settings:categories')
  updateCategory(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateCategorySchema)) body: UpdateCategoryInput,
  ) {
    return this.org.updateCategory(ctx, id, body);
  }
}
