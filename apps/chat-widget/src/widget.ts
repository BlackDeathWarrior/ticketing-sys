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
  /** Read out by screen readers while the assistant writes its answer. */
  typing?: string;
  /** The button shown when the chat could not connect or was disconnected. */
  retry?: string;
  /** Shown when the server ended the chat without saying why. */
  disconnected?: string;
  /** Under the email field when what was typed is not an email address. */
  emailError?: string;
  /** Above the name and email fields when both are required (`anonymous: 'fresh'`). */
  detailsRequired?: string;
  /** Under the name field when it is required and empty. */
  nameError?: string;
  /** Under the email field when it is required and empty or not an email address. */
  emailRequired?: string;
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
  /**
   * Visitors without an identity token. `'resume'` (the default) keeps their
   * conversation in this browser and picks it up on the next visit. `'fresh'`
   * starts a new conversation every time the widget starts and asks for name
   * and email (both required) before it; neither is kept in the browser, so
   * the next person at a shared computer starts from nothing.
   */
  anonymous?: 'resume' | 'fresh';
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
  /**
   * The visitor signed in (a token) or signed out (`null`): the chat becomes
   * that person's own conversation, or an anonymous one. Nothing of the
   * previous person's conversation stays on screen.
   */
  identify(identityToken: string | null): void;
  /** Disconnects and removes the widget from the page. */
  destroy(): void;
}

interface ChatMessage {
  id: string;
  body: string;
  authorType: 'customer' | 'agent' | 'ai' | 'system';
  authorName?: string | null;
  createdAt: string;
  cards?: ChatCard[];
}

/** An item shown under a message: a picture, a title, a line of text and its buttons. */
interface ChatCard {
  id: string;
  title: string;
  text?: string;
  imageUrl: string;
  url?: string;
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
  typing: 'Support is typing',
  retry: 'Try again',
  disconnected: 'The chat was disconnected.',
  emailError: 'That does not look like an email address. Correct it, or leave it empty.',
  detailsRequired: 'Tell us your name and email so we can follow up.',
  nameError: 'Please enter your name.',
  emailRequired: 'Please enter your email address, for example name@example.com.',
};

/** Where the visitor's choice of panel size is kept, in their own browser. */
const SIZE_KEY = 'tms-chat-size';

/** What is asked after a rating, by how happy it was. The answer is optional. */
function ratingFollowUp(rating: number): string {
  if (rating <= 2) {
    return 'We are sorry to hear that. Would you like to tell us what went wrong, so we can improve? (optional)';
  }
  if (rating === 3) {
    return 'Thank you. Is there anything we could have done better? (optional)';
  }
  return 'We are glad to hear that. Would you like to tell us what went well? (optional)';
}

