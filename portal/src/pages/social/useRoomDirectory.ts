import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFetch } from '../../hooks/useFetch';
import type { RoomsFetch, RoomsResponse } from './SocialRoomsSection';
import type { SocialRoom } from './socialPlatform';

/** Preserve the upstream cursor; a filtered first page is not the whole directory. */
export function useRoomDirectory(api: string, selected: string | null): RoomsFetch {
  const first = useFetch<RoomsResponse>(`${api}/rooms`, 15_000);
  const detail = useFetch<{ room: SocialRoom }>(selected ? `${api}/rooms/${encodeURIComponent(selected)}` : null, 15_000);
  const [older, setOlder] = useState<SocialRoom[]>([]);
  const [next, setNext] = useState<string | null | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setOlder([]); setNext(undefined); setError(null); }, [api]);
  const cursor = next === undefined ? first.data?.cursor : next;
  const data = useMemo(() => {
    if (!first.data) return null;
    // A prior detail response can remain cached while the URL changes. Only
    // use the selected record, and never resurrect denied/deleted detail from
    // a previously loaded directory page.
    const unavailable = detail.failure && [401, 403, 404, 410].includes(detail.failure.status ?? 0);
    const selectedRoom = !detail.error && detail.data?.room.slug === selected ? [detail.data.room] : [];
    const rooms = [...selectedRoom, ...first.data.rooms, ...older]
      .filter(r => !(unavailable && r.slug === selected))
      .filter((r, i, all) => all.findIndex(s => s.slug === r.slug) === i);
    return { ...first.data, rooms, cursor: cursor ?? undefined };
  }, [first.data, detail.data, detail.error, detail.failure, selected, older, cursor]);
  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true); setError(null);
    try {
      const response = await fetch(`${api}/rooms?cursor=${encodeURIComponent(cursor)}`, { credentials: 'include' });
      if (!response.ok) throw new Error('More hangouts could not be loaded. Try again.');
      const page = await response.json() as RoomsResponse;
      setOlder(value => [...value, ...page.rooms]); setNext(page.cursor ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Directory unavailable'); }
    finally { setLoadingMore(false); }
  }
  const refresh = useCallback(() => { first.refresh(); detail.refresh(); setOlder([]); setNext(undefined); setError(null); }, [first.refresh, detail.refresh]);
  return { data,
    isLoading: first.isLoading || (!!selected && detail.isLoading), error: first.error ?? detail.error ?? error,
    refresh,
    ...(cursor ? { loadMore: () => void loadMore() } : {}), loadingMore };
}
