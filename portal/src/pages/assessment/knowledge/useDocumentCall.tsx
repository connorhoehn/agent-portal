// The in-document call (plan gap 8): the Call button in the document head and
// the call docked in the page margin (`VideoDockSlot` in CanvasDocumentView's
// `gutterLead`, where realtime-examples' page editor docks its call).
//
// Not a second call stack. It is the initiative page's: the one
// `useConversationCall` the tenant shell hosts (projects/InitiativeCallHost,
// mounted around the assessment routes by AssessmentLayout), the realtime
// token as its credential, the shared call model (lib/conversationCallModel:
// `callAvailability`, `lobbyPrefix`) for why the button is off, and the
// library dock the initiative and Search pages draw (lib/conversationCall
// `ConversationCallDock`, ui-components `createConversationCallDock`). What
// differs is only who and where:
//
//   - the LOBBY is the document's, `<tenant>:doc:<doc>` — one per document,
//     tenant-prefixed like the initiative's (the BFF gateway's lobbyGuard
//     refuses anything else), so whoever calls, everyone lands in one session;
//   - the people RUNG are the others on the page right now (canvas awareness,
//     the byline), not an owner/SME roster — a document has none;
//   - the invite's channel carries the document's URL, so Accept on any
//     assessment page opens it (AssessmentLayout's DocumentCallNavigator).

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { VideoDockSlot } from '@connorhoehnslalom/ui-components/doc-editor';
import { useInitiativeCallHost } from '../../projects/InitiativeCallHost';
import { ConversationCallDock } from '../../../lib/conversationCall';
import { callAvailability, lobbyPrefix } from '../../../lib/conversationCallModel';
import { documentCallChannel, documentCallLobby, type AwarenessPerson } from './documentCommentsModel';
import { conversationChannelForDoc } from './knowledgeFormat';

export interface DocumentCallView {
  /** For the shared DocumentHeader: its Call control. Empty when no call host is mounted. */
  headerProps: { onToggleVideoCall?: () => void; isCallActive?: boolean; callVariant?: 'idle' | 'available' | 'active'; callLabel?: string };
  /** For CanvasDocumentView `gutterLead`; null while this document has no call. */
  dock: ReactNode;
  /** Why the Call control is off, or null. */
  unavailableReason: string | null;
  /** Said once Call is pressed while it cannot ring anyone; dismissible. */
  notice: string | null;
  clearNotice: () => void;
}

export function useDocumentCall({ docId, href, title, people, onOpenPeople }: {
  docId: string; href: string; title: string; people: readonly AwarenessPerson[]; onOpenPeople: () => void;
}): DocumentCallView {
  const host = useInitiativeCallHost();
  const tenant = host?.tenant ?? null;
  const lobbyName = tenant ? documentCallLobby(lobbyPrefix(tenant), conversationChannelForDoc(docId)) : null;
  const channel = documentCallChannel(href);
  const bind = host?.bind;
  useEffect(() => {
    if (bind && lobbyName) bind({ lobbyName, title, channel });
  }, [bind, lobbyName, title, channel]);
  const targets = useMemo(() => people.map(p => ({ userId: p.id, displayName: p.name })), [people]);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = () => setNotice(null);

  if (!host || !lobbyName) return { headerProps: {}, dock: null, unavailableReason: 'Calls are not available here', notice: null, clearNotice };
  const { call } = host;
  const here = host.lobby?.lobbyName === lobbyName;
  const inCall = call.phase !== 'idle' && call.phase !== 'ringing' && call.phase !== 'ended' && call.phase !== 'failed';
  const availability = callAvailability({
    gatewayConfigured: host.gatewayConfigured, connectionState: host.connectionState, platformApiUrl: host.platformApiUrl,
    signedIn: !!host.self, usersLoaded: true, targets, nobodyReason: 'Nobody else has this document open to call',
  });
  const reason = availability.ok ? null : availability.reason;
  const active = here && inCall;
  const busyElsewhere = inCall && !here;
  const headerProps: DocumentCallView['headerProps'] = {
    isCallActive: active,
    callVariant: active ? 'active' : reason || busyElsewhere ? 'idle' : 'available',
    callLabel: active ? 'Leave call' : 'Call',
    onToggleVideoCall: () => {
      if (active) { void call.leave(); return; }
      if (busyElsewhere) { setNotice('You are already in a call. Leave it to call from this document.'); return; }
      if (reason) { setNotice(reason); return; }
      if (call.phase === 'calling') return;
      setNotice(null);
      void call.start(targets);
    },
  };
  const dock = here && call.phase !== 'idle'
    ? <VideoDockSlot docked canAccept label="Document call" data-testid="document-call-slot">
      <ConversationCallDock call={call} title={title} onOpenPeople={onOpenPeople} selfName={host.self?.displayName ?? ''} compact data-testid="document-call-dock" />
    </VideoDockSlot>
    : null;
  return { headerProps, dock, unavailableReason: reason, notice, clearNotice };
}
