import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CreateUserInput,
  createUserSchema,
  type UpdateUserInput,
  updateUserSchema,
  type UserPreferences,
  userPreferencesSchema,
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

/** What a signed-in person sets for themselves; every staff role has `ticket:read`. */
@ApiTags('users')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get('preferences')
  @RequirePermission('ticket:read')
  preferences(@Ctx() ctx: RequestCtx) {
    return this.users.preferences(ctx.user!.id);
  }

  @Put('preferences')
  @RequirePermission('ticket:read')
  setPreferences(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(userPreferencesSchema)) body: UserPreferences,
  ) {
    return this.users.setPreferences(ctx, body);
  }
}

/**
 * Roles and the few permissions an admin can hand to them (ADR 0017). The
 * permissions that make up each role are otherwise fixed in code.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('user:manage')
  list() {
    return this.users.listRoles();
  }

  @Put(':key/permissions/:permission')
  @RequirePermission('user:manage')
  grant(
    @Ctx() ctx: RequestCtx,
    @Param('key') key: string,
    @Param('permission') permission: string,
  ) {
    return this.users.setRolePermission(ctx, key, permission, true);
  }

  @Delete(':key/permissions/:permission')
  @RequirePermission('user:manage')
  revoke(
    @Ctx() ctx: RequestCtx,
    @Param('key') key: string,
    @Param('permission') permission: string,
  ) {
    return this.users.setRolePermission(ctx, key, permission, false);
  }
}
