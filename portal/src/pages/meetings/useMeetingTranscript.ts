// A meeting's transcript, read a page at a time (`after` / `limit` on the transcript route). Never polls: a finished meeting does not change.
import { useCallback, useEffect, useRef, useState } from 'react';
import { TRANSCRIPT_PAGE, transcriptUrl, type TranscriptLineView } from './meetingsModel';

export interface MeetingTranscript {
  lines: TranscriptLineView[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
}

export function useMeetingTranscript(callId: string | null): MeetingTranscript {
  const [lines, setLines] = useState<TranscriptLineView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const cursor = useRef(0);
  const generation = useRef(0);

  const loadPage = useCallback(async (id: string) => {
    const mine = generation.current;
    setLoading(true);
    try {
      const res = await fetch(transcriptUrl(id, cursor.current, TRANSCRIPT_PAGE), { credentials: 'include' });
      if (!res.ok) throw new Error(res.status === 404 ? 'There is no transcript for this meeting.' : `The transcript could not be read (${res.status}).`);
      const body = await res.json() as { lines: TranscriptLineView[]; next: number };
      if (mine !== generation.current) return;
      cursor.current = body.next;
      setLines((prev) => [...prev, ...body.lines]);
      setHasMore(body.lines.length === TRANSCRIPT_PAGE);
      setError(null);
    } catch (e) {
      if (mine === generation.current) setError(e instanceof Error ? e.message : 'The transcript could not be read.');
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    cursor.current = 0;
    setLines([]); setHasMore(false); setError(null);
    if (callId) void loadPage(callId);
  }, [callId, loadPage]);

  const loadMore = useCallback(() => { if (callId && !loading) void loadPage(callId); }, [callId, loading, loadPage]);
  return { lines, loading, error, hasMore, loadMore };
}
