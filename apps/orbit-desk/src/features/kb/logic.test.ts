import { describe, expect, it } from 'vitest';
import { formatBytes, indexLabel, quoteForReply, statusActions } from './logic';

describe('knowledge base helpers', () => {
  it('describes the index state', () => {
    expect(indexLabel({ indexState: 'indexed', chunkCount: 1, indexMode: 'hybrid' })).toBe(
      'Indexed · 1 chunk',
    );
    expect(indexLabel({ indexState: 'indexed', chunkCount: 4, indexMode: 'keyword' })).toBe(
      'Keyword search only · 4 chunks',
    );
    expect(indexLabel({ indexState: 'indexing', chunkCount: 0, indexMode: null })).toBe(
      'Indexing…',
    );
    expect(indexLabel({ indexState: 'failed', chunkCount: 0, indexMode: null })).toBe(
      'Indexing failed',
    );
  });

  it('offers the review steps that make sense from each status', () => {
    expect(statusActions('draft').map((a) => a.to)).toEqual(['approved', 'archived']);
    expect(statusActions('approved').map((a) => a.to)).toEqual(['draft', 'archived']);
    expect(statusActions('archived').map((a) => a.to)).toEqual(['draft']);
  });

  it('quotes a result for a reply with its source', () => {
    expect(
      quoteForReply({
        snippet: '…refunds take 5 to 7 days…',
        citation: { label: 'Returns › Refund timing', url: null },
      }),
    ).toBe('refunds take 5 to 7 days\n\n(Source: Returns › Refund timing)');
  });

  it('formats file sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(20_480)).toBe('20 KB');
    expect(formatBytes(3_500_000)).toBe('3.3 MB');
    expect(formatBytes(null)).toBe('');
  });
});
