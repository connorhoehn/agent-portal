// A clock that ticks only while something on screen is actually live.
//
// Elapsed labels ("running 1m 04s") have to re-render to stay true, but a
// page-wide interval that runs forever is the thing the request-budget pass
// spent a day removing. So this ticks on one condition — `active` — and stops
// dead otherwise, and it pauses with the tab like `useFetch`'s polls do: a
// backgrounded tab cannot be read, and re-reading the clock once on return is
// enough to be correct again.
import { useEffect, useState } from 'react';
import { isDocumentHidden } from './pollSchedule';

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    let id: number | undefined;
    const stop = () => { if (id !== undefined) { window.clearInterval(id); id = undefined; } };
    const start = () => {
      stop();
      if (isDocumentHidden()) return;
      setNow(Date.now());
      id = window.setInterval(() => setNow(Date.now()), intervalMs);
    };
    const onVisibility = () => { start(); };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [active, intervalMs]);

  return now;
}
