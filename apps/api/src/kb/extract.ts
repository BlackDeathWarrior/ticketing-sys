import { convert } from 'html-to-text';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export type KbFileKind = 'pdf' | 'docx' | 'md' | 'html' | 'txt';

const BY_EXTENSION: Record<string, KbFileKind> = {
  pdf: 'pdf',
  docx: 'docx',
  md: 'md',
  markdown: 'md',
  html: 'html',
  htm: 'html',
  txt: 'txt',
};

const BY_TYPE: Record<string, KbFileKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/html': 'html',
  'text/plain': 'txt',
};

/** The file kind from its extension, then its content type; null if unsupported. */
export function detectKind(filename: string, contentType?: string | null): KbFileKind | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return (
    BY_EXTENSION[ext] ?? (contentType ? (BY_TYPE[contentType.split(';')[0]!.trim()] ?? null) : null)
  );
}

/**
 * Plain text with markdown-style headings (`# …`), which the chunker uses to
 * keep sections together and label citations.
 */
export async function extractText(content: Buffer, kind: KbFileKind): Promise<string> {
  switch (kind) {
    case 'pdf': {
      const parser = new PDFParse({ data: new Uint8Array(content) });
      try {
        const { text } = await parser.getText();
        // pdf-parse separates pages with "-- n of m --" markers.
        return normalise(text.replace(/^-- \d+ of \d+ --$/gm, ''));
      } finally {
        await parser.destroy();
      }
    }
    case 'docx': {
      const { value } = await mammoth.convertToHtml({ buffer: content });
      return htmlToText(value);
    }
    case 'html':
      return htmlToText(content.toString('utf8'));
    case 'md':
    case 'txt':
      return normalise(content.toString('utf8'));
  }
}

/** HTML to text, keeping h1–h6 as `#` headings and dropping scripts, styles and navigation. */
export function htmlToText(html: string): string {
  const marked = html.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level: string, inner: string) => `<p>${'#'.repeat(Number(level))} ${inner}</p>`,
  );
  const text = convert(marked, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'nav', format: 'skip' },
      { selector: 'footer', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
    ],
  });
  return normalise(text);
}

/** The title of an HTML page, if it has one. */
export function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
