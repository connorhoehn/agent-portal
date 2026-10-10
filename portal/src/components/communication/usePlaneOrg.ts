// The signed-in user's org context for the Communication plane
// (docs/communication-plane-goal.md §1.3–§1.4): their groups in the host
// tenant, the org teams of their linked person, each group's bound Social
// channel and page-discussion unread. Every read is a host-tenant route under
// its own gate or the grant-gated Social bindings route; "mine" is decided on
// the server from `app_users.person_id`, never from anything sent here.
//
// Mounted only for a session holding a Social grant (CommunicationPlane), so a
// session without one makes none of these requests.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFetch } from '../../hooks/useFetch';
import { useDiscussionUnread } from '../shell/useDiscussionUnread';
import {
  groupBindingContext, MINE_KIND, mineGroups, mineGroupsUrl, mineOrgTeams, orgTeamBindingContext, readBinding, readMineGroups, readPersonLink,
  type GroupBinding, type OrgTeams, type PlaneGroup, type PlaneTenant,
} from './planeRailModel';

export interface BindingFacts { binding: GroupBinding | null; canManage: boolean; joined: boolean }

export interface PlaneOrg {
  tenant: PlaneTenant;
  /** null while the link is unknown (loading or failed). */
  linked: boolean | null;
  groups: PlaneGroup[];
  groupsLoading: boolean;
  groupsError: string | null;
  orgTeams: OrgTeams | null;
  orgTeamsError: string | null;
  unreadThreads: ReadonlyArray<{ channel: string; unreadCount: number }>;
  /** Binding facts by context (`initiative:<id>`, `team:<id>`); absent = not answered. */
  bindings: ReadonlyMap<string, BindingFacts>;
  refreshGroups(): void;
  refreshBindings(): void;
}

/** One request per bindable context, refreshed on change and every minute. */
function useBindings(contexts: readonly string[]): { bindings: ReadonlyMap<string, BindingFacts>; refresh(): void } {
  const key = [...contexts].sort().join('|');
  const [bindings, setBindings] = useState<ReadonlyMap<string, BindingFacts>>(new Map());
  const [tick, setTick] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const list = key ? key.split('|') : [];
    const mine = ++generation.current;
    const controller = new AbortController();
    if (list.length === 0) { setBindings(new Map()); return () => controller.abort(); }
    void Promise.all(list.map(async (context) => {
      try {
        const res = await fetch(`/api/social/bindings?context=${encodeURIComponent(context)}`, { credentials: 'include', signal: controller.signal });
        if (!res.ok) return null;
        const facts = readBinding(await res.json());
        return facts ? [context, facts] as const : null;
      } catch { return null; }
    })).then((rows) => {
      if (generation.current !== mine) return;
      setBindings(new Map(rows.filter((r): r is readonly [string, BindingFacts] => !!r)));
    });
    const timer = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [key, tick]);
  return useMemo(() => ({ bindings, refresh: () => setTick((n) => n + 1) }), [bindings]);
}

export function usePlaneOrg(tenant: PlaneTenant): PlaneOrg {
  const person = useFetch<unknown>('/api/session/person', 120_000, { share: true });
  const link = readPersonLink(person.data);
  // orgiq: initiatives the linked person owns or contributes to; assessment: the teams the assessor holds a
  // membership row on; pipelines: the definitions the author owns or last edited. One route, one shape
  // (GET /api/me/groups?kind=); "mine" is decided on the server.
  const groupsFetch = useFetch<unknown>(mineGroupsUrl(MINE_KIND[tenant]), 120_000);
  const groups = useMemo(() => mineGroups(readMineGroups(groupsFetch.data)), [groupsFetch.data]);
  const teamsFetch = useFetch<unknown>(tenant === 'orgiq' ? mineGroupsUrl('org-team') : null, 120_000);
  const orgTeams = useMemo(() => mineOrgTeams(readMineGroups(teamsFetch.data)), [teamsFetch.data]);
  const unread = useDiscussionUnread();
  const contexts = useMemo(() => [
    ...groups.map(groupBindingContext).filter((c): c is string => !!c),
    ...(orgTeams?.teams ?? []).map((t) => orgTeamBindingContext(t.id)),
  ], [groups, orgTeams]);
  const { bindings, refresh } = useBindings(contexts);
  return {
    tenant,
    // Only orgiq's groups come through the person link; an assessor or author needs none.
    linked: tenant === 'orgiq' && link ? link.linked : null,
    groups,
    groupsLoading: groupsFetch.isLoading && !groupsFetch.data,
    groupsError: groupsFetch.error,
    orgTeams,
    orgTeamsError: tenant === 'orgiq' ? teamsFetch.error : null,
    unreadThreads: unread.threads,
    bindings,
    refreshGroups: groupsFetch.refresh,
    refreshBindings: refresh,
  };
}
