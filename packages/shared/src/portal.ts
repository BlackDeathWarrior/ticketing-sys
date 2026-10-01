import { z } from 'zod';
import type { CsatView } from './csat';
import type { Channel, StatusCategory } from './tickets';

/**
 * The customer portal ("My requests" in the help center, ADR 0019). A
 * customer proves they own an email address by opening a one-time link sent
 * to it, and can then see and answer their own tickets, whatever channel
 * they came in on.
 */

/** The sign-in link works once, for this long. */
export const PORTAL_LINK_MINUTES = 15;
/** How long a customer stays signed in. */
export const PORTAL_SESSION_MINUTES = 60;
/** Sign-in links one address can ask for in 15 minutes. */
export const PORTAL_LINKS_PER_ADDRESS = 5;

export const portalSignInSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
});

export const portalSessionSchema = z.object({ token: z.string().min(10).max(500) });

export const portalReplySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Write a message')
    .max(5000, 'Keep the message under 5,000 characters'),
});

export interface PortalSession {
  token: string;
  /** Seconds until the session ends. */
  expiresIn: number;
  customer: { name: string; email: string };
}

/** What customers call each status category. */
export const PORTAL_STATUS_LABELS: Record<StatusCategory, string> = {
  open: 'Open',
  pending: 'On hold',
  resolved: 'Solved',
  closed: 'Closed',
};

export interface PortalTicketSummary {
  reference: string;
  subject: string;
  channel: Channel;
  status: StatusCategory;
  createdAt: string;
  updatedAt: string;
  /** The customer's rating, once given. */
  rating: number | null;
}

export interface PortalMessage {
  id: string;
  from: 'you' | 'support' | 'assistant';
  /** An agent's first name; never a full name. */
  name: string | null;
  body: string;
  channel: Channel;
  createdAt: string;
  attachments: Array<{ index: number; filename: string; contentType: string; size: number }>;
}

export interface PortalTicketDetail extends Omit<PortalTicketSummary, 'rating'> {
  messages: PortalMessage[];
  /** Closed tickets can't be answered; the customer opens a new request instead. */
  canReply: boolean;
  /** Resolved or closed within the rating window. */
  canRate: boolean;
  rating: CsatView | null;
}
