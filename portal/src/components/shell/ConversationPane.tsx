import { useEffect, useRef, type ReactNode } from 'react';
import { useSidePane } from '@connorhoehnslalom/ui-components';
import { Button, Inline, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { useComposerFocus, useComposerFocusReveal } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { HuddleChatBody, useHuddleChat } from './HuddleChat';

/** One page pane owns both transcripts; opening either never ends the call or edits a draft. */
export function useConversationPane({ enabled = true, onReveal }: { enabled?: boolean; onReveal?: () => void } = {}) {
  const huddle = useHuddleChat();
  const sidePane = useSidePane();
  const focus = useComposerFocus();
  const reveal = useRef(() => {});
  reveal.current = () => { sidePane.reveal(); onReveal?.(); };
  const register = huddle?.registerPaneOwner;
  useEffect(() => enabled ? register?.() : undefined, [enabled, register]);
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
  return <Stack gap="none" className="min-h-0 flex-1">
    {pane.huddle?.callId && <Inline gap="sm" align="center" justify="between" className="shrink-0 border-b border-border px-4 py-2" data-testid="conversation-pane-destination">
      <T size="xs" tone="secondary">{pane.inHuddle ? 'Current huddle' : pageLabel}</T>
      <Button size="sm" variant="ghost" onClick={pane.inHuddle ? pane.showDiscussion : pane.showHuddle}>
        {pane.inHuddle ? pageLabel : 'Huddle chat'}
      </Button>
    </Inline>}
    <Stack gap="none" className="min-h-0 flex-1" hidden={pane.inHuddle}>{children}</Stack>
    {pane.inHuddle && <HuddleChatBody />}
  </Stack>;
}
