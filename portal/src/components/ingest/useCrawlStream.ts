import { useEffect, useState } from 'react';
import type { CrawlEvent, CrawlSession } from './types';

/**
 * Subscribe to GET /api/ingest/crawl/:id/stream and reduce CrawlEvent messages
 * into the current CrawlSession snapshot.
 *
 * Every event carries the authoritative `session` object — we just replace
 * state on each message. `done` flips true on completed/failed/cancelled, and
 * the EventSource is closed.
 */
export function useCrawlStream(crawlId: string | null): {
  session: CrawlSession | null;
  done: boolean;
} {
  const [session, setSession] = useState<CrawlSession | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!crawlId) {
      setSession(null);
      setDone(false);
      return;
    }

    setDone(false);
    const es = new EventSource(`/api/ingest/crawl/${encodeURIComponent(crawlId)}/stream`);

    es.onmessage = (evt: MessageEvent) => {
      let msg: CrawlEvent;
      try {
        msg = JSON.parse(evt.data) as CrawlEvent;
      } catch {
        return;
      }
      setSession(msg.session);
      if (msg.type === 'completed' || msg.type === 'failed' || msg.type === 'cancelled') {
        setDone(true);
        es.close();
      }
    };

    es.onerror = () => {
      setDone(true);
      es.close();
    };

    return () => es.close();
  }, [crawlId]);

  return { session, done };
}
