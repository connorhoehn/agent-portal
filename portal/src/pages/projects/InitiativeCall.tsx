// The call on an initiative page (docs/social-calls-plan.md step 5): the
// "Start call" header action and the CallDock shelf docked on the initiative
// composer, with owner/SMEs the call cannot ring named on both.
//
// Who is rung: the initiative's owner + SMEs, mapped person → user by
// GET /api/roster/users (tenant-scoped), minus you. The lobby is the
// tenant-prefixed dm lobby of you + them, so whoever rings first, the same
// people land in the same platform-api session. The call itself lives in
// InitiativeCallHost (the /iq shell); this file binds the page's lobby to it
// and draws it. Model and copy: ./initiativeCallModel.ts.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  conversationCallDockProps,
  dmLobbyName,
  useAudioVideoSettings,
  type ConversationCallParticipant,
} from '@connorhoehnslalom/realtime-modules/client/video';
import { AudioVideoSettingsForm, CallDock, StreamVideo } from '@connorhoehnslalom/ui-components/video';
import { Button, Inline, InlineAlert, Modal, PhoneIcon } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useInitiativeCallHost } from './InitiativeCallHost';
import {
  initiativeCallAvailability,
  initiativeCallChannel,
  initiativeCallPeople,
  initiativeCallTargets,
  lobbyPrefix,
  skippedNotice,
  type InitiativeCallPerson,
  type RosterUser,
} from './initiativeCallModel';

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

const tile = (p: ConversationCallParticipant): ReactNode | undefined =>
  p.stream ? <StreamVideo stream={p.stream} muted={p.isLocal} /> : undefined;

const speakerSelectionSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export function useInitiativeCall({ project, owner, smes, onOpenPeople }: UseInitiativeCallInput): InitiativeCallView {
  const host = useInitiativeCallHost();
  const people = useMemo(() => initiativeCallPeople(owner, smes), [owner, smes]);
  const personIds = people.map((p) => p.personId).join(',');
  const { data: mapping } = useFetch<{ users: RosterUser[]; unlinked: string[] }>(
    host && personIds ? `/api/roster/users?personIds=${encodeURIComponent(personIds)}` : null,
  );
  const selfId = host?.self?.userId ?? null;
  const { targets, skipped } = useMemo(
    () => initiativeCallTargets(people, mapping?.users ?? null, selfId),
    [people, mapping, selfId],
  );

  const projectId = project?.id ?? null;
  const projectName = project?.name ?? '';
  const tenant = host?.tenant ?? null;
  const lobbyName = selfId && tenant && targets.length > 0
    ? dmLobbyName([selfId, ...targets.map((t) => t.userId)], { prefix: lobbyPrefix(tenant) })
    : null;
  const bind = host?.bind;
  useEffect(() => {
    if (bind && lobbyName && projectId) bind({ lobbyName, title: projectName, channel: initiativeCallChannel(projectId) });
  }, [bind, lobbyName, projectName, projectId]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Same storage key as the call's device preferences; the preview (camera +
  // mic level) runs only while the dialog is open.
  const avs = useAudioVideoSettings({ preview: settingsOpen });

  if (!host || !projectId) return { startButton: null, dock: null };
  const { call } = host;
  const availability = initiativeCallAvailability({
    gatewayConfigured: host.gatewayConfigured,
    connectionState: host.connectionState,
    platformApiUrl: host.platformApiUrl,
    signedIn: !!host.self,
    usersLoaded: !!mapping,
    targets,
  });
  // The shell's call is this initiative's when the bound lobby is this page's
  // (or, for a callee, the ring carried this initiative's channel).
  const here = !!host.lobby && (host.lobby.lobbyName === lobbyName || host.lobby.channel === initiativeCallChannel(projectId));
  const inCall = call.phase !== 'idle' && call.phase !== 'ringing';
  const busyElsewhere = inCall && !here;

  // Owner/SMEs with no sign-in are named on the button and, during the call,
  // above the shelf — never silently left out.
  const skippedText = skippedNotice(skipped);

  const startButton = (
    <Button
      size="sm"
      variant="secondary"
      data-testid="initiative-start-call"
      disabled={!availability.ok || inCall}
      title={!availability.ok ? availability.reason
        : busyElsewhere ? 'You are already in a call'
        : inCall ? 'The call is on — see the shelf above the composer'
        : [`Call ${targets.map((t) => t.displayName).join(', ')}`, skippedText].filter(Boolean).join(' — ')}
      onClick={() => { void call.start(targets); }}
    >
      <Inline gap="xs" align="center">
        <PhoneIcon size={14} aria-hidden="true" />
        Start call
      </Inline>
    </Button>
  );

  const dockProps = here
    ? conversationCallDockProps(call, {
        title: projectName,
        onOpenPeople,
        onOpenSettings: () => setSettingsOpen(true),
        tile,
        compact: false,
        'data-testid': 'initiative-call-dock',
      })
    : null;

  const dock = dockProps ? (
    <>
      {skippedText && <InlineAlert tone="info" data-testid="initiative-call-skipped">{skippedText}</InlineAlert>}
      <CallDock {...dockProps} />
      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Call devices">
        <AudioVideoSettingsForm
          value={avs.settings}
          onChange={(next) => {
            avs.update(next);
            // The live call reads its own preferences; keep them in step.
            call.devices.set({
              ...(next.microphoneId ? { microphoneId: next.microphoneId } : {}),
              ...(next.cameraId ? { cameraId: next.cameraId } : {}),
              ...(next.speakerId ? { speakerId: next.speakerId } : {}),
            });
          }}
          devices={{ microphones: call.devices.list.microphones, cameras: call.devices.list.cameras, speakers: call.devices.list.speakers }}
          permission={call.devices.list.permission}
          micLevel={avs.micLevel}
          previewStream={avs.previewStream}
          cameraOn={call.self.cameraOn}
          speakerSelectionSupported={speakerSelectionSupported}
          onTestMic={avs.testMic}
          onTestSound={avs.testSound}
          testMicState={avs.testMicState}
          selfName={host.self?.displayName ?? ''}
        />
      </Modal>
    </>
  ) : null;

  return { startButton, dock };
}
