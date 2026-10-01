import { io, type Socket } from 'socket.io-client';

/**
 * TMS web chat widget. Embed with:
 *   <script src="https://tms.example.com/widget/tms-chat.js"></script>
 *   <script>TMSChat.init({ server: 'https://tms.example.com' })</script>
 *
 * Kept deliberately small and framework-free; it renders inside a shadow
 * root so the host page's CSS can't break it (and it can't break the page).
 */

export interface ChatTheme {
  /** The launcher, the header and the visitor's own messages. Any CSS colour. */
  primary?: string;
  /** Text on the primary colour. */
  onPrimary?: string;
  /** Corner radius of the panel, in pixels. */
  radius?: number;
  /** Which bottom corner the launcher sits in. */
  position?: 'right' | 'left';
}

export interface ChatStrings {
  launcher?: string;
  title?: string;
  /** Shown in an empty conversation. */
  intro?: string;
  placeholder?: string;
  send?: string;
  /** Above the name and email fields. */
  details?: string;
  start?: string;
}

/** What a page can react to. Callbacks never receive the visitor's session token. */
export interface ChatCallbacks {
  open?: () => void;
  close?: () => void;
  /** A message from support (a person or the assistant) arrived. */
  message?: (message: { id: string; body: string; from: 'agent' | 'ai' | 'system' }) => void;
  /** The visitor's message opened a ticket. */
  ticket?: (ticket: { reference: string }) => void;
}

export interface ChatOptions {
  /** TMS base URL. Defaults to where this script was loaded from. */
  server?: string;
  /** The integration this site is (its identifier in Settings → Integrations). */
  integration?: string;
  /** @deprecated Use `strings.title`. */
  title?: string;
  /**
   * HS256 token signed by your server for a logged-in visitor: with the
   * integration's chat identity secret, or CHAT_IDENTITY_SECRET without one.
   */
  identityToken?: string;
  /** Ask anonymous visitors for name and email before the first message. */
  askForDetails?: boolean;
  /** What you already know about the visitor. Unverified: it only saves them typing it. */
  visitor?: { name?: string; email?: string };
  /** What the visitor is looking at (a product, an order): kept on the ticket they open. */
  context?: Record<string, unknown>;
  theme?: ChatTheme;
  strings?: ChatStrings;
  on?: ChatCallbacks;
}

export interface ChatHandle {
  open(): void;
  close(): void;
  /** Replaces the page context; it applies to the next ticket the visitor opens. */
  setContext(context: Record<string, unknown>): void;
  /** The visitor signed in: start a new conversation as them. */
  identify(identityToken: string): void;
  /** Disconnects and removes the widget from the page. */
  destroy(): void;
}

interface ChatMessage {
  id: string;
  body: string;
  authorType: 'customer' | 'agent' | 'ai' | 'system';
  authorName?: string | null;
  createdAt: string;
}

/** Shown when the visitor's ticket is solved; the token goes back with their answer. */
interface RatingPrompt {
  token: string;
  reference: string;
}

type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };

const script = document.currentScript as HTMLScriptElement | null;
const scriptOrigin = script?.src ? new URL(script.src).origin : window.location.origin;

const DEFAULT_STRINGS: Required<ChatStrings> = {
  launcher: 'Chat with us',
  title: 'Chat with us',
  intro: 'Ask us anything. We usually reply within a few minutes.',
  placeholder: 'Type a message…',
  send: 'Send',
  details: 'Tell us who you are so we can follow up. Both are optional.',
  start: 'Start chat',
};

