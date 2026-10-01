import type { PortalMessage, PortalSession } from '@tms/shared';

/** The help center's pages, addressed by the URL hash so emailed links open the right one. */
export type Route =
  | { page: 'home' }
  | { page: 'portal' }
  | { page: 'verify'; token: string }
  | { page: 'ticket'; reference: string }
  | { page: 'rate'; token: string };

export function parseRoute(hash: string): Route {
  const [first, second, ...rest] = hash.replace(/^#\/?/, '').split('/');
  const third = rest.join('/');
  if (first === 'rate' && second)
    return { page: 'rate', token: [second, third].filter(Boolean).join('/') };
  if (first === 'portal') {
    if (second === 'verify' && third) return { page: 'verify', token: third };
    if (second === 'tickets' && third)
      return { page: 'ticket', reference: decodeURIComponent(third) };
    return { page: 'portal' };
  }
  return { page: 'home' };
}

export const hrefFor = (route: Route): string => {
  switch (route.page) {
    case 'portal':
      return '#/portal';
    case 'verify':
      return `#/portal/verify/${route.token}`;
    case 'ticket':
      return `#/portal/tickets/${encodeURIComponent(route.reference)}`;
    case 'rate':
      return `#/rate/${route.token}`;
    default:
      return '#/';
  }
};

const STORAGE_KEY = 'tms.portal';

interface Stored {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  name: string;
  email: string;
}

/** The signed-in customer, kept for this browser tab only. */
export function readSession(storage: Pick<Storage, 'getItem'>, now = Date.now()): Stored | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const s = raw ? (JSON.parse(raw) as Stored) : null;
    return s && typeof s.token === 'string' && s.expiresAt > now ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  session: PortalSession | null,
  now = Date.now(),
): void {
  try {
    if (!session) return storage.removeItem(STORAGE_KEY);
    const stored: Stored = {
      token: session.token,
      expiresAt: now + session.expiresIn * 1000,
      name: session.customer.name,
      email: session.customer.email,
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage unavailable: the session lasts until the page is closed.
  }
}

/** "1 Oct 2026, 14:05" in the reader's own time zone. */
export function dateTime(iso: string, locale?: string): string {
  return new Date(iso).toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Who a message is from, in the customer's words. */
export function authorLabel(m: Pick<PortalMessage, 'from' | 'name'>): string {
  if (m.from === 'you') return 'You';
  if (m.from === 'assistant') return 'AI assistant';
  return m.name ? `${m.name} from Support` : 'Support';
}

export const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  web_form: 'Request form',
  webchat: 'Chat',
  whatsapp: 'WhatsApp',
  voice: 'Phone call',
  agent: 'Opened by our team',
};
