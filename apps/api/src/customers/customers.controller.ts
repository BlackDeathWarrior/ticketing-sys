import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CreateCustomerInput,
  createCustomerSchema,
  type IdentityInput,
  identityInputSchema,
  listCustomersQuerySchema,
  mergeCustomersSchema,
  type ResolveCustomerInput,
  resolveCustomerSchema,
  type UpdateCustomerInput,
  updateCustomerSchema,
} from '@tms/shared';
import type { z } from 'zod';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { CustomersService } from './customers.service';

@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('customer:read')
  list(@Query(new ZodPipe(listCustomersQuerySchema)) q: z.infer<typeof listCustomersQuerySchema>) {
    return this.customers.list(q);
  }

  @Get(':id')
  @RequirePermission('customer:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(id);
  }

  @Post()
  @RequirePermission('customer:write')
  create(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(createCustomerSchema)) body: CreateCustomerInput,
  ) {
    return this.customers.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('customer:write')
  update(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateCustomerSchema)) body: UpdateCustomerInput,
  ) {
    return this.customers.update(ctx, id, body);
  }

  @Post(':id/identities')
  @RequirePermission('customer:write')
  addIdentity(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(identityInputSchema)) body: IdentityInput,
  ) {
    return this.customers.addIdentity(ctx, id, body);
  }

  /** Look up a customer by channel identity, creating one if unknown. */
  @Post('resolve')
  @RequirePermission('customer:write')
  async resolve(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(resolveCustomerSchema)) body: ResolveCustomerInput,
  ) {
    const { customer, created } = await this.customers.resolveOrCreate(ctx, body);
    return { customer, created };
  }

  @Post('merge')
  @RequirePermission('customer:merge')
  merge(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(mergeCustomersSchema)) body: z.infer<typeof mergeCustomersSchema>,
  ) {
    return this.customers.merge(ctx, body.sourceId, body.targetId);
  }
}
