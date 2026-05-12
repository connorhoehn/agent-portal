import { useState, useEffect, useCallback } from 'react';

interface UseFetchReturn<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useFetch<T>(url: string, pollIntervalMs?: number): UseFetchReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setIsLoading(false);
    }
  }, [url]);

  useEffect(() => {
    fetchData();
    if (pollIntervalMs && pollIntervalMs > 0) {
      const id = setInterval(fetchData, pollIntervalMs);
      return () => clearInterval(id);
    }
  }, [fetchData, pollIntervalMs]);

  return { data, isLoading, error, refresh: fetchData };
}
