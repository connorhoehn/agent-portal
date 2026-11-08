import { useId, useRef, type ReactNode } from 'react';
import { ChatSidePanelFrame } from '@connorhoehn/ui-components';
import { Button, Inline, PageSection, Stack, Tabs } from '@connorhoehn/ui-components/shared';

export type HangoutCallPane = 'conversation' | 'people' | null;

/** A call keeps its media mounted while its auxiliary sidebar opens/closes. */
export function HangoutCallView({ title, count, pane, onPaneChange, stage, conversation, people }: {
  title: string; count: number; pane: HangoutCallPane;
  onPaneChange(pane: HangoutCallPane): void;
  stage: ReactNode; conversation: ReactNode; people: ReactNode;
}) {
  const sidebarId = useId();
  const peopleButton = useRef<HTMLButtonElement>(null);
  const conversationButton = useRef<HTMLButtonElement>(null);
  const closePane = () => {
    const trigger = pane === 'conversation' ? conversationButton.current : peopleButton.current;
    onPaneChange(null);
    requestAnimationFrame(() => trigger?.focus());
  };
  return <Stack gap="md" className="@container min-h-0 min-w-0 flex-1" data-testid="hangout-call-stage">
    <PageSection size="sm" title={title} description={`${count} ${count === 1 ? 'participant' : 'participants'} · Gallery`}
      actions={<Inline gap="sm">
        <Button variant="secondary" size="sm" ref={peopleButton} aria-controls={sidebarId} aria-expanded={pane === 'people'} onClick={() => onPaneChange(pane === 'people' ? null : 'people')}>People ({count})</Button>
        <Button variant="secondary" size="sm" ref={conversationButton} aria-controls={sidebarId} aria-expanded={pane === 'conversation'} onClick={() => onPaneChange(pane === 'conversation' ? null : 'conversation')}>Conversation</Button>
      </Inline>} />
    <Inline gap="none" align="stretch" wrap={false} className="relative min-h-0 min-w-0 flex-1 overflow-hidden border-t border-border" data-testid="hangout-call-layout">
      <Stack gap="none" className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="hangout-gallery">{stage}</Stack>
      {pane && <Stack gap="none" id={sidebarId} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closePane(); } }} className="absolute inset-y-0 right-0 z-20 w-[min(100%,22rem)] bg-surface shadow-lg @min-[780px]:relative @min-[780px]:z-auto @min-[780px]:w-80 @min-[780px]:shrink-0 @min-[780px]:shadow-none" data-testid="hangout-call-sidebar">
        <ChatSidePanelFrame title="In this call" subtitle={title} onClose={closePane} closeLabel="Close call sidebar">
          <Stack gap="none" className="h-full min-h-0">
            <Tabs idPrefix="hangout-call-pane" aria-label="Call sidebar" value={pane} onValueChange={value => onPaneChange(value as Exclude<HangoutCallPane, null>)}
              items={[{ id: 'conversation', label: 'Conversation' }, { id: 'people', label: `People (${count})` }]} variant="underline" size="sm" />
            <Stack gap="none" role="tabpanel" id="hangout-call-pane-panel-conversation" aria-labelledby="hangout-call-pane-tab-conversation" className={pane === 'conversation' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} hidden={pane !== 'conversation'}>{conversation}</Stack>
            {pane === 'people' && <Stack gap="none" role="tabpanel" id="hangout-call-pane-panel-people" aria-labelledby="hangout-call-pane-tab-people" className="min-h-0 flex-1 overflow-y-auto">{people}</Stack>}
          </Stack>
        </ChatSidePanelFrame>
      </Stack>}
    </Inline>
  </Stack>;
}
