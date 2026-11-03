import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { SidePane, usePaneState, useSidePane, useSidePaneHost, type PaneTabSpec } from '@connorhoehnslalom/ui-components';
import { Inline, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useComposerFocusReveal } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { HuddleChatBody, useHuddleChat } from '../shell/HuddleChat';
import { ConversationViewsSlot } from '../chat/useChatPins';
import './DeckAssistantPane.css';

export interface DeckAssistantPaneProps {
  /** Persistent assistant output; the page owns its Chat/Agent composer. */
  question: ReactNode;
  /** Incremented when the page submits a question. */
  questionRequest: number;
  deckTitle: string;
  assistantTitle?: string;
  composerTestId?: string;
}

/** The presentation's registered shell pane, sharing the shell's current call. */
export function DeckAssistantPane({ question, questionRequest, deckTitle, assistantTitle = 'Presentation assistant', composerTestId = 'deck-composer-dock' }: DeckAssistantPaneProps) {
  const [params, setParams] = useSearchParams();
  const sidePane = useSidePane();
  const paneHost = useSidePaneHost();
  const huddle = useHuddleChat();
  const callId = huddle?.callId ?? null;
  const huddleView = huddle?.view ?? 'closed';
  const huddleFocusRequest = huddle?.focusRequest ?? 0;
  const registerPaneOwner = huddle?.registerPaneOwner;
  const tabs = useMemo<readonly PaneTabSpec[]>(() => [
    { id: 'agent', label: 'Agent' },
    ...(callId ? [{ id: 'huddle', label: 'Huddle' }] : []),
  ], [callId]);
  const pane = usePaneState({ tabs, defaultTab: 'agent', params, setParams, onOpen: sidePane.reveal });
  const openPane = useRef(pane.open);
  openPane.current = pane.open;
  const [viewsSlot, setViewsSlot] = useState<HTMLElement | null>(null);

  // On compact screens the pane floats over the workspace instead of taking
  // half its width. Keep that overlay above the page's persistent composer,
  // including its actual expanded height or compact call block.
  useEffect(() => {
    const split = document.querySelector<HTMLElement>('[data-testid="shell-split"]');
    const composer = document.querySelector<HTMLElement>(`[data-testid="${composerTestId}"]`);
    if (!split || !composer) return;
    const measure = () => {
      const splitBounds = split.getBoundingClientRect();
      const composerBounds = composer.getBoundingClientRect();
      const inset = Math.max(12, splitBounds.bottom - composerBounds.top + 12);
      split.style.setProperty('--deck-assistant-composer-inset', `${Math.round(inset)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(split);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      split.style.removeProperty('--deck-assistant-composer-inset');
    };
  }, [deckTitle, callId, questionRequest, composerTestId]);

  // This page owns the huddle's thread even while its pane is collapsed or
  // Agent is selected; the shell must not add a second huddle drawer.
  const huddleVisible = pane.tab === 'huddle' && paneHost.shown && !paneHost.folded;
  useEffect(() => registerPaneOwner?.({ visible: huddleVisible, hide: paneHost.collapse }), [registerPaneOwner, huddleVisible, paneHost.collapse]);
  useComposerFocusReveal(request => {
    if (callId && request.target?.kind === 'huddle') openPane.current('huddle');
  });

  // Message/openPane requests can arrive while the huddle is already open.
  // Observe their request counter as well as view/call transitions, rather
  // than reopening the pane on unrelated chat updates after a collapse.
  useEffect(() => {
    if (callId && huddleView === 'pane') openPane.current('huddle');
  }, [callId, huddleView, huddleFocusRequest]);

  useEffect(() => {
    if (questionRequest > 0) openPane.current('agent');
  }, [questionRequest]);

  const showingHuddle = pane.tab === 'huddle' && !!callId;
  return (
    <SidePane
      title={showingHuddle ? 'Huddle dialogue' : assistantTitle}
      subtitle={showingHuddle ? huddle!.title : deckTitle}
      closeLabel={showingHuddle ? 'Collapse huddle dialogue' : `Collapse ${assistantTitle.toLowerCase()}`}
      paneId="presentation-assistant"
      widthPx={{ min: 380, max: 760 }}
      explores={pane.away}
      tabs={pane.tabs}
      value={pane.tab}
      onValueChange={pane.select}
      trailing={<Inline ref={setViewsSlot} gap="none" align="center" wrap={false} hidden={!showingHuddle} className="shrink-0" data-testid="deck-assistant-huddle-views" />}
      data-testid="deck-assistant-pane"
    >
      <Stack gap="none" className="min-h-0 flex-1" hidden={showingHuddle} data-testid="deck-assistant-agent">
        {question}
      </Stack>
      {callId && (
        <Stack gap="none" className="min-h-0 flex-1" hidden={!showingHuddle} data-testid="deck-assistant-huddle">
          <ConversationViewsSlot.Provider value={viewsSlot}><HuddleChatBody key={callId} /></ConversationViewsSlot.Provider>
        </Stack>
      )}
    </SidePane>
  );
}
