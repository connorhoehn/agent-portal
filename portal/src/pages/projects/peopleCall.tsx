// Start a call with the people a page is about (docs/social-calls-plan.md
// steps 5–6): an initiative's owner + SMEs (InitiativeCall.tsx), or the people
// selected on Search (pages/search/SearchComposer.tsx).
//
// Who is rung: those people, mapped person → user by GET /api/roster/users
// (tenant-scoped), minus you. The lobby is the tenant-prefixed dm lobby of you
// + them, so whoever rings first, the same people land in the same
// platform-api session. The call itself lives in InitiativeCallHost (the /iq
// shell); this hook binds the page's lobby to it and draws it: a Start call
// button, and the dock (lib/conversationCall.tsx) while the call is this
// page's. People the call cannot ring are named on both. Model and copy:
// lib/conversationCallModel.ts.

import { useEffect, useMemo, type ReactNode } from 'react';
import { dmLobbyName } from '@connorhoehnslalom/realtime-modules/client/video';
import { Button, Inline, PhoneIcon } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { ConversationCallDock } from '../../lib/conversationCall';
import {
  callAvailability,
  callLabel,
  callTargets,
  lobbyPrefix,
  skippedNotice,
  uniquePeople,
  type CallPerson,
  type CallTarget,
  type RosterUser,
} from '../../lib/conversationCallModel';
import { useInitiativeCallHost } from './InitiativeCallHost';

export interface UsePeopleCallInput {
  /** Who the page would ring, by person id. */
  people: CallPerson[];
  /** What the call is about (rides the invite; see callChannelHref). Null: no call from here. */
  channel: string | null;
  /** The dock's title. */
  title: string;
  /** Why Start call is off when nobody can be rung, in the page's words. */
  nobodyReason: string;
  /** The dock's People button. */
  onOpenPeople(): void;
  /** Test ids: `<id>` on the button, `<dockTestId>` (and `-notice`) on the dock. */
  startTestId: string;
  dockTestId: string;
}

export interface PeopleCallView {
  startButton: ReactNode;
  /** For the composer's `dock`; null while there is no call from this page. */
  dock: ReactNode;
  /** Who Start call would ring. */
  targets: CallTarget[];
  /** A call (not a ring) is on, here or elsewhere. */
  inCall: boolean;
}

export function usePeopleCall({
  people: peopleIn, channel, title, nobodyReason, onOpenPeople, startTestId, dockTestId,
}: UsePeopleCallInput): PeopleCallView {
  const host = useInitiativeCallHost();
  const people = useMemo(() => uniquePeople(peopleIn), [peopleIn]);
  const personIds = people.map((p) => p.personId).join(',');
  const { data: mapping } = useFetch<{ users: RosterUser[]; unlinked: string[] }>(
    host && channel && personIds ? `/api/roster/users?personIds=${encodeURIComponent(personIds)}` : null,
  );
  const selfId = host?.self?.userId ?? null;
  const { targets, skipped, selfOnly } = useMemo(
    () => callTargets(people, mapping?.users ?? null, selfId),
    [people, mapping, selfId],
  );

  const tenant = host?.tenant ?? null;
  const lobbyName = selfId && tenant && channel && targets.length > 0
    ? dmLobbyName([selfId, ...targets.map((t) => t.userId)], { prefix: lobbyPrefix(tenant) })
    : null;
  const bind = host?.bind;
  useEffect(() => {
    if (bind && lobbyName && channel) bind({ lobbyName, title, channel });
  }, [bind, lobbyName, title, channel]);

  if (!host || !channel) return { startButton: null, dock: null, targets, inCall: false };
  const { call } = host;
  const availability = callAvailability({
    gatewayConfigured: host.gatewayConfigured,
    connectionState: host.connectionState,
    platformApiUrl: host.platformApiUrl,
    signedIn: !!host.self,
    usersLoaded: !!mapping,
    targets,
    nobodyReason: selfOnly ? 'You are the only person selected — pick someone else to call' : nobodyReason,
  });
  // The shell's call is this page's when the bound lobby is this page's (or,
  // for a callee, the ring carried this page's channel).
  const here = !!host.lobby && (host.lobby.lobbyName === lobbyName || host.lobby.channel === channel);
  const inCall = call.phase !== 'idle' && call.phase !== 'ringing';
  const busyElsewhere = inCall && !here;
  const skippedText = skippedNotice(skipped);

  const startButton = (
    <Button
      size="sm"
      variant="ghost"
      // The composer's dock family (2026-09-29): its own controls (Workflow ▾,
      // the mode pill) are 28px, 12px/500, transparent; a filled 26px
      // 12px/400 button beside them read as a different family.
      className="h-7 text-[12px] font-medium"
      data-testid={startTestId}
      disabled={!availability.ok || inCall}
      title={!availability.ok ? availability.reason
        : busyElsewhere ? 'You are already in a call'
        : inCall ? 'The call is on — see the shelf above the composer'
        : [callLabel(targets), skippedText].filter(Boolean).join(' — ')}
      onClick={() => { void call.start(targets); }}
    >
      <Inline gap="xs" align="center">
        <PhoneIcon size={14} aria-hidden="true" />
        Start call
      </Inline>
    </Button>
  );

  // Idle (or a ring, which the shell's toast answers) draws no shelf — null
  // here, so a host can put its own idle row in the slot.
  const dock = here && inCall ? (
    <ConversationCallDock
      call={call}
      title={title}
      onOpenPeople={onOpenPeople}
      notice={skippedText}
      selfName={host.self?.displayName ?? ''}
      data-testid={dockTestId}
    />
  ) : null;

  return { startButton, dock, targets, inCall };
}