const CSS = `
:host { all: initial; --tms-primary: #1f4e89; --tms-on-primary: #fff; --tms-radius: 12px; }
/* Component rules below set display, which would otherwise override the hidden attribute. */
[hidden] { display: none !important; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; border: 0; border-radius: 24px;
  padding: 12px 18px; background: var(--tms-primary); color: var(--tms-on-primary); font-size: 15px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.2); }
.launcher:focus-visible, button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }
.panel { position: fixed; right: 20px; bottom: 80px; z-index: 2147483000; width: min(360px, calc(100vw - 40px));
  height: min(520px, calc(100vh - 120px)); background: #fff; color: #111; border-radius: var(--tms-radius); display: flex;
  flex-direction: column; box-shadow: 0 8px 30px rgba(0,0,0,.25); overflow: hidden; font-size: 14px; }
:host([data-position="left"]) .launcher, :host([data-position="left"]) .panel { right: auto; left: 20px; }
.panel[hidden] { display: none; }
header { background: var(--tms-primary); color: var(--tms-on-primary); padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; }
header strong { font-size: 15px; }
header button { background: none; border: 0; color: var(--tms-on-primary); font-size: 20px; cursor: pointer; line-height: 1; }
.status { font-size: 12px; padding: 4px 14px; background: #f3f4f6; color: #4b5563; }
.log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 80%; padding: 8px 10px; border-radius: 10px; white-space: pre-wrap; word-wrap: break-word; }
.msg.customer { align-self: flex-end; background: var(--tms-primary); color: var(--tms-on-primary); }
.msg.agent, .msg.ai, .msg.system { align-self: flex-start; background: #f3f4f6; }
.msg small { display: block; font-size: 11px; opacity: .75; margin-bottom: 2px; }
.msg.failed { background: #b91c1c; }
.empty { color: #6b7280; text-align: center; margin: auto; }
form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e5e7eb; }
textarea { flex: 1; resize: none; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; font-size: 14px; }
form button, .details button { border: 0; border-radius: 8px; background: var(--tms-primary); color: var(--tms-on-primary); padding: 0 14px; cursor: pointer; }
form button:disabled { opacity: .5; cursor: default; }
.details { padding: 14px; display: flex; flex-direction: column; gap: 8px; }
.details label { font-size: 13px; color: #374151; }
.details input { border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; font-size: 14px; width: 100%; }
.details button { padding: 10px; }
.rate { align-self: stretch; padding: 10px; border: 1px solid #d1d5db; border-radius: 10px; background: #fff; }
.rate p { margin: 0 0 8px; }
.rate .scale { display: flex; gap: 6px; }
.rate .scale button { flex: 1; min-height: 36px; border: 1px solid var(--tms-primary); border-radius: 8px; background: #fff; color: var(--tms-primary);
  font-size: 15px; cursor: pointer; }
.rate .scale button:hover { background: #f3f4f6; }
.rate .ends { display: flex; justify-content: space-between; font-size: 11px; color: #6b7280; margin-top: 4px; }
`;

