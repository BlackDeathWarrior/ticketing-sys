import { io, type Socket } from 'socket.io-client';
import { type Mic, Speaker, startMic } from './voice-audio';

/**
 * TMS voice: talk to support from a web page.
 *
 *   <div id="call"></div>
 *   <script src="https://tms.example.com/widget/tms-voice.js"></script>
 *   <script>TMSVoice.init({ server: 'https://tms.example.com', mount: '#call' })</script>
 */
export interface VoiceOptions {
  /** TMS origin. Defaults to the origin the script was loaded from. */
  server?: string;
  /** Where to draw the call box: an element or a selector. Defaults to the end of the page. */
  mount?: HTMLElement | string;
  title?: string;
}

type State = 'greeting' | 'listening' | 'thinking' | 'speaking' | 'waiting' | 'human' | 'ended';
interface Caption {
  who: 'caller' | 'ai' | 'agent';
  text: string;
}
type StartResult = { ok: true; callId: string; token: string } | { ok: false; error: string };

const STATE_TEXT: Record<State, string> = {
  greeting: 'Connecting…',
  listening: 'Listening. Go ahead.',
  thinking: 'One moment…',
  speaking: 'Speaking. You can interrupt.',
  waiting: 'Please hold: we are finding a person for you.',
  human: 'You are talking to a person.',
  ended: 'The call has ended.',
};
const WHO: Record<Caption['who'], string> = { caller: 'You', ai: 'Assistant', agent: 'Agent' };
const ENDED: Record<string, string> = {
  caller_hung_up: 'You ended the call.',
  agent_ended: 'The agent ended the call.',
  time_limit: 'The call reached its time limit.',
  error: 'The call was cut off by a problem on our side. Please try again.',
  server_shutdown: 'The call was cut off. Please try again in a moment.',
};

