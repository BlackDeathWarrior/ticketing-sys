/**
 * Heading-aware chunking. Markdown-style headings (`#` … `######`) start new
 * sections; each chunk stays inside one section and carries its heading
 * trail, so search results cite "Refunds › Card payments" rather than a page
 * number. Long sections are packed paragraph by paragraph up to `maxTokens`,
 * with the tail of the previous chunk repeated as overlap so an answer that
 * straddles a boundary is still found.
 */

export interface Chunk {
  ordinal: number;
  section: string | null;
  content: string;
  tokens: number;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

/** Rough token count (about four characters per token for English). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

interface Section {
  path: string[];
  paragraphs: string[];
}

export function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let current: Section = { path: [], paragraphs: [] };
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const p = paragraph.join('\n').trim();
    if (p) current.paragraphs.push(p);
    paragraph = [];
  };
  const flushSection = () => {
    flushParagraph();
    if (current.paragraphs.length) sections.push(current);
  };

  for (const line of text.split('\n')) {
    const h = HEADING.exec(line.trim());
    if (h) {
      flushSection();
      const level = h[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: h[2]!.trim() });
      current = { path: stack.map((s) => s.title), paragraphs: [] };
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushSection();
  return sections;
}

/** Splits text that is too long on its own: sentences first, then words. */
function splitLong(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const sentences = text.match(/[^.!?।\n]+[.!?।]*\s*/g) ?? [text];
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (estimateTokens(s) > maxTokens) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      const words = s.split(/\s+/);
      let w = '';
      for (const word of words) {
        if (estimateTokens(`${w} ${word}`) > maxTokens && w) {
          out.push(w.trim());
          w = '';
        }
        w += `${word} `;
      }
      if (w.trim()) out.push(w.trim());
      continue;
    }
    if (estimateTokens(buf + s) > maxTokens && buf.trim()) {
      out.push(buf.trim());
      buf = '';
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** The last ~`tokens` worth of text, starting at a word boundary. */
function tail(text: string, tokens: number): string {
  if (tokens <= 0) return '';
  const chars = tokens * 4;
  if (text.length <= chars) return text;
  const cut = text.slice(-chars);
  const space = cut.indexOf(' ');
  return space >= 0 ? cut.slice(space + 1) : cut;
}

export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? 600;
  const overlap = Math.min(opts.overlapTokens ?? 80, Math.floor(maxTokens / 4));
  const chunks: Chunk[] = [];

  for (const section of splitSections(text)) {
    const name = section.path.length ? section.path.join(' › ') : null;
    const pieces = section.paragraphs.flatMap((p) => splitLong(p, maxTokens - overlap));
    let buf: string[] = [];
    let carry = '';
    const emit = () => {
      const body = buf.join('\n\n').trim();
      if (!body) return;
      const content = carry ? `${carry}\n\n${body}` : body;
      chunks.push({
        ordinal: chunks.length,
        section: name,
        content,
        tokens: estimateTokens(content),
      });
      carry = tail(body, overlap);
      buf = [];
    };
    for (const piece of pieces) {
      const size = estimateTokens([...buf, piece].join('\n\n')) + estimateTokens(carry);
      if (size > maxTokens && buf.length) emit();
      buf.push(piece);
    }
    emit();
  }
  return chunks;
}
