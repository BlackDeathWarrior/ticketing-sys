import { z } from 'zod';
import type { MessageCard } from './cards';
import {
  channelSchema,
  externalRefSchema,
  prioritySchema,
  ticketMetadataSchema,
  ticketTagSchema,
} from './tickets';
import { identityTypeSchema } from './customers';
import { sendTemplateSchema } from './whatsapp';

/**
 * Every channel adapter turns its native payload into this envelope. The
 * orchestrator only ever sees envelopes, so adding a channel means adding an
 * adapter, not touching ticket logic.
 */
export const attachmentRefSchema = z.object({
  key: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

export const messageEnvelopeSchema = z.object({
  channel: channelSchema,
  /**
   * Channel-side conversation key: chat session id, WhatsApp number, or the
   * email Message-ID that started the thread.
   */
  threadKey: z.string().min(1).max(500),
  /** Provider message id. Unique per channel; retries with the same id are ignored. */
  channelMessageId: z.string().min(1).max(500),
  from: z.object({
    identity: z.object({ type: identityTypeSchema, value: z.string().min(1) }),
    displayName: z.string().max(200).optional(),
    /** Verified identities link to an existing customer; unverified ones only attach if unowned. */
    extraIdentities: z
      .array(
        z.object({ type: identityTypeSchema, value: z.string().min(1), verified: z.boolean() }),
      )
      .default([]),
  }),
  subject: z.string().max(500).optional(),
  text: z.string().max(100_000),
  attachments: z.array(attachmentRefSchema).default([]),
  /** Email only: Message-IDs from In-Reply-To and References, for threading. */
  references: z.array(z.string()).default([]),
  receivedAt: z.string().datetime(),
  metadata: z.record(z.unknown()).default({}),
  /**
   * `id`: the ticket this message belongs to, set only by an adapter that has
   * already checked the sender owns it (the portal, the integration API). The
   * rest is applied only when this message opens a new ticket: `categoryId` is
   * what the customer chose; priority, tags, `externalRef`, `metadata` and
   * `integrationId` come from the integration that raised it.
   */
  ticket: z
    .object({
      categoryId: z.string().uuid().optional(),
      id: z.string().uuid().optional(),
      priority: prioritySchema.optional(),
      tags: z.array(ticketTagSchema).max(20).optional(),
      externalRef: externalRefSchema.optional(),
      metadata: ticketMetadataSchema.optional(),
      integrationId: z.string().uuid().optional(),
    })
    .optional(),
  /** `off`: the AI does not take the conversation this message opens, whatever the channel's mode. */
  ai: z.enum(['default', 'off']).default('default'),
});
export type MessageEnvelope = z.input<typeof messageEnvelopeSchema>;
export type ParsedEnvelope = z.output<typeof messageEnvelopeSchema>;

export const CONVERSATION_CONTROLLERS = ['none', 'ai', 'human'] as const;
export type ConversationController = (typeof CONVERSATION_CONTROLLERS)[number];

export const MESSAGE_AUTHORS = ['customer', 'ai', 'agent', 'system'] as const;
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number];

/**
 * `draft`: an AI reply waiting for a human; `discarded`: a draft the human threw away.
 * `delivered` and `read` come from channels that report them (WhatsApp).
 */
export const DELIVERY_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
  'draft',
  'discarded',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// ---- API contracts ----

export const replySchema = z.object({ body: z.string().trim().min(1).max(20_000) });
export type ReplyInput = z.infer<typeof replySchema>;

/** Email starts with free text; WhatsApp must start with an approved template. */
export const startConversationSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('email'), body: z.string().trim().min(1).max(20_000) }),
  z.object({ channel: z.literal('whatsapp'), template: sendTemplateSchema }),
]);
export type StartConversationInput = z.output<typeof startConversationSchema>;

// ---- Realtime (Socket.IO) ----

export const AGENT_NAMESPACE = '/agent';
export const CHAT_NAMESPACE = '/chat';
export const AGENTS_ROOM = 'agents';
export const chatRoom = (sessionId: string) => `chat:${sessionId}`;

/** Pushed to agent consoles; clients refetch what they display. */
export interface AgentEvent {
  type: string;
  ticketId?: string;
  conversationId?: string;
  messageId?: string;
  /** Knowledge-base events. */
  documentId?: string;
}

export const CHAT_CONTEXT_MAX_BYTES = 2048;
/**
 * What the page says the visitor is looking at (a product, an order). It
 * comes from a browser, so it is small, shown as text and never trusted.
 */
export const chatContextSchema = z
  .record(z.unknown())
  .refine((c) => JSON.stringify(c).length <= CHAT_CONTEXT_MAX_BYTES, {
    message: `Context must be at most ${CHAT_CONTEXT_MAX_BYTES} bytes of JSON`,
  });

/** Handshake auth the chat widget sends. */
export const chatHandshakeSchema = z.object({
  /** Session token from a previous connection, to resume the same conversation. */
  token: z.string().optional(),
  /**
   * Signed by the host website for logged-in visitors: with the integration's
   * chat identity secret when `integration` is given, else CHAT_IDENTITY_SECRET.
   */
  identityToken: z.string().optional(),
  /** The integration (its slug) whose site the widget is on (ADR 0026). */
  integration: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,39}$/)
    .optional(),
  context: chatContextSchema.optional(),
  name: z.string().trim().max(200).optional().catch(undefined),
  // What a visitor typed. A mistyped address is left out rather than refusing the whole chat.
  email: z.string().trim().email().optional().catch(undefined),
});

export const chatMessageSchema = z.object({
  text: z.string().trim().min(1).max(5_000),
  /** Generated by the widget so a resend after a dropped ack isn't duplicated. */
  clientMessageId: z.string().min(8).max(100),
  /** A tap on a card's button: which message showed the card, and which card. */
  card: z
    .object({
      messageId: z.string().uuid(),
      id: z.string().min(1).max(100),
      kind: z.enum(['like', 'view']),
    })
    .optional(),
});

export interface ChatMessageView {
  id: string;
  body: string;
  authorType: MessageAuthor;
  authorName?: string | null;
  createdAt: string;
  /** Items shown under the message, each with a picture and its buttons (as on WhatsApp). */
  cards?: MessageCard[];
}
