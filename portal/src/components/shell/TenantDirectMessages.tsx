// The shell's tenant presence for a session WITHOUT a Social grant. It announces
// the session on the tenant lobby (`<tenant>:lobby`) so voice `set_status` and
// the activity read have a presence entry (tenantPresence.ts), and draws
// nothing: the footer shows only what the tenant and the grant give a person
// (UX walk D, 9 November 2026). The old visible "Messages N online" entry opened
// a read-only overview whose only action was to leave for another workspace,
// so an ungranted user in Pipelines or Access saw a Social door they could not use.

import { useEffect, useMemo } from 'react';
import { useGatewayOptional, usePresence } from '@connorhoehn/realtime-modules/client';
import { useFetch } from '../../hooks/useFetch';
import { onlineIds, readSharedPeople, type SharedPeople } from './tenantDirectModel';
import { tenantLobbyPresence } from './tenantPresence';

/** Announces this session on the tenant lobby; mounted only while connected. */
function TenantLobby({ directory }: { directory: SharedPeople }) {
  const { roster, setStatus, updateMetadata } = usePresence(directory.lobby, { join: true });
  const ids = useMemo(() => onlineIds(roster, directory.people), [roster, directory]);
  // Who is online and this announcement's writers, for the voice dock (activity, set_status; read at call time).
  useEffect(() => {
    tenantLobbyPresence.set({
      lobby: directory.lobby, online: directory.people.filter(p => ids.has(p.userId)).map(p => ({ userId: p.userId, name: p.displayName })),
      setStatus, updateMetadata,
    });
  }, [directory, ids, setStatus, updateMetadata]);
  useEffect(() => () => tenantLobbyPresence.set(null), []);
  return null;
}

export function TenantPresenceAnnouncement() {
  const gateway = useGatewayOptional();
  const connected = gateway?.connectionState === 'connected';
  const fetched = useFetch<unknown>('/api/people/shared', 60_000);
  const directory = useMemo(() => readSharedPeople(fetched.data), [fetched.data]);
  return directory && connected ? <TenantLobby key={`presence:${directory.lobby}`} directory={directory} /> : null;
}
