// The call on an initiative page (docs/social-calls-plan.md step 5): the
// "Start call" header action, bound to the authenticated shell's single
// call dock. Who is rung: the initiative's owner + SMEs with a Work sign-in,
// minus you — the mechanics are the shared usePeopleCall (./peopleCall.tsx),
// which Search's composer uses too.

import { useMemo, type ReactNode } from 'react';
import { usePeopleCall } from './peopleCall';
import { initiativeCallChannel, initiativeCallPeople, initiativeHuddleLobby, type InitiativeCallPerson } from './initiativeCallModel';
import { useCallBlock } from '../../lib/conversationCall';

export interface UseInitiativeCallInput {
  /** Null while the initiative is loading — the hook is called before the page's early returns. */
  project: { id: string; name: string } | null;
  owner: InitiativeCallPerson | null;
  smes: InitiativeCallPerson[];
  /** The dock's People button — the page shows its Contributors. */
  onOpenPeople(): void;
}

export interface InitiativeCallView {
  /** For ScopeHeader `controls`, beside "Search in this initiative". */
  startButton: ReactNode;
  /** The call bar and tiles for the composer that writes to this initiative (the library's `useCallBlock`); undefined when no call here. */
  dock: ReactNode;
}

export function useInitiativeCall({ project, owner, smes, onOpenPeople }: UseInitiativeCallInput): InitiativeCallView {
  const people = useMemo(() => initiativeCallPeople(owner, smes), [owner, smes]);
  const { startButton, dock } = usePeopleCall({
    people,
    channel: project ? initiativeCallChannel(project.id) : null,
    title: project?.name ?? '',
    nobodyReason: 'Nobody else on this initiative has a Work sign-in to call',
    onOpenPeople,
    startTestId: 'initiative-start-call',
    dockTestId: 'initiative-call-dock',
    // The initiative's central composer owns the bounded call dock.
    compactDock: true,
    bindFooter: false,
  });
  // Footer Huddle opens or joins the shared page lobby. The header's Start
  // call can still ring the owner/SMEs into that same authorized lobby.
  useCallBlock(project ? initiativeHuddleLobby(project.id) : null, { enabled: false,
    bind: project ? { title: project.name, channel: initiativeCallChannel(project.id) } : null });
  return { startButton, dock };
}
