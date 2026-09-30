import type { KbDocumentView, KbSearchHit, KbStatus, KbVisibility } from '@tms/shared';

export const VISIBILITY_LABELS: Record<KbVisibility, string> = {
  public: 'Public',
  internal: 'Internal',
  team: 'Team only',
};

export const STATUS_LABELS: Record<KbStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  archived: 'Archived',
};

export const SOURCE_LABELS = { file: 'File', url: 'Web page', faq: 'FAQ', text: 'Text' } as const;

/** Indexing state in words, e.g. "Indexed · 4 chunks" or "Keyword search only". */
export function indexLabel(
  d: Pick<KbDocumentView, 'indexState' | 'chunkCount' | 'indexMode'>,
): string {
  switch (d.indexState) {
    case 'pending':
      return 'Waiting to index';
    case 'indexing':
      return 'Indexing…';
    case 'failed':
      return 'Indexing failed';
    case 'indexed': {
      const chunks = `${d.chunkCount} ${d.chunkCount === 1 ? 'chunk' : 'chunks'}`;
      return d.indexMode === 'keyword' ? `Keyword search only · ${chunks}` : `Indexed · ${chunks}`;
    }
  }
}

/** Status transitions a manager can make from each review status. */
export function statusActions(status: KbStatus): Array<{ to: KbStatus; label: string }> {
  if (status === 'draft')
    return [
      { to: 'approved', label: 'Approve' },
      { to: 'archived', label: 'Archive' },
    ];
  if (status === 'approved')
    return [
      { to: 'draft', label: 'Back to draft' },
      { to: 'archived', label: 'Archive' },
    ];
  return [{ to: 'draft', label: 'Restore as draft' }];
}

/** Text an agent can paste into a reply, with where it came from. */
export function quoteForReply(hit: Pick<KbSearchHit, 'snippet' | 'citation'>): string {
  const text = hit.snippet.replace(/^…/, '').replace(/…$/, '').trim();
  return `${text}\n\n(Source: ${hit.citation.label})`;
}

export function formatBytes(n: number | null): string {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
