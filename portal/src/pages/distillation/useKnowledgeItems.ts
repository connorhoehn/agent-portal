// The Knowledge explorer's feed: GET /api/distillation/items for one tier,
// server-filtered by repo / initiative / q, paged with the server cursor
// ("Load more") — never a client-side numbered table. `total` is the
// server's count for the filtered query when it sends one; null otherwise.
//
// Live: pass the tier's `version` (its digest from the `distill:levels`
// frame or poll). When it moves, page 1 is read again in place — no loading
// flash, the rows already loaded beyond it are kept — and the ids that were
// not on screen before come back in `fresh`, so the list can mark them and
// announce them. A new scope (level / repo / initiative / q) is a fresh load,
// where nothing is "new".
import { useCallback, useEffect, useRef, useState } from 'react';
import { freshIds } from './knowledgeModel';
import { itemsQueryParams } from './distillationFormat';
import type { Item, ItemsResponse, Level } from './types';

export interface KnowledgeItemsQuery {
  level: Level;
  repo: string | null;
  initiative: string | null;
  q: string | null;
  /** The tier's digest; a change re-reads page 1 in place. */
  version?: string | null;
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
  /** Ids a live refresh brought in since this scope loaded. */
  fresh: ReadonlySet<string>;
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
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const { level, repo, initiative, q, version } = query;
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // A new scope never shows the previous scope's rows while it loads.
    loadedRef.current = false;
    setLoading(true); setError(null); setItems([]); setCursor(null); setTotal(null); setFresh(new Set());
    read(url({ level, repo, initiative, q }))
      .then((body) => {
        if (cancelled) return;
        setItems(body.items ?? []);
        setCursor(body.next_cursor ?? null);
        setTotal(typeof body.total === 'number' ? body.total : null);
        loadedRef.current = true;
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Fetch failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [level, repo, initiative, q, nonce]);

  // The tier moved: read page 1 again and fold it over what is loaded.
  useEffect(() => {
    if (!version || !loadedRef.current) return;
    let cancelled = false;
    read(url({ level, repo, initiative, q }))
      .then((body) => {
        if (cancelled) return;
        const page = body.items ?? [];
        const before = itemsRef.current;
        const arrived = freshIds(before, page);
        const onPage = new Set(page.map((i) => i.id));
        const kept = before.filter((i) => !onPage.has(i.id));
        setItems([...page, ...kept]);
        // Rows past page 1 were loaded with the old cursor, which still points
        // past them; with only page 1 loaded the new cursor is the right one.
        if (kept.length === 0) setCursor(body.next_cursor ?? null);
        if (typeof body.total === 'number') setTotal(body.total);
        if (arrived.size > 0) setFresh((prev) => new Set([...prev, ...arrived]));
      })
      .catch(() => { /* the next version, poll or Retry tries again */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

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

  return { items, total, hasMore: cursor != null, loading, loadingMore, error, loadMore, retry, fresh };
}
