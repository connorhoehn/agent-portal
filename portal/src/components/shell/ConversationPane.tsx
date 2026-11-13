import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useSidePane, useSidePaneHost } from '@connorhoehn/ui-components';
import { Button, Inline, Stack, T } from '@connorhoehn/ui-components/shared';
import { useComposerFocus, useComposerFocusReveal } from '@connorhoehn/ui-components/social/rich-composer';
import { HuddleChatBody, useHuddleChat } from './HuddleChat';
import { useNovaRosterEntry } from './MeetingAssistantBar';

/** One page pane owns both transcripts; opening either never ends the call or edits a draft. */
export function useConversationPane({ enabled = true, onReveal, onHide, visible }: { enabled?: boolean; onReveal?: () => void; onHide?: () => void; visible?: boolean } = {}) {
  const huddle = useHuddleChat();
  const sidePane = useSidePane();
  const host = useSidePaneHost();
  const focus = useComposerFocus();
  const reveal = useRef(() => {});
  reveal.current = () => { sidePane.reveal(); onReveal?.(); };
  const hideRef = useRef(() => {});
  hideRef.current = onHide ?? host.collapse;
  const hide = useCallback(() => hideRef.current(), []);
  const shown = visible ?? (host.shown && !host.folded);
  const register = huddle?.registerPaneOwner;
  useEffect(() => enabled ? register?.({ visible: shown, hide }) : undefined, [enabled, register, shown, hide]);
  const inHuddle = !!huddle?.callId && huddle.view === 'pane';
  // Respond once when the call transcript opens, not whenever the page renders:
  // the user can subsequently explore Details without being pulled back.
  useEffect(() => { if (enabled && inHuddle) reveal.current(); }, [enabled, inHuddle]);
  useComposerFocusReveal(request => {
    if (request.mode !== 'chat') return;
    if (request.target?.kind === 'huddle') {
      if (huddle?.openPane({ focus: false })) reveal.current();
    } else if (request.target?.kind === 'discussion') {
      huddle?.closeMessage();
      reveal.current();
    }
  }, enabled);
  return {
    huddle, inHuddle,
    showDiscussion: () => focus.request({ mode: 'chat', target: { kind: 'discussion' } }),
    showHuddle: () => focus.request({ mode: 'chat', target: { kind: 'huddle' } }),
  };
}

/** Keep the page thread mounted when a call temporarily occupies its pane. */
export function ConversationPaneBody({ pane, pageLabel, children }: {
  pane: ReturnType<typeof useConversationPane>; pageLabel: string; children: ReactNode;
}) {
  const nova = useNovaRosterEntry(pane.huddle?.callId ?? null);
  return <Stack gap="none" className="min-h-0 flex-1">
    {pane.huddle?.callId && <Inline gap="sm" align="center" justify="between" className="shrink-0 border-b border-border px-4 py-2" data-testid="conversation-pane-destination">
      <T size="xs" tone="secondary">{pane.inHuddle ? 'Current huddle' : pageLabel}</T>
      {/* Nova is not a media participant, so the call's tiles never list it; the pane's destination row does. */}
      {nova && <T size="xs" tone="secondary" className="min-w-0 flex-1 truncate" data-testid="nova-roster-entry">{nova}</T>}
      <Button size="sm" variant="ghost" onClick={pane.inHuddle ? pane.showDiscussion : pane.showHuddle}>
        {pane.inHuddle ? pageLabel : 'Huddle chat'}
      </Button>
    </Inline>}
    <Stack gap="none" className="min-h-0 flex-1" hidden={pane.inHuddle}>{children}</Stack>
    {pane.inHuddle && <HuddleChatBody />}
  </Stack>;
}
