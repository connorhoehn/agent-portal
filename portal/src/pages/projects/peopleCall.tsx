// Start a call with the people a page is about (docs/social-calls-plan.md
// steps 5–6): an initiative's owner + SMEs (InitiativeCall.tsx), or the people
// selected on Search (pages/search/SearchComposer.tsx).
//
// Who is rung: those people, mapped person → user by GET /api/roster/users
// (tenant-scoped), minus you. The lobby is the tenant-prefixed dm lobby of you
// + them, so whoever rings first, the same people land in the same
// platform-api session. The call itself lives in the authenticated shell's
// call block host (lib/conversationCall.tsx); this hook binds the page's lobby and draws Start call.
// Playback and device controls are the shell's single dock. People the call
// cannot ring are named in the Start action's explanation. Model and copy:
// lib/conversationCallModel.ts.

import { useMemo, useRef, type ReactNode } from 'react';
import { dmLobbyName } from '@connorhoehn/realtime-modules/client/video';
import { Button, Inline, PhoneIcon } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
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
import { useCallBlock, useCallHost, useCallLobby } from '../../lib/conversationCall';

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
  /** The composer that takes `dock` sits in a narrow host (the right pane). */
  compactDock?: boolean;
  /** False when the page separately binds a shared huddle for its footer. */
  bindFooter?: boolean;
}

export interface PeopleCallView {
  startButton: ReactNode;
  /**
   * For the page composer's `dock` slot: while this page's call is drawn, the
   * call bar and tiles above the input (the shell's one media sink moved
   * there — the library's `useCallBlock`); undefined otherwise.
   */
  dock: ReactNode;
  /** Who Start call would ring. */
  targets: CallTarget[];
  /** A call (not a ring) is on, here or elsewhere. */
  inCall: boolean;
}

export function usePeopleCall({
  people: peopleIn, channel, title, nobodyReason, startTestId, compactDock = false, bindFooter = true,
}: UsePeopleCallInput): PeopleCallView {
  const host = useCallHost();
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
  // The footer's idle Huddle runs this same start (never a second call path).
  const startRef = useRef<() => void>(() => {});
  const availability = host ? callAvailability({
    gatewayConfigured: host.gatewayConfigured, connectionState: host.connectionState, platformApiUrl: host.platformApiUrl,
    signedIn: !!host.self, usersLoaded: !!mapping, targets,
    nobodyReason: selfOnly ? 'You are the only person selected — pick someone else to call' : nobodyReason,
  }) : null;
  const blocked = availability && !availability.ok ? availability.reason : undefined;
  useCallLobby(bindFooter && lobbyName && channel ? { lobbyName, title, channel, ...(blocked ? { startBlockedReason: blocked } : {}) } : null, () => startRef.current());
  // The ring carried this page's channel for a callee; the lobby is the caller's.
  const dock = useCallBlock([lobbyName, channel], { compact: compactDock }).block;

  if (!host || !channel) return { startButton: null, dock: null, targets, inCall: false };
  const { call } = host;
  startRef.current = () => { void call.start(targets); };
  const ready = availability!; // non-null: `host` is
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
      className="h-7 text-xs font-medium"
      data-testid={startTestId}
      disabled={!ready.ok || inCall}
      title={!ready.ok ? ready.reason
        : busyElsewhere ? 'You are already in a call'
        : inCall ? 'The call is on — use the call controls at the bottom of the app'
        : [callLabel(targets), skippedText].filter(Boolean).join(' — ')}
      onClick={() => { void call.start(targets); }}
    >
      <Inline gap="xs" align="center">
        <PhoneIcon size={14} aria-hidden="true" />
        Start call
      </Inline>
    </Button>
  );

  return { startButton, dock, targets, inCall };
}
