import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CreateUserInput,
  createUserSchema,
  type UpdateUserInput,
  updateUserSchema,
} from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('user:read')
  list() {
    return this.users.list();
  }

  @Get(':id')
  @RequirePermission('user:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post()
  @RequirePermission('user:manage')
  create(@Ctx() ctx: RequestCtx, @Body(new ZodPipe(createUserSchema)) body: CreateUserInput) {
    return this.users.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('user:manage')
  update(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateUserSchema)) body: UpdateUserInput,
  ) {
    return this.users.update(ctx, id, body);
  }
}