export function init(options: ChatOptions = {}): ChatHandle {
  const server = (options.server ?? scriptOrigin).replace(/\/$/, '');
  // One conversation per site: two integrations on one TMS don't share a session.
  const storageKey = `tms-chat:${server}${options.integration ? `:${options.integration}` : ''}`;
  const stored = readStore(storageKey);
  const text = { ...DEFAULT_STRINGS, ...(options.title ? { title: options.title } : {}) };
  for (const [k, v] of Object.entries(options.strings ?? {})) {
    if (typeof v === 'string' && v.trim()) text[k as keyof ChatStrings] = v;
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  applyTheme(host, options.theme);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${CSS}</style>
    <button class="launcher" type="button" aria-expanded="false" aria-controls="tms-panel">${escapeHtml(text.launcher)}</button>
    <section class="panel" id="tms-panel" role="dialog" aria-label="${escapeHtml(options.title ?? options.strings?.title ?? 'Chat')}" hidden>
      <header><strong>${escapeHtml(text.title)}</strong>
        <button type="button" class="close" aria-label="Close chat">×</button></header>
      <div class="status" aria-live="polite" hidden></div>
      <div class="details" hidden>
        <p>${escapeHtml(text.details)}</p>
        <label for="tms-name">Name</label><input id="tms-name" autocomplete="name" />
        <label for="tms-email">Email</label><input id="tms-email" type="email" autocomplete="email" />
        <button type="button" class="start">${escapeHtml(text.start)}</button>
      </div>
      <div class="log" aria-live="polite"><p class="empty">${escapeHtml(text.intro)}</p></div>
      <form><textarea rows="2" aria-label="Message" placeholder="${escapeHtml(text.placeholder)}" maxlength="5000"></textarea>
        <button type="submit">${escapeHtml(text.send)}</button></form>
    </section>`;

  const $ = <T extends Element>(sel: string) => root.querySelector(sel) as T;
  const launcher = $<HTMLButtonElement>('.launcher');
  const panel = $<HTMLElement>('.panel');
  const status = $<HTMLElement>('.status');
  const log = $<HTMLElement>('.log');
  const details = $<HTMLElement>('.details');
  const form = $<HTMLFormElement>('form');
  const input = $<HTMLTextAreaElement>('textarea');
  const sendBtn = $<HTMLButtonElement>('form button');

  let socket: Socket | null = null;
  let token = stored.token;
  let identityToken = options.identityToken;
  let context = options.context;
  let visitor = {
    name: stored.name ?? options.visitor?.name,
    email: stored.email ?? options.visitor?.email,
  };
  const seen = new Set<string>();
  const asked = new Set<string>();

  /** A page's callback must never break the chat. */
  function notify<K extends keyof ChatCallbacks>(
    event: K,
    ...args: Parameters<NonNullable<ChatCallbacks[K]>>
  ) {
    try {
      (options.on?.[event] as ((...a: unknown[]) => void) | undefined)?.(...args);
    } catch {
      // The page's problem, not the visitor's.
    }
  }

  // The site already knows who this is (even unverified): no need to ask again.
  const needsDetails = () =>
    options.askForDetails !== false &&
    !token &&
    !identityToken &&
    !options.visitor?.name &&
    !options.visitor?.email;

  function open() {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    if (needsDetails()) {
      details.hidden = false;
      form.hidden = true;
      $<HTMLInputElement>('#tms-name').focus();
    } else {
      connect();
      input.focus();
    }
    notify('open');
  }

  function close() {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
    notify('close');
  }

  function connect() {
    if (socket) return;
    status.hidden = false;
    status.textContent = 'Connecting…';
    // Nothing can be sent until the connection is up; setStatus enables it again.
    sendBtn.disabled = true;
    socket = io(`${server}/chat`, {
      transports: ['websocket', 'polling'],
      auth: (cb) =>
        cb({
          token,
          identityToken,
          integration: options.integration,
          context,
          name: visitor.name,
          email: visitor.email,
        }),
    });
    socket.on('connect', () => setStatus('Connected'));
    socket.on('disconnect', () => setStatus('Reconnecting…'));
    socket.on('connect_error', () => setStatus('Cannot reach support right now. Retrying…'));
    // The server refused the handshake (an unknown integration, too many chats).
    socket.on('error', (e: { message?: string }) => {
      if (e?.message) setStatus(e.message);
    });
    socket.on('session', async (s: { token: string }) => {
      token = s.token;
      writeStore(storageKey, { token, ...visitor });
      const res = (await socket!.emitWithAck('history')) as Ack<{
        messages: ChatMessage[];
        rate?: RatingPrompt | null;
      }>;
      if (!res.ok) return;
      res.messages.forEach((m) => render(m));
      // A rating we asked for while the visitor was away.
      if (res.rate) askForRating(res.rate);
    });
    socket.on('message', (m: ChatMessage) => {
      if (render(m) && m.authorType !== 'customer') {
        notify('message', { id: m.id, body: m.body, from: m.authorType });
      }
    });
    socket.on('rate', (p: RatingPrompt) => askForRating(p));
  }

  /** "How did we do?": five buttons in the conversation, asked once per solved ticket. */
  function askForRating(prompt: RatingPrompt) {
    if (asked.has(prompt.reference)) return;
    asked.add(prompt.reference);
    log.querySelector('.empty')?.remove();
    const box = document.createElement('div');
    box.className = 'rate';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Rate our support');
    const question = document.createElement('p');
    question.textContent = `Your request ${prompt.reference} is solved. How did we do?`;
    const scale = document.createElement('div');
    scale.className = 'scale';
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = String(n);
      b.setAttribute('aria-label', `${n} out of 5`);
      b.addEventListener('click', () => void rate(prompt, n, box, question));
      scale.appendChild(b);
    }
    const ends = document.createElement('div');
    ends.className = 'ends';
    ends.innerHTML = '<span>Very unhappy</span><span>Very happy</span>';
    box.append(question, scale, ends);
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  }

  async function rate(prompt: RatingPrompt, rating: number, box: HTMLElement, label: HTMLElement) {
    try {
      const res = (await socket!
        .timeout(10_000)
        .emitWithAck('rate', { token: prompt.token, rating })) as Ack<{ rating: number }>;
      if (!res.ok) throw new Error(res.error);
      box.replaceChildren(label);
      label.textContent = `Thanks for your rating: ${res.rating} out of 5.`;
      box.setAttribute('role', 'status');
    } catch (err) {
      label.textContent = `Your rating was not saved: ${err instanceof Error ? err.message : 'please try again'}`;
    }
  }

  function setStatus(message: string) {
    status.textContent = message;
    sendBtn.disabled = !socket?.connected;
  }

  function render(m: ChatMessage, pending = false): HTMLElement | null {
    if (seen.has(m.id)) return null;
    seen.add(m.id);
    log.querySelector('.empty')?.remove();
    const el = document.createElement('div');
    el.className = `msg ${m.authorType}`;
    if (m.authorType !== 'customer') {
      const who = document.createElement('small');
      who.textContent = m.authorName ?? 'Support';
      el.appendChild(who);
    }
    el.appendChild(document.createTextNode(m.body));
    if (pending) el.style.opacity = '0.6';
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  async function send(body: string) {
    const clientMessageId = crypto.randomUUID();
    const bubble = render(
      {
        id: clientMessageId,
        body,
        authorType: 'customer',
        createdAt: new Date().toISOString(),
      },
      true,
    );
    try {
      const res = (await socket!
        .timeout(10_000)
        .emitWithAck('message', { text: body, clientMessageId })) as Ack<{
        message: ChatMessage;
        ticket?: { reference: string; created: boolean };
      }>;
      if (!res.ok) throw new Error(res.error);
      seen.add(res.message.id);
      if (bubble) bubble.style.opacity = '1';
      if (res.ticket?.created) notify('ticket', { reference: res.ticket.reference });
    } catch (err) {
      if (bubble) {
        bubble.classList.add('failed');
        bubble.title = err instanceof Error ? err.message : 'Not sent';
        bubble.style.opacity = '1';
      }
      setStatus(`Message not sent: ${err instanceof Error ? err.message : 'try again'}`);
    }
  }

  function disconnect() {
    socket?.removeAllListeners();
    socket?.disconnect();
    socket = null;
  }

  launcher.addEventListener('click', () => (panel.hidden ? open() : close()));
  $<HTMLButtonElement>('.close').addEventListener('click', close);
  root.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !panel.hidden) close();
  });
  $<HTMLButtonElement>('.start').addEventListener('click', () => {
    visitor = {
      name: $<HTMLInputElement>('#tms-name').value.trim() || undefined,
      email: $<HTMLInputElement>('#tms-email').value.trim() || undefined,
    };
    details.hidden = true;
    form.hidden = false;
    connect();
    input.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body || !socket?.connected) return;
    input.value = '';
    void send(body);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Returning visitors reconnect straight away so replies arrive while the panel is closed.
  if (token) connect();

  return {
    open,
    close,
    setContext(next) {
      context = next;
      if (socket?.connected) socket.emit('context', next);
    },
    identify(nextToken) {
      identityToken = nextToken;
      // A new conversation as the signed-in person; the anonymous one stays in the helpdesk.
      token = undefined;
      writeStore(storageKey, {});
      seen.clear();
      asked.clear();
      log.replaceChildren();
      const reconnect = !!socket;
      disconnect();
      if (reconnect || !panel.hidden) connect();
    },
    destroy() {
      disconnect();
      host.remove();
    },
  };
}

/** Theme values become CSS variables on the host; anything that is not a plain value is ignored. */
function applyTheme(host: HTMLElement, theme: ChatTheme | undefined) {
  if (!theme) return;
  const colour = (v: unknown) =>
    typeof v === 'string' && /^[#(),.%\w\s-]{1,64}$/.test(v) ? v : null;
  const primary = colour(theme.primary);
  const onPrimary = colour(theme.onPrimary);
  if (primary) host.style.setProperty('--tms-primary', primary);
  if (onPrimary) host.style.setProperty('--tms-on-primary', onPrimary);
  if (typeof theme.radius === 'number' && theme.radius >= 0 && theme.radius <= 32) {
    host.style.setProperty('--tms-radius', `${theme.radius}px`);
  }
  if (theme.position === 'left') host.dataset.position = 'left';
}

function readStore(key: string): { token?: string; name?: string; email?: string } {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

function writeStore(key: string, value: object) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the session lasts until the page reloads.
  }
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}
