import type { AiChannelMode } from '@tms/shared';

/**
 * "Is the assistant answering now?": the one definition behind every signal a
 * customer gets that a reply is being written (the chat widget's dots, an
 * app's request page, the portal, WhatsApp's "typing…").
 *
 * True when the AI holds the conversation, the customer wrote last, and what
 * the AI writes is sent by itself. In draft mode a person reads the answer
 * first, so nobody is typing yet: the customer gets the holding message.
 */
export function aiIsAnswering(f: {
  /** The conversation's controller or the ticket's handling: both say `ai` while the AI holds it. */
  heldBy: string;
  /** The AI's mode on the channel the customer wrote on. */
  mode: AiChannelMode;
  customerWroteLast: boolean;
  /**
   * The ticket is resolved or closed. Left out by callers that have just taken
   * a customer message in: that message reopened the ticket.
   */
  settled?: boolean;
}): boolean {
  return f.heldBy === 'ai' && f.mode === 'auto' && f.customerWroteLast && !f.settled;
}
