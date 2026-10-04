/**
 * How the outcome of an approval reaches a customer who asked for the action on a phone
 * call: they are rung back (ADR 0040). Provided by the worker, which places calls; absent
 * where no calls are placed, and then the outcome is left as a note.
 */
export const APPROVAL_CALL_BACK = Symbol('APPROVAL_CALL_BACK');

export interface ApprovalCallBack {
  /**
   * Rings the ticket's customer with `said`, if the conversation is a phone call's. Null
   * when it is not one; otherwise whether a call was asked for, and if not, why not.
   */
  ring(i: {
    ticketId: string;
    conversationId: string;
    said: string;
  }): Promise<{ asked: true } | { asked: false; why: string } | null>;
}
