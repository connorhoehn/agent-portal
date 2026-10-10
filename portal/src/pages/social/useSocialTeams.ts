import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { isDocumentHidden, nextPollDelay } from '../../hooks/pollSchedule';
import { SocialTeamPreferences } from './socialTeamPreferences';

/** Account-scoped list; polling follows the shared visibility/backoff policy. */
export function useSocialTeams(scope: string, userId: string, api = '/api/social') {
  const model = useMemo(() => new SocialTeamPreferences(userId, Date.now, api), [scope, userId, api]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
  useEffect(() => {
    model.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;
    let pollVersion = 0;
    const poll = async () => {
      const version = ++pollVersion;
      if (timer) clearTimeout(timer);
      await model.refresh();
      if (stopped || version !== pollVersion) return;
      failures = model.getSnapshot().error ? failures + 1 : 0;
      if (!isDocumentHidden()) timer = setTimeout(() => { void poll(); }, nextPollDelay(failures, 30_000));
    };
    const visibility = () => {
      if (timer) clearTimeout(timer);
      pollVersion += 1;
      if (!isDocumentHidden()) void poll();
    };
    document.addEventListener('visibilitychange', visibility);
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      model.stop();
    };
  }, [model]);
  return { ...snapshot, refresh: model.refresh, model };
}
