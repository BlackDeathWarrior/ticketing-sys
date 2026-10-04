/**
 * Microphone capture and speech playback for voice calls, with no imports so
 * it can be bundled into the caller's page and into Orbit Desk alike.
 * Keep apps/chat-widget/src/voice-audio.ts identical to this file.
 *
 * Audio on the wire is 16-bit mono PCM at 16 kHz, in frames of 100 ms.
 */
export const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = SAMPLE_RATE / 10;

/** Float samples (-1..1) at `fromRate` → 16-bit PCM at `toRate`, by averaging (fine for speech). */
export function downsampleToPcm16(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Int16Array {
  const ratio = Math.max(1, fromRate / toRate);
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

export function pcm16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 0x8000;
  return out;
}

/** Loudness of a frame, 0..1, for a microphone level meter. */
export function frameLevel(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += (pcm[i]! / 0x8000) ** 2;
  return Math.min(1, Math.sqrt(sum / pcm.length) * 4);
}

/** Cuts a stream of samples into fixed frames, carrying the remainder over. */
export class Framer {
  private rest = new Int16Array(0);

  constructor(private readonly size = FRAME_SAMPLES) {}

  push(samples: Int16Array): Int16Array[] {
    const all = new Int16Array(this.rest.length + samples.length);
    all.set(this.rest);
    all.set(samples, this.rest.length);
    const frames: Int16Array[] = [];
    let at = 0;
    for (; at + this.size <= all.length; at += this.size)
      frames.push(all.slice(at, at + this.size));
    this.rest = all.slice(at);
    return frames;
  }
}

const WORKLET = `
class TmsMic extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('tms-mic', TmsMic);
`;

export interface Mic {
  stop(): void;
}

/**
 * Opens the microphone and calls `onFrame` with 100 ms of 16 kHz PCM at a
 * time. Rejects when the browser has no microphone or the visitor says no.
 */
export async function startMic(
  onFrame: (frame: Int16Array) => void,
  onLevel?: (level: number) => void,
): Promise<Mic> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot use the microphone on this page.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const framer = new Framer();
  const handle = (samples: Float32Array) => {
    for (const frame of framer.push(downsampleToPcm16(samples, context.sampleRate, SAMPLE_RATE))) {
      onLevel?.(frameLevel(frame));
      onFrame(frame);
    }
  };

  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  let node: AudioNode;
  try {
    await context.audioWorklet.addModule(url);
    const worklet = new AudioWorkletNode(context, 'tms-mic');
    worklet.port.onmessage = (e: MessageEvent<Float32Array>) => handle(e.data);
    node = worklet;
  } finally {
    URL.revokeObjectURL(url);
  }
  // Nothing is played from this graph; the muted gain only keeps it running.
  const silent = context.createGain();
  silent.gain.value = 0;
  source.connect(node);
  node.connect(silent);
  silent.connect(context.destination);

  return {
    stop() {
      source.disconnect();
      node.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
}

/** Plays PCM as it arrives, one piece after another, and can fall silent at once. */
export class Speaker {
  private readonly context = new AudioContext();
  private readonly playing = new Set<AudioBufferSourceNode>();
  private nextStart = 0;

  /** Browsers start audio suspended until a click; call this from the click that starts the call. */
  resume(): Promise<void> {
    return this.context.resume();
  }

  play(pcm: ArrayBuffer): void {
    const samples = pcm16ToFloat(
      new Int16Array(pcm.slice(0, pcm.byteLength - (pcm.byteLength % 2))),
    );
    if (!samples.length) return;
    const buffer = this.context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const start = Math.max(this.context.currentTime + 0.02, this.nextStart);
    source.start(start);
    this.nextStart = start + buffer.duration;
    this.playing.add(source);
    source.onended = () => this.playing.delete(source);
  }

  /** The caller interrupted: stop what is playing and drop what is queued. */
  clear(): void {
    for (const source of this.playing) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
    this.playing.clear();
    this.nextStart = 0;
  }

  close(): void {
    this.clear();
    void this.context.close();
  }
}
