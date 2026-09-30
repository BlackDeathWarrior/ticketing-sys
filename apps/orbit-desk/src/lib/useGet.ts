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

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const result = await api<T>('GET', path);
      // Ignore responses for a path the caller has since moved away from.
      if (latest.current !== path) return;
      setData(result);
      setError(undefined);
    } catch (err) {
      if (latest.current === path) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (latest.current === path) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}
