import {
  Body,
  type CanActivate,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CsatSubmit,
  csatSubmitSchema,
  portalReplySchema,
  portalSessionSchema,
  portalSignInSchema,
} from '@tms/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { RateLimit } from '../common/rate-limit';
import { Ctx, Public, type RequestCtx } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { type PortalCustomer, PortalService } from './portal.service';

declare module 'fastify' {
  interface FastifyRequest {
    portalCustomer?: PortalCustomer;
  }
}

/**
 * Lets a request through only with a portal session token. The routes it
 * protects are `@Public()` for the staff guard: customers are not users, and
 * a staff token is refused here just as a portal token is refused there.
 */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(private readonly portal: PortalService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const customer = token ? await this.portal.verifySession(token) : null;
    if (!customer) throw new UnauthorizedException('Sign in to see your requests');
    await this.portal.assertEnabled();
    req.portalCustomer = customer;
    return true;
  }
}

const Customer = createParamDecorator(
  (_: unknown, context: ExecutionContext): PortalCustomer =>
    context.switchToHttp().getRequest<FastifyRequest>().portalCustomer!,
);

/** Signing in: ask for a link, then trade the link's token for a session. */
@ApiTags('portal')
@Public()
@Controller('public/portal')
export class PortalSignInController {
  constructor(private readonly portal: PortalService) {}

  @RateLimit({ name: 'portal-sign-in', limit: 20, windowSeconds: 60 })
  @Post('sign-in')
  @HttpCode(202)
  async signIn(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(portalSignInSchema)) body: z.infer<typeof portalSignInSchema>,
  ) {
    await this.portal.requestLink(body.email, ctx);
    // The same answer for every address, known or not.
    return { ok: true };
  }

  @RateLimit({ name: 'portal-session', limit: 30, windowSeconds: 60 })
  @Post('session')
  @HttpCode(200)
  session(@Body(new ZodPipe(portalSessionSchema)) body: z.infer<typeof portalSessionSchema>) {
    return this.portal.openSession(body.token);
  }
}

/** A signed-in customer's own tickets. Nothing here takes a customer id from the request. */
@ApiTags('portal')
@Public()
@RateLimit({ name: 'portal', limit: 240, windowSeconds: 60 })
@UseGuards(PortalGuard)
@Controller('portal')
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('me')
  me(@Customer() who: PortalCustomer) {
    return this.portal.me(who);
  }

  @Get('tickets')
  list(@Customer() who: PortalCustomer) {
    return this.portal.list(who);
  }

  @Get('tickets/:reference')
  detail(@Customer() who: PortalCustomer, @Param('reference') reference: string) {
    return this.portal.detail(who, reference);
  }

  @Post('tickets/:reference/reply')
  @HttpCode(200)
  reply(
    @Customer() who: PortalCustomer,
    @Param('reference') reference: string,
    @Body(new ZodPipe(portalReplySchema)) body: z.infer<typeof portalReplySchema>,
  ) {
    return this.portal.reply(who, reference, body.body);
  }

  @Post('tickets/:reference/rating')
  @HttpCode(200)
  rate(
    @Customer() who: PortalCustomer,
    @Param('reference') reference: string,
    @Body(new ZodPipe(csatSubmitSchema)) body: CsatSubmit,
  ) {
    return this.portal.rate(who, reference, body);
  }

  @Get('tickets/:reference/messages/:messageId/attachments/:index')
  async attachment(
    @Customer() who: PortalCustomer,
    @Param('reference') reference: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Param('index', ParseIntPipe) index: number,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const { file, stream } = await this.portal.attachment(who, reference, messageId, index);
    void res.header('content-type', file.contentType);
    void res.header(
      'content-disposition',
      `attachment; filename="${encodeURIComponent(file.filename)}"`,
    );
    return new StreamableFile(stream);
  }
}
