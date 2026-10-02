import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

/**
 * GETs `path` (skipped when null) and keeps the last good result while
 * reloading, so live refreshes don't flash empty states.
 */
export function useGet<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const latest = useRef(path);
  latest.current = path;
  const calls = useRef(0);

  const reload = useCallback(async () => {
    if (!path) return;
    const call = ++calls.current;
    // Ignore responses for a path the caller has since moved away from, and an older
    // response that arrives after a newer one (two live refreshes close together).
    const current = () => latest.current === path && calls.current === call;
    setLoading(true);
    try {
      const result = await api<T>('GET', path);
      if (!current()) return;
      setData(result);
      setError(undefined);
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (current()) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}
