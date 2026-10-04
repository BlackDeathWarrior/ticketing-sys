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
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { ZodPipe } from '../common/zod.pipe';
import { IntegrationTicketsService } from './integration-tickets.service';

const IdempotencyKey = () =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Any unique string (8 to 200 characters). A repeat of the call with the same key creates nothing new and answers 200.',
  });

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
  @ApiOperation({ summary: 'Raise a ticket for one of your users' })
  @IdempotencyKey()
  @ZodBody(createIntegrationTicketSchema)
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
  @ApiOperation({ summary: 'List the tickets this integration raised' })
  @ZodQuery(listIntegrationTicketsQuerySchema)
  list(
    @ApiKey() key: ApiKeyContext,
    @Query(new ZodPipe(listIntegrationTicketsQuerySchema)) q: ListIntegrationTicketsQuery,
  ) {
    return this.tickets.list(key, q);
  }

  @Get(':reference')
  @ApiOperation({ summary: 'Read one ticket' })
  get(@ApiKey() key: ApiKeyContext, @Param('reference') reference: string) {
    return this.tickets.get(key, reference);
  }

  /** Poll with `after` set to the newest `createdAt` already seen. */
  @Get(':reference/messages')
  @ApiOperation({ summary: 'Read what the customer wrote and was sent' })
  @ZodQuery(integrationMessagesQuerySchema)
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
  @ApiOperation({ summary: "Add the customer's follow-up" })
  @IdempotencyKey()
  @ZodBody(integrationMessageSchema)
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
  @ApiOperation({ summary: "Pass on the customer's rating of a solved ticket" })
  @ZodBody(csatSubmitSchema)
  rate(
    @ApiKey() key: ApiKeyContext,
    @Param('reference') reference: string,
    @Body(new ZodPipe(csatSubmitSchema)) body: CsatSubmit,
  ) {
    return this.tickets.rate(key, reference, body);
  }
}
