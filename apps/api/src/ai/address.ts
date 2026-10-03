import { CUSTOMER_TITLES, type CustomerTitle } from '@tms/shared';

/**
 * How the AI may address a customer by name. Pure.
 *
 * A title ("Mr.", "Ms.") is only ever one the customer chose in an app that
 * knows them: it is never worked out from a name. Without one the first name
 * is used alone.
 */
export interface Address {
  /** The forms that are fine to use, the most formal last: "Ms. Asha", "Ms. Asha Verma", "Ms. Verma". */
  forms: string[];
  /** The one a fixed message uses. */
  short: string;
  /** The forms carry a title the customer chose. */
  titled: boolean;
}

/** The customer's title as stored on their record (`attributes.title`), when it is one we know. */
export function titleOf(
  attributes: Record<string, unknown> | null | undefined,
): CustomerTitle | null {
  const title = attributes?.title;
  return (CUSTOMER_TITLES as readonly unknown[]).includes(title) ? (title as CustomerTitle) : null;
}

/**
 * The ways to address a person called `name`, or null when the name on file is
 * not a person's name (an email address, a phone number, "Customer 42").
 */
export function addressOf(name: string, title: string | null): Address | null {
  const words = name.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (
    !words.length ||
    name.length > 60 ||
    /[@\d<>{}[\]]/.test(name) ||
    /^customer\b/i.test(name) ||
    !/\p{L}/u.test(name)
  ) {
    return null;
  }
  const first = words[0]!;
  const last = words.length > 1 ? words.at(-1)! : null;
  if (!title) return { forms: [first], short: first, titled: false };
  const forms = last
    ? [`${title} ${first}`, `${title} ${first} ${last}`, `${title} ${last}`]
    : [`${title} ${first}`];
  return { forms, short: forms.at(-1)!, titled: true };
}
