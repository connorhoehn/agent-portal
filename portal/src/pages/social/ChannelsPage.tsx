// /social/channels and /social/channels/:slug — the tenant's channels
// (docs/social-tenant-design.md §4.5). The library's ConversationRail lists the
// directory (channels you are in first, then public ones you could join); the
// open channel is a SocialConversation once you are a member, and a Join
// prompt before — the gateway refuses a non-member's subscribe, so nothing
// realtime mounts until the join lands. ManageChannels holders create channels
// through the library's CreateChannelDialog.

import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ConversationRail, CreateChannelDialog, type CreateChannelDialogInput } from '@connorhoehnslalom/ui-components/social';
import { Button, ChannelHeader, EmptyState, ErrorState, InlineAlert, Inline, LoadingState, PageHeader, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import SocialConversation from './SocialConversation';
import { channelHref, channelRailItems, privacyForApi, slugFromChannel, type SocialChannel } from './socialChat';

export default function ChannelsPage() {
  const { slug: rawSlug } = useParams<{ slug?: string }>();
  const slug = rawSlug ?? null;
  const navigate = useNavigate();
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  const mayCreate = ready && can('ManageChannels');
  const { data, isLoading, error, refresh } = useFetch<{ channels: SocialChannel[] }>('/api/social/channels');
  const [creating, setCreating] = useState(false);
  // The dialog hangs off the header button: anchored, it is the library's
  // popover (Escape and outside-click close it, focus returns to the button);
  // centred, PopoverForm has no Escape handling (queued in ui-components-queue).
  const createRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const channels = data?.channels ?? [];
  const open = slug ? channels.find((c) => c.slug === slug) ?? null : null;
  const userId = session?.sub ?? '';
  const displayName = session?.name ?? userId;

  async function create(input: CreateChannelDialogInput): Promise<void> {
    const res = await writeJson<{ channel: SocialChannel }>('/api/social/channels', 'POST', {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      privacy: privacyForApi(input.privacy),
    });
    // A refusal (a duplicate name, a bad one) shows inline in the dialog.
    if (!res.ok || !res.data) throw new Error(res.error ?? 'The channel could not be created.');
    setCreating(false);
    refresh();
    navigate(channelHref(res.data.channel.slug));
  }

  async function membership(action: 'join' | 'leave', target: SocialChannel): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await writeJson<{ channel: SocialChannel }>(`/api/social/channels/${encodeURIComponent(target.slug)}/${action}`, 'POST');
    setBusy(false);
    if (!res.ok) { setActionError(res.error ?? `Could not ${action} #${target.slug}.`); return; }
    refresh();
  }

  const createButton = mayCreate
    ? <Button ref={createRef} variant="primary" size="sm" onClick={() => setCreating(true)} data-testid="social-create-channel">New channel</Button>
    : null;

  return (
    <Stack gap="lg" data-testid="social-channels-page">
      <PageHeader
        title="Channels"
        description="Conversations the whole workspace can join, one per topic or team."
        {...(createButton ? { actions: createButton } : {})}
      />
      <CreateChannelDialog open={creating} teamName="Social" anchor={mayCreate ? createRef : null} onCreate={create} onClose={() => setCreating(false)} data-testid="social-create-channel-dialog" />
      {actionError && <InlineAlert tone="error" onDismiss={() => setActionError(null)}>{actionError}</InlineAlert>}
      {isLoading && !data ? <LoadingState label="Loading channels…" /> : error && !data ? (
        <ErrorState title="Channels could not be loaded" description={error} actionLabel="Try again" onAction={refresh} />
      ) : channels.length === 0 ? (
        <EmptyState
          testId="social-empty-channels"
          align="start"
          title="No channels yet"
          description={mayCreate
            ? 'Channels are where a community talks in the open. None exist in this workspace yet — create the first one.'
            : 'Channels are where a community talks in the open. None exist in this workspace yet; a moderator can create one.'}
          {...(mayCreate ? { actionLabel: 'Create a channel', onAction: () => setCreating(true), actionTestId: 'social-empty-create-channel' } : {})}
        />
      ) : (
        <Inline gap="lg" align="stretch" wrap={false} className="min-h-[32rem]">
          <ConversationRail
            className="w-72 shrink-0"
            title="Channels"
            grouped={false}
            conversations={channelRailItems(channels)}
            selected={open ? { kind: 'conversation', channel: open.channel } : null}
            onSelect={(selection) => {
              if (selection.kind !== 'conversation') return;
              const next = slugFromChannel(selection.channel);
              if (next) navigate(channelHref(next));
            }}
            emptyLabel="No channels"
            data-testid="social-channel-rail"
          />
          {!slug ? (
            <EmptyState align="start" className="min-w-0 flex-1" title="Pick a channel" description="Choose a channel on the left to read it. Channels you have not joined show a Join button first." />
          ) : !open ? (
            <EmptyState align="start" className="min-w-0 flex-1" testId="social-channel-missing" title={`#${slug} is not available`} description="This channel does not exist, or it is private and you are not a member." />
          ) : open.joined ? (
            <SocialConversation
              key={open.channel}
              channel={open.channel}
              name={`#${open.slug}`}
              {...(open.description ? { description: open.description } : {})}
              memberCount={open.memberCount}
              userId={userId}
              displayName={displayName}
              placeholder={`Message #${open.slug}`}
              actions={<Button variant="ghost" size="sm" disabled={busy} onClick={() => void membership('leave', open)} data-testid="social-leave-channel">Leave</Button>}
            />
          ) : (
            <Stack gap="md" className="min-w-0 flex-1">
              <ChannelHeader name={`#${open.slug}`} {...(open.description ? { description: open.description } : {})} memberCount={open.memberCount} />
              <EmptyState
                align="start"
                testId="social-channel-not-joined"
                title={`You are not in #${open.slug}`}
                description="Join to read the conversation and post in it. Everyone in the channel will see you arrive."
                action={<Button variant="primary" size="sm" disabled={busy} onClick={() => void membership('join', open)} data-testid="social-join-channel">Join #{open.slug}</Button>}
              />
            </Stack>
          )}
        </Inline>
      )}
    </Stack>
  );
}
