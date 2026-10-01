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
