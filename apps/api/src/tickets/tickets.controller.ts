import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  addNoteSchema,
  type AssignTicketInput,
  assignTicketSchema,
  type CreateTicketInput,
  createTicketSchema,
  type ListTicketsQuery,
  listTicketsQuerySchema,
  type TransitionTicketInput,
  transitionTicketSchema,
  type UpdateTicketInput,
  updateTicketSchema,
} from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { TicketsService } from './tickets.service';

@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @RequirePermission('ticket:read')
  list(@Ctx() ctx: RequestCtx, @Query(new ZodPipe(listTicketsQuerySchema)) q: ListTicketsQuery) {
    return this.tickets.list(q, ctx);
  }

  /** `ref` is a ticket UUID or a reference like TMS-1042. */
  @Get(':ref')
  @RequirePermission('ticket:read')
  get(@Param('ref') ref: string) {
    return this.tickets.get(ref);
  }

  @Post()
  @RequirePermission('ticket:create')
  create(@Ctx() ctx: RequestCtx, @Body(new ZodPipe(createTicketSchema)) body: CreateTicketInput) {
    return this.tickets.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('ticket:update')
  update(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateTicketSchema)) body: UpdateTicketInput,
  ) {
    return this.tickets.update(ctx, id, body);
  }

  @Post(':id/transition')
  @RequirePermission('ticket:transition')
  transition(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(transitionTicketSchema)) body: TransitionTicketInput,
  ) {
    return this.tickets.transition(ctx, id, body);
  }

  @Post(':id/assign')
  @RequirePermission('ticket:assign')
  assign(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(assignTicketSchema)) body: AssignTicketInput,
  ) {
    return this.tickets.assign(ctx, id, body);
  }

  @Get(':id/notes')
  @RequirePermission('ticket:read')
  notes(@Param('id', ParseUUIDPipe) id: string) {
    return this.tickets.notes(id);
  }

  @Post(':id/notes')
  @RequirePermission('ticket:note')
  addNote(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(addNoteSchema)) body: { body: string },
  ) {
    return this.tickets.addNote(ctx, id, body.body);
  }

  @Get(':id/history')
  @RequirePermission('ticket:read')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.tickets.history(id);
  }
}
