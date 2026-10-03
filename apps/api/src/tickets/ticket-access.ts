import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { canActOnTeam } from '@tms/shared';
import type { FastifyRequest } from 'fastify';
import { ConversationsService } from '../conversations/conversations.service';
import { TicketsService } from './tickets.service';

/** Where the route's parameter points: the ticket itself, one of its conversations, or a message. */
type From = 'ticket' | 'conversation' | 'message';
const ACTS_ON = 'tms:acts-on-ticket';

/**
 * Marks a route that changes a ticket or speaks for the team on it (ADR
 * 0031). Everyone with `ticket:read` sees every ticket, and anyone may add
 * an internal note; but replying, changing, assigning, taking over and
 * handing over are for the ticket's own team (and super admins). A ticket
 * with no team yet is shared triage that anyone may work.
 */
export const ActsOnTicket = (from: From = 'ticket', param = 'id') =>
  applyDecorators(SetMetadata(ACTS_ON, { from, param }), UseGuards(TicketTeamGuard));

@Injectable()
export class TicketTeamGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.get<{ from: From; param: string } | undefined>(
      ACTS_ON,
      context.getHandler(),
    );
    if (!spec) return true;
    const req = context
      .switchToHttp()
      .getRequest<FastifyRequest & { params?: Record<string, string> }>();
    // Staff routes only: an API key or a customer never reaches one.
    const user = req.user;
    const raw = req.params?.[spec.param];
    if (!user || !raw) return true;

    const tickets = this.moduleRef.get(TicketsService, { strict: false });
    let ticketRef = raw;
    if (spec.from !== 'ticket') {
      const conversations = this.moduleRef.get(ConversationsService, { strict: false });
      ticketRef =
        spec.from === 'message'
          ? (await conversations.getMessage(raw)).ticketId
          : (await conversations.get(raw)).ticketId;
    }
    const ticket = await tickets.get(ticketRef).catch(() => null);
    // Unknown: the route answers 404 itself.
    if (!ticket) return true;
    if (canActOnTeam(user, ticket.team?.id ?? null)) return true;
    throw new ForbiddenException({
      message: `This ticket belongs to the ${ticket.team?.name ?? 'other'} team. You can read it and add internal notes; only that team can act on it.`,
      code: 'other_team',
      team: ticket.team,
    });
  }
}
