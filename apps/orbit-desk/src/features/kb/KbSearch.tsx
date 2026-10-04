import type { KbSearchHit, KbSearchResult } from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api, openFile, qs } from '../../api/client';
import { Badge, Button, SearchField } from '../../components/ui';
import styles from './Kb.module.css';
import { quoteForReply, VISIBILITY_LABELS } from './logic';

interface KbSearchProps {
  id: string;
  initialQuery?: string;
  /** Show only public documents (what may be quoted to customers). */
  customerSafe?: boolean;
  /** When set, public results offer "Insert" to paste them into a reply. */
  onInsert?: (text: string) => void;
  limit?: number;
}

/** Knowledge-base search with citations (GET /kb/search). */
export function KbSearch({
  id,
  initialQuery = '',
  customerSafe,
  onInsert,
  limit = 5,
}: KbSearchProps) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<KbSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api<KbSearchResult>(
          'GET',
          `/kb/search${qs({ q, limit, audience: customerSafe ? 'customer' : undefined })}`,
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <form className={styles.searchRow} onSubmit={run} role="search">
        <SearchField
          id={id}
          aria-label="Search the knowledge base"
          placeholder="Search policies and FAQs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" disabled={busy || !query.trim()}>
          Search
        </Button>
      </form>
      {error && <p className={styles.error}>{error}</p>}
      {result && !result.hits.length && (
        <p className={styles.note} role="status">
          Nothing in the knowledge base matches “{result.query}”.
        </p>
      )}
      {result && result.hits.length > 0 && (
        <ol className={styles.hits} aria-label="Knowledge base results">
          {result.hits.map((hit) => (
            <Hit key={hit.chunkId} hit={hit} onInsert={onInsert} />
          ))}
        </ol>
      )}
      {result?.mode === 'keyword' && result.hits.length > 0 && (
        <p className={styles.note}>Keyword matches only: no embedding model is configured.</p>
      )}
    </div>
  );
}

function Hit({ hit, onInsert }: { hit: KbSearchHit; onInsert?: (text: string) => void }) {
  return (
    <li className={styles.hit}>
      <div className={styles.hitHead}>
        <span className={styles.hitTitle}>{hit.title}</span>
        {hit.section && <span className={styles.hitSection}>{hit.section}</span>}
        {hit.visibility !== 'public' && <Badge>{VISIBILITY_LABELS[hit.visibility]}</Badge>}
      </div>
      <p className={styles.snippet}>{hit.snippet}</p>
      <div className={styles.hitFoot}>
        <span>
          {hit.citation.url?.startsWith('/api/') ? (
            <button
              type="button"
              className={styles.link}
              onClick={() => void openFile(hit.citation.url!)}
            >
              Open source
            </button>
          ) : hit.citation.url ? (
            <a className={styles.link} href={hit.citation.url} target="_blank" rel="noreferrer">
              Open source
            </a>
          ) : (
            'From the knowledge base'
          )}
          {hit.similarity !== null && <> · {Math.round(hit.similarity * 100)}% similar</>}
        </span>
        {onInsert && hit.visibility === 'public' && (
          <Button size="sm" variant="ghost" onClick={() => onInsert(quoteForReply(hit))}>
            Insert in reply
          </Button>
        )}
      </div>
    </li>
  );
}
