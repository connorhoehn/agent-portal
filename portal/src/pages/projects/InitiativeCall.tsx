// The call on an initiative page (docs/social-calls-plan.md step 5): the
// "Start call" header action and the call shelf docked on the initiative
// composer. Who is rung: the initiative's owner + SMEs with an OrgIQ sign-in,
// minus you — the mechanics are the shared usePeopleCall (./peopleCall.tsx),
// which Search's composer uses too.

import { useMemo, type ReactNode } from 'react';
import { usePeopleCall } from './peopleCall';
import { initiativeCallChannel, initiativeCallPeople, type InitiativeCallPerson } from './initiativeCallModel';

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
  /** For the composer's `dock`; null while there is no call on this initiative. */
  dock: ReactNode;
}

export function useInitiativeCall({ project, owner, smes, onOpenPeople }: UseInitiativeCallInput): InitiativeCallView {
  const people = useMemo(() => initiativeCallPeople(owner, smes), [owner, smes]);
  const { startButton, dock } = usePeopleCall({
    people,
    channel: project ? initiativeCallChannel(project.id) : null,
    title: project?.name ?? '',
    nobodyReason: 'Nobody else on this initiative has an OrgIQ sign-in to call',
    onOpenPeople,
    startTestId: 'initiative-start-call',
    dockTestId: 'initiative-call-dock',
  });
  return { startButton, dock };
}
