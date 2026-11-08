// The in-document Call/Leave button (plan gap 8), bound to the authenticated
// shell's persistent call and single media playback dock.
//
// Not a second call stack. It is the initiative page's: the one
// `useConversationCall` the tenant shell hosts (the library's call block host,
// mounted in the authenticated Layout), the realtime
// token as its credential, the shared call model (lib/conversationCallModel:
// `callAvailability`, `lobbyPrefix`) for why the button is off, and the
// library dock the authenticated shell draws (lib/conversationCall
// `ConversationCallDock`, ui-components `createConversationCallDock`). What
// differs is only who and where:
//
//   - the LOBBY is the document's, `<tenant>:doc:<doc>` — one per document,
//     tenant-prefixed like the initiative's (the BFF gateway's lobbyGuard
//     refuses anything else), so whoever calls, everyone lands in one session;
//   - the people RUNG are the others on the page right now (canvas awareness,
//     the byline), not an owner/SME roster — a document has none;
//   - the invite's channel carries the document's URL, so Accept on any
//     authenticated page opens it (the call host's Accept, ShellCallHost).

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useCallHost, useCallLobby } from '../../../lib/conversationCall';
import { callAvailability, lobbyPrefix } from '../../../lib/conversationCallModel';
import { pageHuddleStart } from '@connorhoehn/ui-components/integrations/realtime';
import { documentCallChannel, documentCallLobby, type AwarenessPerson } from './documentCommentsModel';
import { conversationChannelForDoc } from './knowledgeFormat';

export interface DocumentCallView {
  /** For the shared DocumentHeader: its Call control. Empty when no call host is mounted. */
  headerProps: { onToggleVideoCall?: () => void; isCallActive?: boolean; callVariant?: 'idle' | 'available' | 'active'; callLabel?: string };
  /** Compatibility gutter slot; playback stays in the persistent shell. */
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
  const host = useCallHost();
  const tenant = host?.tenant ?? null;
  const lobbyName = tenant ? documentCallLobby(lobbyPrefix(tenant), conversationChannelForDoc(docId)) : null;
  const channel = documentCallChannel(href);
  const targets = useMemo(() => people.map(p => ({ userId: p.id, displayName: p.name })), [people]);
  // The footer's idle Huddle runs this same start (never a second call path).
  const startRef = useRef<() => void>(() => {});
  const early = host ? callAvailability({
    gatewayConfigured: host.gatewayConfigured, connectionState: host.connectionState, platformApiUrl: host.platformApiUrl,
    signedIn: !!host.self, usersLoaded: true, targets, nobodyReason: 'Nobody else has this document open to call',
  }) : null;
  // The footer's Huddle needs no one else on the page (realtime-parity gap 3):
  // with nobody to ring it opens the document's huddle (or walks into the one
  // that is on), like a room. Only the connection can block it.
  const reachable = host ? callAvailability({
    gatewayConfigured: host.gatewayConfigured, connectionState: host.connectionState, platformApiUrl: host.platformApiUrl,
    signedIn: !!host.self, usersLoaded: true, targets: [{ userId: 'document', displayName: title }],
  }) : null;
  const blocked = reachable && !reachable.ok ? reachable.reason : undefined;
  useCallLobby(lobbyName ? { lobbyName, title, channel, ...(blocked ? { startBlockedReason: blocked } : {}) } : null, () => startRef.current());
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = () => setNotice(null);

  if (!host || !lobbyName) return { headerProps: {}, dock: null, unavailableReason: 'Calls are not available here', notice: null, clearNotice };
  const { call } = host;
  const here = host.lobby?.lobbyName === lobbyName;
  const inCall = call.phase !== 'idle' && call.phase !== 'ringing' && call.phase !== 'ended' && call.phase !== 'failed';
  const availability = early!; // non-null: `host` is
  startRef.current = () => {
    if (blocked || !here) return;
    if (availability.ok && !(call.phase === 'idle' && call.call)) { void call.start(targets); return; }
    pageHuddleStart(call);
  };
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
  // Playback and device controls stay in the persistent shell after this
  // document unmounts. The existing gutter slot remains compatible and empty.
  return { headerProps, dock: null, unavailableReason: reason, notice, clearNotice };
}
