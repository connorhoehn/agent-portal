import { useMemo, useState, type ReactNode } from 'react';
import type { ConversationRecipient } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { Inline, T } from '@connorhoehnslalom/ui-components/shared';
import { ConversationComposer } from '../../lib/conversationComposer';
import { huddleChannel } from '../../lib/huddleRoster';
import type { CallPageDescriptor } from '../../lib/callPages';
import { useHuddleChat } from './HuddleChat';

/** The same call recipient and shell-owned draft on every workspace surface. */
export function useHuddleComposerRecipient(page?: CallPageDescriptor | null) {
  const chat = useHuddleChat();
  const selectedPage = page === undefined ? chat?.page ?? null : page;
  const recipient = useMemo<ConversationRecipient | null>(() => chat?.callId ? {
    id: `huddle:${chat.callId}`, label: `${chat.title} · Huddle`, channel: huddleChannel(chat.callId),
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

/** A presentation without an agent dock still gets the central call composer. */
export function HuddleComposerDock({ dock, page }: { dock?: ReactNode; page?: CallPageDescriptor | null }) {
  const [withReference, setWithReference] = useState(true);
  const { chat, recipient } = useHuddleComposerRecipient(withReference ? page : null);
  const selectedPage = withReference ? page === undefined ? chat?.page ?? null : page : null;
  if (!chat?.callId || !recipient) return null;
  return <div className="initiative-composer-dock shrink-0" data-testid="deck-huddle-composer-dock">
    <ConversationComposer channel={null} context={{ kind: 'conversation', id: chat.callId, title: '',
      reference: selectedPage ? { id: `${selectedPage.kind}:${selectedPage.id}`, label: `${selectedPage.kind === 'work-item' ? 'Work item' : 'Initiative'} context`, page: selectedPage } : null }}
      capabilities={{ maySend: chat.canSend, agent: { allowed: false, reason: 'Use the presentation editor to update this deck.' } }}
      recipients={[recipient]} recipient={recipient.id} defaultMode="chat" answersFocus
      claim={{ label: 'the presentation composer' }} callBlock={dock}
      draft={chat.draft} onDraftChange={chat.setDraft} persistDraft={false}
      onRemoveReference={() => setWithReference(false)}
      modeRowStart={<Inline gap="xs" wrap={false}><T size="xs" tone="secondary">To:</T><T size="xs" weight="medium">Huddle</T></Inline>}
      presentation="document" label="Presentation huddle composer" inputLabel="Huddle message" allowEmoji={false} data-testid="deck-huddle-composer"
      maxInputHeight="min(8rem, 20dvh)" className="@container bg-surface pt-0 [--dock-inset:0px]" />
  </div>;
}
