import { io, type Socket } from 'socket.io-client';

/**
 * TMS web chat widget. Embed with:
 *   <script src="https://tms.example.com/widget/tms-chat.js"></script>
 *   <script>TMSChat.init({ server: 'https://tms.example.com' })</script>
 *
 * Kept deliberately small and framework-free; it renders inside a shadow
 * root so the host page's CSS can't break it (and it can't break the page).
 */

export interface ChatOptions {
  /** TMS base URL. Defaults to where this script was loaded from. */
  server?: string;
  title?: string;
  /** HS256 token signed by your site (CHAT_IDENTITY_SECRET) for logged-in visitors. */
  identityToken?: string;
  /** Ask anonymous visitors for name and email before the first message. */
  askForDetails?: boolean;
}

interface ChatMessage {
  id: string;
  body: string;
  authorType: 'customer' | 'agent' | 'ai' | 'system';
  authorName?: string | null;
  createdAt: string;
}

type Ack<T> = ({ ok: true } & T) | { ok: false; error: string };

const script = document.currentScript as HTMLScriptElement | null;
const scriptOrigin = script?.src ? new URL(script.src).origin : window.location.origin;

const CSS = `
:host { all: initial; }
/* Component rules below set display, which would otherwise override the hidden attribute. */
[hidden] { display: none !important; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; border: 0; border-radius: 24px;
  padding: 12px 18px; background: #1f4e89; color: #fff; font-size: 15px; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.2); }
.launcher:focus-visible, button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }
.panel { position: fixed; right: 20px; bottom: 80px; z-index: 2147483000; width: min(360px, calc(100vw - 40px));
  height: min(520px, calc(100vh - 120px)); background: #fff; color: #111; border-radius: 12px; display: flex;
  flex-direction: column; box-shadow: 0 8px 30px rgba(0,0,0,.25); overflow: hidden; font-size: 14px; }
.panel[hidden] { display: none; }
header { background: #1f4e89; color: #fff; padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; }
header strong { font-size: 15px; }
header button { background: none; border: 0; color: #fff; font-size: 20px; cursor: pointer; line-height: 1; }
.status { font-size: 12px; padding: 4px 14px; background: #f3f4f6; color: #4b5563; }
.log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 80%; padding: 8px 10px; border-radius: 10px; white-space: pre-wrap; word-wrap: break-word; }
.msg.customer { align-self: flex-end; background: #1f4e89; color: #fff; }
.msg.agent, .msg.ai, .msg.system { align-self: flex-start; background: #f3f4f6; }
.msg small { display: block; font-size: 11px; opacity: .75; margin-bottom: 2px; }
.msg.failed { background: #b91c1c; }
.empty { color: #6b7280; text-align: center; margin: auto; }
form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e5e7eb; }
textarea { flex: 1; resize: none; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; font-size: 14px; }
form button, .details button { border: 0; border-radius: 8px; background: #1f4e89; color: #fff; padding: 0 14px; cursor: pointer; }
form button:disabled { opacity: .5; cursor: default; }
.details { padding: 14px; display: flex; flex-direction: column; gap: 8px; }
.details label { font-size: 13px; color: #374151; }
.details input { border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; font-size: 14px; width: 100%; }
.details button { padding: 10px; }
`;

export function init(options: ChatOptions = {}) {
  const server = (options.server ?? scriptOrigin).replace(/\/$/, '');
  const storageKey = `tms-chat:${server}`;
  const stored = readStore(storageKey);

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${CSS}</style>
    <button class="launcher" type="button" aria-expanded="false" aria-controls="tms-panel">Chat with us</button>
    <section class="panel" id="tms-panel" role="dialog" aria-label="${escapeHtml(options.title ?? 'Chat')}" hidden>
      <header><strong>${escapeHtml(options.title ?? 'Chat with us')}</strong>
        <button type="button" class="close" aria-label="Close chat">×</button></header>
      <div class="status" aria-live="polite" hidden></div>
      <div class="details" hidden>
        <p>Tell us who you are so we can follow up. Both are optional.</p>
        <label for="tms-name">Name</label><input id="tms-name" autocomplete="name" />
        <label for="tms-email">Email</label><input id="tms-email" type="email" autocomplete="email" />
        <button type="button" class="start">Start chat</button>
      </div>
      <div class="log" aria-live="polite"><p class="empty">Ask us anything. We usually reply within a few minutes.</p></div>
      <form><textarea rows="2" aria-label="Message" placeholder="Type a message…" maxlength="5000"></textarea>
        <button type="submit">Send</button></form>
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
  let visitor = { name: stored.name, email: stored.email };
  const seen = new Set<string>();

  const needsDetails = () => options.askForDetails !== false && !token && !options.identityToken;

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
  }

  function close() {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }

  function connect() {
    if (socket) return;
    status.hidden = false;
    status.textContent = 'Connecting…';
    socket = io(`${server}/chat`, {
      transports: ['websocket', 'polling'],
      auth: (cb) =>
        cb({
          token,
          identityToken: options.identityToken,
          name: visitor.name,
          email: visitor.email,
        }),
    });
    socket.on('connect', () => setStatus('Connected'));
    socket.on('disconnect', () => setStatus('Reconnecting…'));
    socket.on('connect_error', () => setStatus('Cannot reach support right now. Retrying…'));
    socket.on('session', async (s: { token: string }) => {
      token = s.token;
      writeStore(storageKey, { token, ...visitor });
      const res = (await socket!.emitWithAck('history')) as Ack<{ messages: ChatMessage[] }>;
      if (res.ok) res.messages.forEach((m) => render(m));
    });
    socket.on('message', (m: ChatMessage) => render(m));
  }

  function setStatus(text: string) {
    status.textContent = text;
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

  async function send(text: string) {
    const clientMessageId = crypto.randomUUID();
    const bubble = render(
      {
        id: clientMessageId,
        body: text,
        authorType: 'customer',
        createdAt: new Date().toISOString(),
      },
      true,
    );
    try {
      const res = (await socket!
        .timeout(10_000)
        .emitWithAck('message', { text, clientMessageId })) as Ack<{ message: ChatMessage }>;
      if (!res.ok) throw new Error(res.error);
      seen.add(res.message.id);
      if (bubble) bubble.style.opacity = '1';
    } catch (err) {
      if (bubble) {
        bubble.classList.add('failed');
        bubble.title = err instanceof Error ? err.message : 'Not sent';
        bubble.style.opacity = '1';
      }
      setStatus(`Message not sent: ${err instanceof Error ? err.message : 'try again'}`);
    }
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
    const text = input.value.trim();
    if (!text || !socket?.connected) return;
    input.value = '';
    void send(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // Returning visitors reconnect straight away so replies arrive while the panel is closed.
  if (token) connect();
  return { open, close };
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