/** How long the typing dots may show without an answer arriving. */
const TYPING_MAX_MS = 45_000;

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
.status button { margin-left: 6px; border: 0; background: none; padding: 0; font-size: 12px; color: var(--tms-primary); text-decoration: underline; cursor: pointer; }
.details .error { margin: 0; font-size: 12px; color: #b91c1c; }
.log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 80%; padding: 8px 10px; border-radius: 10px; white-space: pre-wrap; word-wrap: break-word; }
.msg.customer { align-self: flex-end; background: var(--tms-primary); color: var(--tms-on-primary); }
.msg.agent, .msg.ai, .msg.system { align-self: flex-start; background: #f3f4f6; }
.msg small { display: block; font-size: 11px; opacity: .75; margin-bottom: 2px; }
.msg.failed { background: #b91c1c; }
.cards { align-self: stretch; flex: 0 0 auto; display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 6px; scroll-snap-type: x proximity; }
.card { flex: 0 0 170px; scroll-snap-align: start; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; background: #fff; display: flex; flex-direction: column; }
.card img { width: 100%; height: 150px; object-fit: cover; background: #f3f4f6; display: block; }
.card b { display: block; padding: 6px 8px 0; font-size: 13px; line-height: 1.25; }
.card span { display: block; padding: 2px 8px 6px; font-size: 12px; color: #4b5563; flex: 1; }
.card button, .card a { display: block; width: 100%; box-sizing: border-box; padding: 7px 8px; border: 0; border-top: 1px solid #e5e7eb; background: #fff; color: var(--tms-primary); font: inherit; font-size: 13px; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; }
.card button:hover, .card a:hover { background: #f9fafb; }
.card button:focus-visible, .card a:focus-visible { outline: 2px solid var(--tms-primary); outline-offset: -2px; }
.msg.typing { display: flex; gap: 4px; align-items: center; padding: 12px 12px; }
.msg.typing i { width: 6px; height: 6px; border-radius: 50%; background: #6b7280; animation: tms-typing 1.2s infinite ease-in-out; }
.msg.typing i:nth-child(2) { animation-delay: .15s; }
.msg.typing i:nth-child(3) { animation-delay: .3s; }
@keyframes tms-typing { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .msg.typing i { animation: none; opacity: .6; } }
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
.rate label { display: block; margin: 0 0 6px; }
.rate textarea { display: block; width: 100%; min-height: 60px; }
.rate .actions { display: flex; gap: 8px; margin-top: 8px; }
.rate .actions button { min-height: 34px; padding: 0 12px; border: 1px solid var(--tms-primary); border-radius: 8px; background: var(--tms-primary); color: var(--tms-on-primary); font-size: 14px; cursor: pointer; }
.rate .actions button.plain { background: #fff; color: var(--tms-primary); }
.rate .actions button:disabled { opacity: .5; cursor: default; }
header .tools { display: flex; gap: 10px; align-items: center; }
.panel.large { width: min(560px, calc(100vw - 40px)); height: min(760px, calc(100vh - 120px)); }
.panel.large .card { flex-basis: 200px; }
@media (max-width: 480px) { header .size { display: none; } }
`;

export function init(options: ChatOptions = {}): ChatHandle {
  const server = (options.server ?? scriptOrigin).replace(/\/$/, '');
  // One conversation per site: two integrations on one TMS don't share a session.
  const storageKey = `tms-chat:${server}${options.integration ? `:${options.integration}` : ''}`;
  const stored = readStore(storageKey);
  // Anonymous visitors start a new conversation each time and always say who they are.
  const fresh = options.anonymous === 'fresh';
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
        <span class="tools"><button type="button" class="size" aria-pressed="false" aria-label="Make the chat larger" title="Make the chat larger">⤢</button>
        <button type="button" class="close" aria-label="Close chat">×</button></span></header>
      <div class="status" aria-live="polite" hidden></div>
      <div class="details" hidden>
        <p>${escapeHtml(fresh ? text.detailsRequired : text.details)}</p>
        <label for="tms-name">Name</label><input id="tms-name" autocomplete="name" aria-describedby="tms-name-error"${fresh ? ' required' : ''} />
        <p class="error" id="tms-name-error" role="alert" hidden></p>
        <label for="tms-email">Email</label><input id="tms-email" type="email" autocomplete="email" aria-describedby="tms-email-error"${fresh ? ' required' : ''} />
        <p class="error" id="tms-email-error" role="alert" hidden></p>
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
  let identityToken = options.identityToken;
  // One stored session per person who has used this browser, and one for anonymous use:
  // signing out must not leave the next visitor in the previous person's conversation.
  const sessions: Record<string, string> = { ...(stored.sessions ?? {}) };
  if (stored.token && !sessions.anon) sessions.anon = stored.token;
  // A fresh anonymous chat is never kept, so none is picked up either.
  if (fresh) delete sessions.anon;
  /** The stored session for whoever is here now (none for a fresh anonymous chat). */
  const storedSession = () =>
    fresh && !identityToken ? undefined : sessions[visitorKey(identityToken)];
  let token: string | undefined = storedSession();
  let sessionId: string | undefined;
  /** Why the server refused the chat, when it said so. */
  let refusal: string | null = null;
  let context = options.context;
  let visitor = fresh
    ? { name: options.visitor?.name, email: options.visitor?.email }
    : {
        name: stored.name ?? options.visitor?.name,
        email: stored.email ?? options.visitor?.email,
      };
  const seen = new Set<string>();
  const asked = new Set<string>();
  let typing: HTMLElement | null = null;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;

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
  // A fresh anonymous chat always asks, once, before it starts.
  const needsDetails = () =>
    fresh
      ? !token && !identityToken && !socket
      : options.askForDetails !== false &&
        !token &&
        !identityToken &&
        !options.visitor?.name &&
        !options.visitor?.email;

  /** The name and email form, or the conversation. */
  function showStart() {
    if (needsDetails()) {
      details.hidden = false;
      form.hidden = true;
      $<HTMLInputElement>('#tms-name').value = visitor.name ?? '';
      $<HTMLInputElement>('#tms-email').value = visitor.email ?? '';
      $<HTMLInputElement>('#tms-name').focus();
    } else {
      details.hidden = true;
      form.hidden = false;
      connect();
      input.focus();
    }
  }

  function open() {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    showStart();
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
    socket.on('connect', () => {
      refusal = null;
      setStatus('Connected');
    });
    socket.on('disconnect', (reason: string) => {
      setTyping(false);
      // When the server ends the chat, socket.io does not come back by itself: offer a way to.
      if (reason === 'io server disconnect') setStatus(refusal ?? text.disconnected, true);
      else setStatus('Reconnecting…');
    });
    socket.on('connect_error', () => setStatus('Cannot reach support right now. Retrying…'));
    // The server refused the handshake (an unknown integration, too many chats).
    socket.on('error', (e: { message?: string }) => {
      if (!e?.message) return;
      refusal = e.message;
      setStatus(e.message, true);
    });
    socket.on('session', async (s: { token: string; sessionId?: string }) => {
      // The server started a different session than the one on screen (another person's
      // token, an expired one): what is shown belongs to nobody here any more.
      if (sessionId && s.sessionId && s.sessionId !== sessionId) resetLog();
      sessionId = s.sessionId;
      token = s.token;
      if (!fresh || identityToken) sessions[visitorKey(identityToken)] = token;
      // Who a fresh anonymous visitor said they were is not kept either.
      writeStore(storageKey, fresh ? { sessions } : { sessions, ...visitor });
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
      if (m.authorType !== 'customer') setTyping(false);
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
      askForComment(prompt, res.rating, box, label);
    } catch (err) {
      label.textContent = `Your rating was not saved: ${err instanceof Error ? err.message : 'please try again'}`;
    }
  }

  /**
   * The rating is saved; now the visitor may say why, in their own words. Nothing more is
   * needed from them: "No thanks" leaves the rating as it is.
   */
  function askForComment(prompt: RatingPrompt, rating: number, box: HTMLElement, label: HTMLElement) {
    const thanks = `Thanks for your rating: ${rating} out of 5.`;
    label.textContent = thanks;
    const id = `tms-comment-${prompt.reference}`;
    const question = document.createElement('label');
    question.htmlFor = id;
    question.textContent = ratingFollowUp(rating);
    const comment = document.createElement('textarea');
    comment.id = id;
    comment.rows = 3;
    comment.maxLength = 2000;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const sendComment = document.createElement('button');
    sendComment.type = 'button';
    sendComment.textContent = 'Send';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'plain';
    skip.textContent = 'No thanks';
    const done = (message: string) => {
      box.replaceChildren(label);
      label.textContent = message;
      box.setAttribute('role', 'status');
    };
    skip.addEventListener('click', () => done(thanks));
    sendComment.addEventListener('click', () => {
      const words = comment.value.trim();
      if (!words) return done(thanks);
      sendComment.disabled = true;
      skip.disabled = true;
      socket!
        .timeout(10_000)
        .emitWithAck('rate', { token: prompt.token, rating, comment: words })
        .then((res: Ack<{ rating: number }>) => {
          if (!res.ok) throw new Error(res.error);
          done(`${thanks} Thank you for telling us more.`);
        })
        .catch((err: unknown) => {
          sendComment.disabled = false;
          skip.disabled = false;
          question.textContent = `Your comment was not sent: ${err instanceof Error ? err.message : 'please try again'}`;
        });
    });
    actions.append(sendComment, skip);
    box.replaceChildren(label, question, comment, actions);
    log.scrollTop = log.scrollHeight;
    comment.focus();
  }

  function setStatus(message: string, retry = false) {
    status.textContent = message;
    if (retry) {
      const again = document.createElement('button');
      again.type = 'button';
      again.textContent = text.retry;
      again.addEventListener('click', () => {
        disconnect();
        connect();
      });
      status.appendChild(again);
    }
    sendBtn.disabled = !socket?.connected;
  }

  /** An empty conversation, as when the panel is first opened. */
  function resetLog() {
    seen.clear();
    asked.clear();
    setTyping(false);
    const intro = document.createElement('p');
    intro.className = 'empty';
    intro.textContent = text.intro;
    log.replaceChildren(intro);
  }

  /**
   * Three moving dots while the assistant writes its answer. The server says
   * when (the ack of a message the assistant will answer); they go when a
   * message arrives, and after a while by themselves so they never promise
   * an answer that is not coming.
   */
  function setTyping(on: boolean) {
    clearTimeout(typingTimer);
    typing?.remove();
    typing = null;
    if (!on) return;
    typing = document.createElement('div');
    typing.className = 'msg ai typing';
    typing.setAttribute('role', 'status');
    typing.setAttribute('aria-label', text.typing);
    typing.append(
      document.createElement('i'),
      document.createElement('i'),
      document.createElement('i'),
    );
    log.appendChild(typing);
    log.scrollTop = log.scrollHeight;
    typingTimer = setTimeout(() => setTyping(false), TYPING_MAX_MS);
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
    // The dots stay the last thing in the conversation.
    log.insertBefore(el, typing);
    if (m.cards?.length) log.insertBefore(cardRow(m.id, m.cards), typing);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  /**
   * The items under a message, side by side, each with the two buttons a card has on
   * WhatsApp. Everything in a card comes from an outside app: it is set as text, never as
   * HTML, and only an https address becomes a picture or a link.
   */
  function cardRow(messageId: string, cards: ChatCard[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'cards';
    row.setAttribute('role', 'list');
    const secure = (v: string | undefined) => (v && /^https:\/\//i.test(v) ? v : null);
    for (const card of cards.slice(0, 10)) {
      const item = document.createElement('div');
      item.className = 'card';
      item.setAttribute('role', 'listitem');
      const picture = secure(card.imageUrl);
      if (picture) {
        const img = document.createElement('img');
        img.src = picture;
        img.alt = card.title;
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        item.appendChild(img);
      }
      const title = document.createElement('b');
      title.textContent = card.title;
      item.appendChild(title);
      const line = document.createElement('span');
      line.textContent = card.text ?? '';
      item.appendChild(line);
      const like = document.createElement('button');
      like.type = 'button';
      like.textContent = 'I like this';
      like.addEventListener('click', () => {
        void send(`I like this: ${card.title}`, { messageId, id: card.id, kind: 'like' });
      });
      item.appendChild(like);
      const link = secure(card.url);
      if (link) {
        const view = document.createElement('a');
        view.href = link;
        view.target = '_blank';
        view.rel = 'noopener noreferrer';
        view.textContent = 'View product';
        item.appendChild(view);
      }
      row.appendChild(item);
    }
    return row;
  }

  async function send(
    body: string,
    card?: { messageId: string; id: string; kind: 'like' | 'view' },
  ) {
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
      const res = (await socket!.timeout(10_000).emitWithAck('message', {
        text: body,
        clientMessageId,
        ...(card ? { card } : {}),
      })) as Ack<{
        message: ChatMessage;
        ticket?: { reference: string; created: boolean };
        assistantReplying?: boolean;
      }>;
      if (!res.ok) throw new Error(res.error);
      seen.add(res.message.id);
      if (bubble) bubble.style.opacity = '1';
      if (res.assistantReplying) setTyping(true);
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

  // Two sizes: the usual one, and a larger one for reading long answers and cards. Never
  // larger than the window allows; on a narrow screen the panel fills the width either way.
  const sizeBtn = $<HTMLButtonElement>('.size');
  function setLarge(large: boolean) {
    panel.classList.toggle('large', large);
    sizeBtn.setAttribute('aria-pressed', String(large));
    const label = large ? 'Make the chat smaller' : 'Make the chat larger';
    sizeBtn.setAttribute('aria-label', label);
    sizeBtn.title = label;
    try {
      localStorage.setItem(SIZE_KEY, large ? 'large' : 'normal');
    } catch {
      // Storage is blocked: the size holds until the page is left.
    }
    log.scrollTop = log.scrollHeight;
  }
  sizeBtn.addEventListener('click', () => setLarge(!panel.classList.contains('large')));
  try {
    if (localStorage.getItem(SIZE_KEY) === 'large') setLarge(true);
  } catch {
    // Storage is blocked: the usual size.
  }
  root.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape' && !panel.hidden) close();
  });
  const emailError = $<HTMLElement>('#tms-email-error');
  const nameError = $<HTMLElement>('#tms-name-error');
  function start() {
    const name = $<HTMLInputElement>('#tms-name').value.trim();
    const email = $<HTMLInputElement>('#tms-email').value.trim();
    // Optional unless the chat is fresh, but a mistyped address would be no use to anyone.
    const noName = fresh && !name;
    const badEmail = (fresh || !!email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    nameError.textContent = text.nameError;
    nameError.hidden = !noName;
    emailError.textContent = fresh ? text.emailRequired : text.emailError;
    emailError.hidden = !badEmail;
    if (noName || badEmail) {
      $<HTMLInputElement>(noName ? '#tms-name' : '#tms-email').focus();
      return;
    }
    visitor = { name: name || undefined, email: email || undefined };
    details.hidden = true;
    form.hidden = false;
    connect();
    input.focus();
  }
  $<HTMLButtonElement>('.start').addEventListener('click', start);
  details.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      start();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body || !socket?.connected) return;
    input.value = '';
    void send(body);
  });
  input.addEventListener('keydown', (e) => {
    // While an input method is composing (Hindi, Chinese, Japanese…), Enter picks a word.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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
      identityToken = nextToken ?? undefined;
      // That person's own conversation if this browser has one, otherwise a new one.
      // The server checks it too: a session is resumed only by whoever it belongs to.
      token = storedSession();
      sessionId = undefined;
      resetLog();
      const reconnect = !!socket;
      disconnect();
      if (fresh && !identityToken) {
        // Signed out: whoever is here now says who they are before a new chat starts.
        visitor = { name: undefined, email: undefined };
        if (!panel.hidden) showStart();
      } else if (reconnect || !panel.hidden) {
        details.hidden = true;
        form.hidden = false;
        connect();
      }
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

/**
 * Which stored session is this visitor's: one per signed-in person (a short
 * hash of who the identity token names, so no address is kept in storage),
 * and `anon` for anyone not signed in. Reading the token here proves nothing;
 * the server verifies it.
 */
function visitorKey(identityToken: string | undefined): string {
  if (!identityToken) return 'anon';
  try {
    const body = identityToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(body)) as { sub?: unknown; email?: unknown };
    const who = typeof claims.sub === 'string' ? claims.sub : claims.email;
    if (typeof who !== 'string' || !who) return 'anon';
    let hash = 5381;
    for (let i = 0; i < who.length; i++) hash = ((hash << 5) + hash + who.charCodeAt(i)) >>> 0;
    return `id:${hash.toString(36)}`;
  } catch {
    return 'anon';
  }
}

function readStore(key: string): {
  /** The single session older versions kept. */
  token?: string;
  sessions?: Record<string, string>;
  name?: string;
  email?: string;
} {
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
