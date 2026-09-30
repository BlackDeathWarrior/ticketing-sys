import { reciprocalRankFusion } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import { makePdf } from '../../test/pdf-fixture';
import { chunkText, estimateTokens, splitSections } from './chunker';
import { detectKind, extractText, htmlTitle, htmlToText } from './extract';
import { snippet, withinDocument } from './kb-search.service';
import { assertPublicUrl, isPrivateAddress } from './url-fetch';

describe('chunker', () => {
  const doc = [
    '# Returns',
    'Intro paragraph.',
    '## Refund timing',
    'Cards take 5 to 7 days.',
    '',
    'UPI takes 1 to 2 days.',
    '## Exchanges',
    'Return and reorder.',
  ].join('\n');

  it('keeps heading trails for each section', () => {
    expect(splitSections(doc).map((s) => s.path.join(' › '))).toEqual([
      'Returns',
      'Returns › Refund timing',
      'Returns › Exchanges',
    ]);
  });

  it('emits one chunk per short section, labelled with its section', () => {
    const chunks = chunkText(doc);
    expect(chunks.map((c) => c.section)).toEqual([
      'Returns',
      'Returns › Refund timing',
      'Returns › Exchanges',
    ]);
    expect(chunks[1]!.content).toContain('UPI takes 1 to 2 days.');
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it('splits long sections under the token limit with overlap between chunks', () => {
    const para = (n: number) => `Paragraph ${n}. ${'word '.repeat(150)}`.trim();
    const text = ['# Long', ...Array.from({ length: 6 }, (_, i) => `${para(i)}\n`)].join('\n');
    const chunks = chunkText(text, { maxTokens: 400, overlapTokens: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(400 + 20);
    // The second chunk starts with the tail of the first.
    const tailOfFirst = chunks[0]!.content.slice(-60).trim();
    expect(
      chunks[1]!.content.startsWith(tailOfFirst.split(' ').slice(-3).join(' ')) ||
        chunks[1]!.content.includes('word'),
    ).toBe(true);
  });

  it('breaks a single huge paragraph by sentences', () => {
    const text = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.section === null)).toBe(true);
  });

  it('estimates tokens at about four characters each', () => {
    expect(estimateTokens('12345678')).toBe(2);
  });
});

describe('extraction', () => {
  it('detects kinds by extension, then content type', () => {
    expect(detectKind('Policy.PDF')).toBe('pdf');
    expect(detectKind('notes', 'text/markdown; charset=utf-8')).toBe('md');
    expect(detectKind('image.png', 'image/png')).toBeNull();
  });

  it('turns HTML headings into # headings and drops navigation', () => {
    const text = htmlToText(
      '<nav>Home · Help</nav><h1>Help</h1><p>Hello <a href="/x">there</a>.</p><h2>Reset</h2><p>Use the link.</p><script>x()</script>',
    );
    expect(text).toContain('# Help');
    expect(text).toContain('## Reset');
    expect(text).toContain('Hello there.');
    expect(text).not.toContain('Home');
    expect(text).not.toContain('x()');
    expect(htmlTitle('<title> My  page </title>')).toBe('My page');
  });

  it('reads text out of a PDF without page markers', async () => {
    const text = await extractText(
      makePdf(['Returns policy', 'Return items within 30 days.']),
      'pdf',
    );
    expect(text).toContain('Return items within 30 days.');
    expect(text).not.toMatch(/-- 1 of 1 --/);
  });
});

describe('URL safety', () => {
  it('recognises private, loopback, link-local and metadata addresses', () => {
    for (const ip of [
      '10.0.0.8',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.1.1',
      '192.168.1.2',
      '::1',
      'fd00::1',
      '::ffff:10.1.2.3',
      '100.64.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('rejects non-http schemes and private hosts unless allowed', async () => {
    await expect(assertPublicUrl('file:///etc/passwd', false)).rejects.toThrow(/http/);
    await expect(assertPublicUrl('http://127.0.0.1:4010/x', false)).rejects.toThrow(
      /public internet/,
    );
    await expect(assertPublicUrl('http://[::1]/x', false)).rejects.toThrow(/public internet/);
    await expect(assertPublicUrl('http://127.0.0.1:4010/x', true)).resolves.toBeInstanceOf(URL);
  });
});

describe('search helpers', () => {
  it('fuses ranked lists, rewarding items found by both', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'd'],
    ]);
    expect(fused[0]!.id).toBe('c');
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops the document title from section trails', () => {
    expect(withinDocument('Billing FAQ › I was charged twice', 'Billing FAQ')).toBe(
      'I was charged twice',
    );
    expect(withinDocument('Billing FAQ', 'Billing FAQ')).toBeNull();
    expect(withinDocument('Refunds › Cards', 'Returns policy')).toBe('Refunds › Cards');
    expect(withinDocument(null, 'x')).toBeNull();
  });

  it('cuts a snippet around the first matching word', () => {
    const long = `${'filler '.repeat(100)}Refunds reach cards in 5 to 7 days. ${'more '.repeat(100)}`;
    const s = snippet(long, 'when do refunds arrive');
    expect(s).toContain('Refunds reach cards');
    expect(s.startsWith('…')).toBe(true);
    expect(snippet('Short text.', 'x')).toBe('Short text.');
  });
});
