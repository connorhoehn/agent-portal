// /social/decks/new?channel= — a new deck on a conversation, from an example (docs/deck-edit-operations.md:
// Social's one direct create, `POST /api/chat/decks { channel, templateId }`). Building one from what was said
// stays the conversation's own `/deck` command, which follows its run in the thread; this page says so.

import { useSearchParams } from 'react-router';
import { FormField, Select, T } from '@connorhoehn/ui-components/shared';
import { NewDeckPage } from '../../../components/decks/NewDeckPage';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { createSocialDeckFromTemplate, socialChannelSlug } from './socialDecksApi';

interface ChannelOption { slug: string; name?: string }

export default function NewSocialDeckPage() {
  const [params, setParams] = useSearchParams();
  // `?channel=` may carry the picker's slug or the chat channel id; the picker and the names work on the slug,
  // and the create call sends the id the server wants (socialChatChannel).
  const channel = socialChannelSlug(params.get('channel') ?? '');
  const { can } = useCapabilities();
  const { data } = useFetch<ChannelOption[] | { channels?: ChannelOption[] }>('/api/social/channels');
  const channels = Array.isArray(data) ? data : data?.channels ?? [];
  const named = channels.find((c) => c.slug === channel);
  const tag = `#${named?.name ?? channel}`;

  const subject = (
    <FormField label="Conversation" hint="The deck belongs to a conversation; its members can edit it. To build one from what was said, type /deck in the conversation.">
      {({ id }) => <Select id={id} value={channel} placeholder="Choose a conversation" data-testid="social-deck-new-channel"
        onChange={(e) => setParams((prev) => { const next = new URLSearchParams(prev); next.set('channel', e.target.value); return next; }, { replace: true })}
        options={[...(channel && !named ? [{ value: channel, label: `#${channel}` }] : []), ...channels.map((c) => ({ value: c.slug, label: `#${c.name ?? c.slug}` }))]} />}
    </FormField>
  );

  return (
    <NewDeckPage
      tenant="social" testIdPrefix="social-deck" title="New deck" ready={!!channel}
      description={channel ? `A deck on ${tag}, started from an example.` : 'A deck on one conversation, started from an example.'}
      subject={<>{subject}{!channel && <T size="xs" tone="secondary">Choose the conversation first.</T>}</>}
      titlePlaceholder={channel ? `${tag} deck` : 'Deck title'}
      denied={can('PostMessage') ? null : 'Your role can read decks here but not start one.'}
      deckHref={(id) => `/social/decks/${encodeURIComponent(id)}`}
      createFromTemplate={async (templateId, title) => (await createSocialDeckFromTemplate(channel, { templateId, ...(title ? { title } : {}) })).deckId}
      facts={null}
    />
  );
}
