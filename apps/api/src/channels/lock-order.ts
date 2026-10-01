import type { DbOrTx } from '@tms/db';
import type { Conversation, ConversationsService } from '../conversations/conversations.service';
import type { TicketsService } from '../tickets/tickets.service';

/**
 * Locks a conversation for a change, taking its ticket's lock first.
 *
 * Every path that changes both rows must lock them in this order: the ticket,
 * then the conversation. The inbound pipeline does, so a customer's message
 * and an agent's (or the AI's) reply arriving at the same moment queue up
 * behind each other. Locked the other way round they deadlock, and Postgres
 * ends one of the two transactions: a lost message.
 */
export async function lockTicketThenConversation(
  tx: DbOrTx,
  tickets: Pick<TicketsService, 'lockRow'>,
  conversations: Pick<ConversationsService, 'get' | 'lock'>,
  conversationId: string,
): Promise<Conversation> {
  // A conversation never moves to another ticket, so this read needs no lock.
  const { ticketId } = await conversations.get(conversationId);
  await tickets.lockRow(tx, ticketId);
  return conversations.lock(tx, conversationId);
}
