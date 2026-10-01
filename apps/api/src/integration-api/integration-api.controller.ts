import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CreateIntegrationTicketInput,
  createIntegrationTicketSchema,
  type CsatSubmit,
  csatSubmitSchema,
  idempotencyKeySchema,
  type IntegrationMessageInput,
  integrationMessageSchema,
  integrationMessagesQuerySchema,
  type ListIntegrationTicketsQuery,
  listIntegrationTicketsQuerySchema,
} from '@tms/shared';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import {
  ApiKey,
  ApiKeyAuth,
  type ApiKeyContext,
  RequirePermission,
} from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { IntegrationTicketsService } from './integration-tickets.service';

/** The `Idempotency-Key` header, when one was sent. */
function idempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException(`Idempotency-Key: ${parsed.error.issues[0]!.message}`);
  }
  return parsed.data;
}

/**
 * The integration API for tickets (ADR 0023). An app calls it with its API
 * key; `:reference` is the ticket reference the create call returned.
 */
@ApiTags('integration API')
@ApiBearerAuth('apiKey')
@ApiKeyAuth()
@RequirePermission('integration:ticket')
@Controller('integration/tickets')
export class IntegrationApiController {
  constructor(private readonly tickets: IntegrationTicketsService) {}

  /** 201 for a new ticket; 200 when the `Idempotency-Key` was seen before. */
  @Post()
  async create(
    @ApiKey() key: ApiKeyContext,
    @Body(new ZodPipe(createIntegrationTicketSchema)) body: CreateIntegrationTicketInput,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const { ticket, created } = await this.tickets.create(key, body, idempotencyKey(rawKey));
    void res.status(created ? 201 : 200);
    return ticket;
  }

  @Get()
  list(
    @ApiKey() key: ApiKeyContext,
    @Query(new ZodPipe(listIntegrationTicketsQuerySchema)) q: ListIntegrationTicketsQuery,
  ) {
    return this.tickets.list(key, q);
  }

  @Get(':reference')
  get(@ApiKey() key: ApiKeyContext, @Param('reference') reference: string) {
    return this.tickets.get(key, reference);
  }

  /** Poll with `after` set to the newest `createdAt` already seen. */
  @Get(':reference/messages')
  messages(
    @ApiKey() key: ApiKeyContext,
    @Param('reference') reference: string,
    @Query(new ZodPipe(integrationMessagesQuerySchema))
    q: z.output<typeof integrationMessagesQuerySchema>,
  ) {
    return this.tickets.messages(key, reference, q.after);
  }

  /** A follow-up the customer wrote in the app. */
  @Post(':reference/messages')
  async addMessage(
    @ApiKey() key: ApiKeyContext,
    @Param('reference') reference: string,
    @Body(new ZodPipe(integrationMessageSchema)) body: IntegrationMessageInput,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const { message, created } = await this.tickets.addMessage(
      key,
      reference,
      body.body,
      idempotencyKey(rawKey),
    );
    void res.status(created ? 201 : 200);
    return message;
  }

  /** The customer's rating of a resolved ticket, given in the app. */
  @Post(':reference/rating')
  @HttpCode(200)
  rate(
    @ApiKey() key: ApiKeyContext,
    @Param('reference') reference: string,
    @Body(new ZodPipe(csatSubmitSchema)) body: CsatSubmit,
  ) {
    return this.tickets.rate(key, reference, body);
  }
}
