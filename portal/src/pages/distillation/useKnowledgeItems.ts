// The Knowledge explorer's feed: GET /api/distillation/items for one tier,
// server-filtered by repo / initiative / q, paged with the server cursor
// ("Load more") — never a client-side numbered table. `total` is the
// server's count for the filtered query when it sends one; null otherwise.
import { useCallback, useEffect, useState } from 'react';
import { itemsQueryParams } from './distillationFormat';
import type { Item, ItemsResponse, Level } from './types';

export interface KnowledgeItemsQuery {
  level: Level;
  repo: string | null;
  initiative: string | null;
  q: string | null;
}

export interface KnowledgeItems {
  items: Item[];
  total: number | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
  retry: () => void;
}

function url(query: KnowledgeItemsQuery, cursor?: string): string {
  const p = new URLSearchParams(itemsQueryParams({
    level: query.level,
    repo: query.repo ?? undefined,
    initiativeId: query.initiative ?? undefined,
    q: query.q ?? undefined,
    cursor,
  }));
  return `/api/distillation/items?${p.toString()}`;
}

async function read(u: string): Promise<ItemsResponse> {
  const res = await fetch(u, { credentials: 'include' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ItemsResponse;
}

export function useKnowledgeItems(query: KnowledgeItemsQuery): KnowledgeItems {
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const { level, repo, initiative, q } = query;

  useEffect(() => {
    let cancelled = false;
    // A new scope never shows the previous scope's rows while it loads.
    setLoading(true); setError(null); setItems([]); setCursor(null); setTotal(null);
    read(url({ level, repo, initiative, q }))
      .then((body) => {
        if (cancelled) return;
        setItems(body.items ?? []);
        setCursor(body.next_cursor ?? null);
        setTotal(typeof body.total === 'number' ? body.total : null);
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Fetch failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [level, repo, initiative, q, nonce]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    read(url({ level, repo, initiative, q }, cursor))
      .then((body) => {
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...(body.items ?? []).filter((i) => !seen.has(i.id))];
        });
        setCursor(body.next_cursor ?? null);
        if (typeof body.total === 'number') setTotal(body.total);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Fetch failed'))
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, level, repo, initiative, q]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { items, total, hasMore: cursor != null, loading, loadingMore, error, loadMore, retry };
}
