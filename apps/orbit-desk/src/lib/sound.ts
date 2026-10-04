import type { NotificationTone } from '@tms/shared';

/**
 * Notification sounds, made with Web Audio: no files to ship or load.
 *
 * A browser only lets a page make sound after the person has interacted with
 * it. Until then the context stays suspended and `play` does nothing, which
 * is the right outcome: a tab nobody has touched stays quiet.
 */

/** Window event: the signed-in person saved new preferences (detail: `UserPreferences`). */
export const PREFERENCES_CHANGED = 'orbit:preferences';

type Note = { freq: number; at: number; length: number };

const TONES: Record<NotificationTone, { wave: OscillatorType; notes: Note[] }> = {
  chime: {
    wave: 'sine',
    notes: [
      { freq: 660, at: 0, length: 0.18 },
      { freq: 880, at: 0.14, length: 0.28 },
    ],
  },
  ping: { wave: 'triangle', notes: [{ freq: 988, at: 0, length: 0.22 }] },
  knock: {
    wave: 'sine',
    notes: [
      { freq: 196, at: 0, length: 0.09 },
      { freq: 196, at: 0.16, length: 0.09 },
    ],
  },
};

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (context) return context;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  return context;
}

/** Call once at start-up: wakes the audio context on the person's first click or key press. */
export function armSound() {
  const wake = () => {
    void audio()?.resume();
    window.removeEventListener('pointerdown', wake);
    window.removeEventListener('keydown', wake);
  };
  window.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', wake);
}

/** Plays a tone at `volume` (0 to 1). Resolves to false when the browser would not make a sound. */
export async function playTone(tone: NotificationTone, volume: number): Promise<boolean> {
  const ctx = audio();
  if (!ctx || volume <= 0) return false;
  const running = () => ctx.state === 'running';
  if (!running()) {
    // Granted when this follows a click or key press (the "Test sound" button);
    // otherwise the browser leaves the context suspended and nothing is played.
    await Promise.race([
      ctx.resume().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ]);
    if (!running()) return false;
  }
  const { wave, notes } = TONES[tone];
  const peak = Math.min(1, Math.max(0, volume)) * 0.4;
  for (const note of notes) {
    const start = ctx.currentTime + note.at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.value = note.freq;
    // A short fade in and out, so the note does not click.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.length);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + note.length + 0.02);
  }
  return true;
}
