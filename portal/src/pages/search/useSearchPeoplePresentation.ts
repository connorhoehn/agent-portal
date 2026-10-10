import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../../lib/auth';
import { useEmbeddedSocial } from '../../components/shell/EmbeddedSocial';
import { presentSearchPerson, readSearchPersonAvatars, readSearchPersonUsers,
  type SearchPersonAvatar, type SearchPersonUser } from './peopleSearchModel';
import type { SearchRecord } from './searchTypes';

interface PeopleSnapshot { key: string; avatars: SearchPersonAvatar[]; users: SearchPersonUser[] }

/** Reuses the shell's ONE presence subscription. The directory ID mapping is
 * authorized in the active tenant; no display-name or person-ID guessing. */
export function useSearchPeoplePresentation(records: readonly SearchRecord[]): SearchRecord[] {
  const { session, sessionStatus } = useSession();
  const social = useEmbeddedSocial();
  const personIds = [...new Set(records.filter(record => record.type === 'person').map(record => record.id))].sort().slice(0, 50).join(',');
  const needsAvatars = records.some(record => record.type === 'person' && !record.avatarUrl?.trim());
  const actorKey = session && sessionStatus === 'ready' ? JSON.stringify([
    session.sub, session.tenant, session.role, session.masquerading?.actor, session.masquerading?.asUser,
  ]) : null;
  const presenceReady = !!actorKey && !!social?.presenceReady && social.actorId === session?.sub;
  const key = JSON.stringify([actorKey, personIds, needsAvatars, presenceReady ? social?.state.snapshot?.authorityKey : null]);
  const [snapshot, setSnapshot] = useState<PeopleSnapshot | null>(null);

  useEffect(() => {
    if (!actorKey || !personIds) return;
    let live = true;
    const controller = new AbortController();
    const read = async (url: string): Promise<unknown> => {
      try {
        const response = await fetch(url, { credentials: 'include', signal: controller.signal });
        return response.ok ? await response.json() : null;
      } catch { return null; }
    };
    // Portraits already exist on the authorized graph endpoint. This fallback
    // also works before the backend's additive search projection is activated.
    void Promise.all([
      needsAvatars ? read('/api/graph/entities') : Promise.resolve(null),
      presenceReady ? read(`/api/roster/users?personIds=${encodeURIComponent(personIds)}`) : Promise.resolve(null),
    ]).then(([graph, mapping]) => {
      if (live) setSnapshot({ key, avatars: readSearchPersonAvatars(graph), users: readSearchPersonUsers(mapping) });
    });
    return () => { live = false; controller.abort(); };
  }, [key, actorKey, personIds, needsAvatars, presenceReady]);

  return useMemo(() => records.map(record => presentSearchPerson(record, {
    avatars: snapshot?.key === key ? snapshot.avatars : [],
    users: snapshot?.key === key ? snapshot.users : [],
    present: presenceReady ? social?.presencePeople ?? [] : [],
    presenceReady,
  })), [records, snapshot, key, presenceReady, social?.presencePeople]);
}
