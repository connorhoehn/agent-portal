import { ComposerSurface, Inline, T } from '@connorhoehnslalom/ui-components/shared';
import type { ConversationRecipient } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { useMemo, useState, type ReactNode } from 'react';
import type { CallPageDescriptor } from '../../lib/callPages';
import { ConversationComposer } from '../../lib/conversationComposer';
import { huddleChannel } from '../../lib/huddleRoster';
import { useHuddleChat } from './HuddleChat';

/** The same call recipient and shell-owned draft on every workspace surface. */
export function useHuddleComposerRecipient(page?: CallPageDescriptor | null) {
  const chat = useHuddleChat();
  const selectedPage = page === undefined ? chat?.page ?? null : page;
  const recipient = useMemo<ConversationRecipient | null>(() => chat?.callId ? {
    id: `huddle:${chat.callId}`, label: `${chat.title} · Huddle`, channel: chat.channel ?? huddleChannel(chat.callId),
    placeholder: 'Message this huddle…', carriesReference: !!selectedPage, claim: true,
    unavailableReason: chat.unavailableReason, error: chat.state.error,
    onSelect: () => { chat.openPane({ page: selectedPage, focus: false }); },
    send: async out => {
      const sent = await chat.send(out.text, selectedPage, undefined, chat.draft);
      if (sent) chat.openPane({ focus: false });
      return sent;
    },
  } : null, [chat, selectedPage]);
  return { chat, recipient };
}

/** A page discussion and the current call share one input, with separate drafts.
 * The call ID is part of the recipient identity so a later call cannot inherit it.
 */
export function usePageHuddleComposer(defaultMode: 'chat' | 'agent' = 'chat') {
  const { chat, recipient } = useHuddleComposerRecipient(null);
  const [chosen, setChosen] = useState('discussion');
  const [mode, setMode] = useState<'chat' | 'agent'>(defaultMode);
  const huddleSelected = mode === 'chat' && chosen.startsWith('huddle:');
  const retired = chat?.retiredDrafts.find(row => `huddle:${row.scope.callId}` === chosen);
  const current = chosen === recipient?.id;
  return {
    recipient,
    editorKey: huddleSelected ? chosen : 'page',
    unavailableHuddle: huddleSelected && (!current || !!recipient?.unavailableReason),
    composerProps: {
      recipient: chosen,
      mode,
      onModeChange: (value: string) => { if (value === 'chat' || value === 'agent') setMode(value); },
      onRecipientChange: (id: string) => {
        setChosen(id);
        if (id === 'discussion') chat?.closeMessage();
      },
      ...(huddleSelected && chat && current ? {
        draft: chat.draft, onDraftChange: chat.setDraft, persistDraft: false,
      } : huddleSelected && retired && chat ? {
        draft: retired.draft, onDraftChange: (draft: typeof retired.draft) => chat.updateRetiredDraft(retired.scope.callId, draft), persistDraft: false,
      } : {}),
    },
  };
}

/** A presentation without an agent dock still gets the central call composer. */
export function HuddleComposerDock({ dock, page }: { dock?: ReactNode; page?: CallPageDescriptor | null }) {
  const [withReference, setWithReference] = useState(true);
  const { chat, recipient } = useHuddleComposerRecipient(withReference ? page : null);
  const selectedPage = withReference ? page === undefined ? chat?.page ?? null : page : null;
  if (!chat?.callId || !recipient) return null;
  return <ComposerSurface data-testid="deck-huddle-composer-dock">
    <ConversationComposer channel={null} context={{ kind: 'conversation', id: chat.callId, title: '',
      reference: selectedPage ? { id: `${selectedPage.kind}:${selectedPage.id}`, label: `${selectedPage.kind === 'work-item' ? 'Work item' : 'Initiative'} context`, page: selectedPage } : null }}
      capabilities={{ maySend: chat.canSend, agent: { allowed: false, reason: 'Use the presentation editor to update this deck.' } }}
      recipients={[recipient]} recipient={recipient.id} defaultMode="chat" answersFocus
      claim={{ label: 'the presentation composer' }} callBlock={dock}
      draft={chat.draft} onDraftChange={chat.setDraft} persistDraft={false}
      onRemoveReference={() => setWithReference(false)}
      modeRowStart={<Inline gap="xs" wrap={false}><T size="xs" tone="secondary">To:</T><T size="xs" weight="medium">Huddle</T></Inline>}
      presentation="document" label="Presentation huddle composer" inputLabel="Huddle message" allowEmoji={false} data-testid="deck-huddle-composer"
      maxInputHeight="min(8rem, 20dvh)" className="@container" />
  </ComposerSurface>;
}
