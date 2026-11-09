// The frames of a run's event stream (G37 Logging's Pipelines source):
// GET …/runs/:id/events is text/event-stream that replays the run's recorded
// history and then folds in live frames. Each connection replays everything,
// so a reconnect starts the list again rather than doubling it. Null until the
// stream opens (the record then shows the steps' own marks).

import { useEffect, useState } from 'react';
import type { PipelineFrame } from './pipelinesLogModel';

/** Most frames kept: a long-lived run's heartbeats would otherwise grow without end. */
const MAX_FRAMES = 500;

export function useEventFrames(url: string | null): PipelineFrame[] | null {
  const [frames, setFrames] = useState<PipelineFrame[] | null>(null);
  useEffect(() => {
    setFrames(null);
    if (!url || typeof EventSource === 'undefined') return;
    const es = new EventSource(url);
    es.onopen = () => setFrames([]);
    es.onmessage = (ev: MessageEvent<string>) => {
      let frame: PipelineFrame | null = null;
      try { frame = JSON.parse(ev.data) as PipelineFrame; } catch { frame = null; }
      if (!frame || typeof frame.type !== 'string') return;
      setFrames((prev) => [...(prev ?? []), frame!].slice(-MAX_FRAMES));
    };
    return () => es.close();
  }, [url]);
  return frames;
}