const scriptOrigin = (() => {
  const src = (document.currentScript as HTMLScriptElement | null)?.src;
  try {
    return src ? new URL(src).origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
})();

const CSS = `
:host { all: initial; font-family: system-ui, sans-serif; color: #1c2430; }
.box { border: 1px solid #d5dbe3; border-radius: 10px; padding: 20px; max-width: 480px; background: #fff; }
h2 { margin: 0 0 8px; font-size: 20px; }
p { margin: 0 0 12px; font-size: 14px; line-height: 1.5; }
.notice { color: #4a5565; }
label { display: block; font-size: 13px; margin-bottom: 10px; }
input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 8px 10px; font: inherit; border: 1px solid #b9c2ce; border-radius: 6px; }
button { font: inherit; padding: 10px 16px; border-radius: 6px; border: 1px solid #1f4e89; background: #1f4e89; color: #fff; cursor: pointer; }
button.end { background: #fff; color: #1f4e89; }
button:disabled { opacity: 0.6; cursor: default; }
.status { font-weight: 600; }
.error { color: #8a1c1c; }
.meter { height: 6px; background: #e6eaf0; border-radius: 3px; overflow: hidden; margin: 0 0 12px; }
.meter > span { display: block; height: 100%; width: 0; background: #1f4e89; transition: width 80ms linear; }
ol { list-style: none; margin: 0 0 12px; padding: 0; max-height: 240px; overflow-y: auto; }
li { font-size: 14px; line-height: 1.45; margin-bottom: 8px; overflow-wrap: anywhere; }
li b { display: block; font-size: 12px; color: #4a5565; font-weight: 600; }
`;

function init(options: VoiceOptions = {}) {
  const server = (options.server ?? scriptOrigin).replace(/\/$/, '');
  const target =
    typeof options.mount === 'string'
      ? document.querySelector<HTMLElement>(options.mount)
      : options.mount;
  const host = document.createElement('div');
  (target ?? document.body).appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${CSS}</style>
    <section class="box" aria-label="Voice call">
      <h2></h2>
      <div id="before">
        <p class="notice">Calls are recorded and transcribed so we can help you. Recordings are deleted after 30 days. By starting the call you agree to this.</p>
        <label>Your name (optional)<input id="name" autocomplete="name" maxlength="200" /></label>
        <label>Email (optional)<input id="email" type="email" autocomplete="email" /></label>
        <button type="button" id="start">Start call</button>
      </div>
      <div id="during" hidden>
        <p class="status" id="status" role="status" aria-live="polite"></p>
        <div class="meter" aria-hidden="true"><span id="level"></span></div>
        <ol id="captions" aria-label="What was said"></ol>
        <button type="button" class="end" id="end">End call</button>
      </div>
      <p class="error" id="error" role="alert" hidden></p>
    </section>`;
  const $ = <T extends HTMLElement>(id: string) => root.getElementById(id) as T;
  root.querySelector('h2')!.textContent = options.title ?? 'Talk to us';
  const before = $('before');
  const during = $('during');
  const status = $('status');
  const captions = $('captions');
  const error = $('error');
  const startButton = $<HTMLButtonElement>('start');

  let socket: Socket | undefined;
  let mic: Mic | undefined;
  let speaker: Speaker | undefined;

  const fail = (message: string) => {
    error.textContent = message;
    error.hidden = false;
  };

  const finish = (message: string) => {
    mic?.stop();
    mic = undefined;
    speaker?.close();
    speaker = undefined;
    socket?.disconnect();
    socket = undefined;
    status.textContent = message;
    $('level').style.width = '0';
    $<HTMLButtonElement>('end').hidden = true;
    startButton.disabled = false;
    startButton.textContent = 'Call again';
    before.hidden = false;
  };

  const start = async () => {
    error.hidden = true;
    startButton.disabled = true;
    captions.replaceChildren();
    // Created inside the click, so the browser lets it play.
    speaker = new Speaker();
    await speaker.resume();

    const s = io(`${server}/voice`, { transports: ['websocket'], forceNew: true });
    socket = s;
    s.on('audio', (pcm: ArrayBuffer) => speaker?.play(pcm));
    s.on('clear', () => speaker?.clear());
    s.on('state', (state: State) => (status.textContent = STATE_TEXT[state] ?? ''));
    s.on('caption', (c: Caption) => {
      const li = document.createElement('li');
      const who = document.createElement('b');
      who.textContent = WHO[c.who];
      li.append(who, c.text);
      li.dataset.who = c.who;
      captions.append(li);
      captions.scrollTop = captions.scrollHeight;
    });
    s.on('ended', (e: { reason: string }) => finish(ENDED[e.reason] ?? STATE_TEXT.ended));
    s.on('connect_error', () => {
      if (!mic) {
        finish('');
        fail('We could not reach the call service. Please try again.');
      }
    });

    try {
      const result = (await s.timeout(15_000).emitWithAck('start', {
        name: $<HTMLInputElement>('name').value,
        email: $<HTMLInputElement>('email').value,
        consent: true,
      })) as StartResult;
      if (!result.ok) throw new Error(result.error);
      before.hidden = true;
      during.hidden = false;
      $<HTMLButtonElement>('end').hidden = false;
      status.textContent = STATE_TEXT.greeting;
      mic = await startMic(
        (frame) => s.emit('audio', frame.buffer),
        (level) => ($('level').style.width = `${Math.round(level * 100)}%`),
      );
    } catch (err) {
      const denied = err instanceof DOMException && /NotAllowed|Permission/i.test(err.name);
      finish('');
      during.hidden = true;
      startButton.textContent = 'Start call';
      fail(
        denied
          ? 'The microphone is blocked. Allow it for this page, then try again.'
          : err instanceof Error && err.message !== 'operation has timed out'
            ? err.message
            : 'The call could not be started. Please try again.',
      );
    }
  };

  startButton.addEventListener('click', () => void start());
  $('end').addEventListener('click', () => {
    socket?.emit('hangup');
    finish(ENDED.caller_hung_up!);
  });
  window.addEventListener('pagehide', () => socket?.disconnect());
}

export { init };
