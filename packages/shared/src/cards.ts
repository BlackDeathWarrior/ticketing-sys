import { z } from 'zod';

/** A WhatsApp carousel holds at most ten cards. */
export const MAX_CARDS = 10;
/** The longest message text Meta accepts with a carousel. */
export const WA_CAROUSEL_BODY_MAX = 1024;
/** The longest body Meta accepts on one card of a carousel. */
export const WA_CARD_BODY_MAX = 160;
/** The labels of the two buttons every card carries. */
export const CARD_LIKE = 'I like this';
export const CARD_VIEW = 'View product';

/** A tool's result is cut to this many cards before the AI sees them. */
const TOOL_CARDS_MAX = 20;

/** Cards carry pictures and links from an outside app: only secure addresses pass. */
const httpsUrl = z
  .string()
  .max(1000)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be an https address');

/** One item a company tool offers to show, and what a message carries once it is shown. */
export const messageCardSchema = z.object({
  /** The app's own id. It ends up inside a button id (256 characters at most there). */
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(80),
  text: z.string().trim().max(200).optional(),
  imageUrl: httpsUrl,
  url: httpsUrl.optional(),
});
export type MessageCard = z.output<typeof messageCardSchema>;

/**
 * The cards a company tool returned in `result.cards`. The result is whatever
 * the outside app sent, so this never throws: an entry that is not a valid card
 * is dropped, a repeated id keeps its first card, and at most 20 are returned.
 */
export function cardsFromToolResult(result: unknown): MessageCard[] {
  if (typeof result !== 'object' || result === null) return [];
  const list = (result as { cards?: unknown }).cards;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const cards: MessageCard[] = [];
  for (const entry of list) {
    const parsed = messageCardSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    cards.push(parsed.data);
    if (cards.length === TOOL_CARDS_MAX) break;
  }
  return cards;
}

const BUTTON_PREFIX = 'card:';

/** The id of a card's button; it comes back to us when the customer taps it. */
export const cardButtonId = (kind: 'like' | 'view', cardId: string) =>
  `${BUTTON_PREFIX}${kind}:${cardId}`;

/** Reads a button id made by `cardButtonId`; null for any other id. The card id may hold colons. */
export function parseCardButtonId(id: string): { kind: 'like' | 'view'; cardId: string } | null {
  for (const kind of ['like', 'view'] as const) {
    const prefix = `${BUTTON_PREFIX}${kind}:`;
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return { kind, cardId: id.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * The text under a card's picture: the title in bold (WhatsApp shows `*text*` bold),
 * then the card's text, cut to what Meta allows. A cut ends the text with "…"; the
 * title's closing asterisk is never the part that goes.
 */
export function cardBody(card: MessageCard): string {
  const head = `*${card.title}*`;
  // Meta allows two line breaks in a card's body and the title line takes one: the text has none.
  const text = card.text?.replace(/\s+/g, ' ').trim();
  if (!text) return head;
  const body = `${head}\n${text}`;
  if (body.length <= WA_CARD_BODY_MAX) return body;
  // What is left for the text after the title and the line break; a title is at most 80 long.
  const room = WA_CARD_BODY_MAX - head.length - 1;
  let cut = text.slice(0, room - 1);
  // Do not leave half of an emoji behind.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${head}\n${cut.trimEnd()}…`;
}

/**
 * A reply whose cards cannot be shown, as plain text: the reply, a blank line, then one
 * line per card (title, its text, its link). The AI keeps its message short because the
 * cards carry the items, so without them the customer would get no items at all. The
 * items that do not fit in `max` characters are left off from the end; the reply is never cut.
 */
export function cardsAsText(body: string, cards: MessageCard[], max: number): string {
  const one = (v: string) => v.replace(/\s+/g, ' ').trim();
  const lines = cards
    .slice(0, MAX_CARDS)
    .map(
      (c) =>
        `${one(c.title)}${c.text && one(c.text) ? ` - ${one(c.text)}` : ''}${c.url ? ` - ${c.url}` : ''}`,
    );
  while (lines.length) {
    const text = `${body}\n\n${lines.join('\n')}`;
    if (text.length <= max) return text;
    lines.pop();
  }
  return body;
}
