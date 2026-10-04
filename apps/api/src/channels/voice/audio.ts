/**
 * Small audio helpers for voice calls. Everything is 16-bit little-endian
 * mono PCM at one sample rate, so "audio" is a Buffer and time is a byte count.
 */

const BYTES_PER_SAMPLE = 2;

/** A 44-byte WAV header for 16-bit PCM. */
export function wavHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const h = Buffer.alloc(44);
  const blockAlign = channels * BYTES_PER_SAMPLE;
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * The samples inside a WAV file, or the buffer itself when it has no RIFF
 * header (a text-to-speech service may send either).
 */
export function pcmFromWav(audio: Buffer): Buffer {
  if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF') return audio;
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    if (id === 'data') return audio.subarray(offset + 8, Math.min(audio.length, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

/** A whole number of samples: a stray odd byte would shift every sample after it. */
export const evenBytes = (pcm: Buffer) => (pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm);

/**
 * Records a call as a stereo WAV: the caller on the left, whoever answers
 * (the AI or an agent) on the right.
 *
 * The caller's audio arrives continuously, so it is the clock. Our side is
 * generated in bursts, faster than it is played: each burst is placed where
 * the caller's clock stood when it started (or after the previous burst),
 * which is when the caller heard it. `cut()` drops what was generated but
 * not yet heard when the caller interrupts.
 */
export class CallRecorder {
  private readonly left: Buffer[] = [];
  private leftBytes = 0;
  /** Our side as (start position, audio) pairs, in byte offsets on the caller's clock. */
  private readonly right: Array<{ at: number; pcm: Buffer }> = [];
  private rightEnd = 0;
  private full = false;

  constructor(
    private readonly sampleRate: number,
    /** The recording stops growing at this length; the call itself goes on. */
    private readonly maxSeconds: number,
  ) {}

  get seconds(): number {
    return this.leftBytes / BYTES_PER_SAMPLE / this.sampleRate;
  }

  caller(pcm: Buffer): void {
    if (this.full) return;
    const chunk = evenBytes(pcm);
    this.left.push(chunk);
    this.leftBytes += chunk.length;
    if (this.seconds >= this.maxSeconds) this.full = true;
  }

  ours(pcm: Buffer): void {
    if (this.full) return;
    const chunk = evenBytes(pcm);
    const at = Math.max(this.rightEnd, this.leftBytes);
    this.right.push({ at, pcm: chunk });
    this.rightEnd = at + chunk.length;
  }

  /** The caller interrupted: anything of ours placed after "now" was never heard. */
  cut(): void {
    const now = this.leftBytes;
    while (this.right.length && this.right.at(-1)!.at >= now) this.right.pop();
    const last = this.right.at(-1);
    if (last && last.at + last.pcm.length > now) {
      last.pcm = evenBytes(last.pcm.subarray(0, now - last.at));
    }
    this.rightEnd = Math.min(this.rightEnd, now);
  }

  /** The finished recording, or null when nothing was captured. */
  wav(): Buffer | null {
    const bytes = Math.max(this.leftBytes, this.rightEnd);
    if (bytes === 0) return null;
    const left = Buffer.concat(this.left);
    const right = Buffer.alloc(bytes);
    for (const { at, pcm } of this.right) pcm.copy(right, at);
    const samples = bytes / BYTES_PER_SAMPLE;
    const data = Buffer.alloc(samples * 2 * BYTES_PER_SAMPLE);
    for (let i = 0; i < samples; i++) {
      const l = i * BYTES_PER_SAMPLE < left.length ? left.readInt16LE(i * BYTES_PER_SAMPLE) : 0;
      data.writeInt16LE(l, i * 4);
      data.writeInt16LE(right.readInt16LE(i * BYTES_PER_SAMPLE), i * 4 + 2);
    }
    return Buffer.concat([wavHeader(data.length, this.sampleRate, 2), data]);
  }
}

const SENTENCE_END = /([.!?।॥…]+["')\]]?)(\s+|$)/g;

/**
 * Splits a reply into pieces to speak one after another, so an interruption
 * discards little, and no piece is longer than the speech service accepts.
 */
export function speechChunks(text: string, maxLength = 300): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences: string[] = [];
  let from = 0;
  for (const m of clean.matchAll(SENTENCE_END)) {
    const end = m.index + m[1]!.length;
    sentences.push(clean.slice(from, end).trim());
    from = end + m[2]!.length;
  }
  if (from < clean.length) sentences.push(clean.slice(from).trim());

  const out: string[] = [];
  for (const sentence of sentences.filter(Boolean)) {
    if (sentence.length <= maxLength) {
      // Very short sentences ride along with the previous one: fewer, smoother requests.
      const last = out.at(-1);
      if (last && last.length + sentence.length + 1 <= maxLength && sentence.length < 40) {
        out[out.length - 1] = `${last} ${sentence}`;
      } else {
        out.push(sentence);
      }
      continue;
    }
    // A sentence longer than the limit is cut at spaces.
    let rest = sentence;
    while (rest.length > maxLength) {
      const cutAt = rest.lastIndexOf(' ', maxLength);
      const at = cutAt > maxLength / 2 ? cutAt : maxLength;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}
