// The Communication plane's landing (docs/layout-cascade.md rule 6: always
// some content). With no conversation named, the user's own default opens
// directly — the first of their groups whose bound Social channel they are in,
// else their most recent conversation (landingModel.ts). With none, the
// overview at the app's body step (14px headings and rows, 12px meta):
// Active now (the rail's tiles), their groups with unread and live markers,
// the latest work shared by the people here, and the channels they can join
// behind a small "Join a channel" button.

import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { useNavigate } from 'react-router';
import { ActionRowList } from '@connorhoehnslalom/ui-components';
import { ActivePeopleGrid } from '@connorhoehnslalom/ui-components/social';
import { Button, LoadingState, PageSection, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { landingDecision } from './landingModel';
import {
  GROUP_NOUN, groupBindingContext, groupDiscussionChannel, groupRowKey, groupRowPreview, unreadFor,
} from './planeRailModel';
import type { PlaneActivePerson } from './planeSharingModel';
import type { PlaneOrg } from './usePlaneOrg';

/** How long a binding read may stay unanswered before the recent conversation decides. */
const BINDINGS_WAIT_MS = 2_000;

export interface CommunicationLandingProps {
  base: string;
  org: PlaneOrg;
  ready: boolean;
  channels: ReadonlyArray<{ slug: string; name: string; joined: boolean; memberCount: number; description: string | null; lastMessageAt: string | null }>;
  conversations: ReadonlyArray<{ channel: string; lastMessageAt: string | null }>;
  activePeople: ComponentProps<typeof ActivePeopleGrid>['people'];
  active: ReadonlyMap<string, PlaneActivePerson>;
  liveLobbies: ReadonlySet<string>;
  /** A group row (`plane-group:…`): its bound channel, or its page discussion here. */
  onSelectGroup(rowKey: string): void;
  onMessage(userId: string): void;
  onSharedWork(userId: string): void;
}

export function CommunicationLanding(props: CommunicationLandingProps) {
  const { base, org, ready, channels, conversations } = props;
  const navigate = useNavigate();
  const [waitedLong, setWaitedLong] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaitedLong(true), BINDINGS_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const decision = landingDecision({ ready, groups: org.groups, groupsLoading: org.groupsLoading, bindings: org.bindings, channels, conversations }, base, waitedLong);
  const href = decision.kind === 'open' ? decision.href : null;
  useEffect(() => { if (href) navigate(href, { replace: true }); }, [href, navigate]);

  if (decision.kind !== 'overview') return <LoadingState label="Opening your conversations…" testId="communication-landing-opening" />;
  return <Overview {...props} />;
}

function Overview({ org, channels, activePeople, active, liveLobbies, onSelectGroup, onMessage, onSharedWork, base }: CommunicationLandingProps) {
  const navigate = useNavigate();
  const noun = GROUP_NOUN[org.tenant];
  const groupItems = org.groups.map((group) => {
    const context = groupBindingContext(group);
    const binding = context ? org.bindings.get(context)?.binding ?? null : null;
    const discussion = groupDiscussionChannel(group);
    const unread = unreadFor(discussion, org.unreadThreads);
    const live = liveLobbies.has(discussion) || (!!binding && liveLobbies.has(binding.channel));
    return {
      id: groupRowKey(group), title: group.name,
      description: groupRowPreview(group, { binding }),
      meta: [live ? 'Live huddle' : null, unread ? `${unread} unread` : null].filter(Boolean).join(' · ') || undefined,
    };
  });
  const names = useMemo(() => new Map(activePeople.map((p) => [p.userId, p.displayName])), [activePeople]);
  const shared = [...active.values()].filter((a) => a.workSharing && names.has(a.userId))
    .sort((a, b) => Number(b.workSharing?.state === 'active') - Number(a.workSharing?.state === 'active'))
    .map((a) => ({
      id: a.userId, title: names.get(a.userId)!,
      description: a.activity ?? (a.workSharing?.state === 'active' ? 'Sharing work now' : 'Shared work earlier'),
      meta: a.workSharing?.state === 'active' ? 'Now' : 'Earlier',
    }));
  const joinable = channels.filter((c) => !c.joined);
  const channelPath = (slug: string) => `${base}/channels/${encodeURIComponent(slug)}`;
  const groupsEmpty = org.linked === false ? 'Link your account to a person to see your groups.'
      : org.groupsError ? `Couldn’t load your ${noun} — ${org.groupsError}.`
        : org.groupsLoading ? 'Loading…' : `You are not on any ${noun} yet.`;

  return (
    <Stack gap="lg" className="min-h-0 min-w-0 flex-1 overflow-auto" data-testid="communication-overview">
      <T as="p" size="xs" tone="secondary" wrap data-testid="communication-overview-meta">
        You are not in a conversation yet. Join a channel, message someone who is here, or open one of your {noun}.
      </T>
      <PageSection size="sm" title="Active now" count={activePeople.length} data-testid="communication-overview-active">
        <ActivePeopleGrid people={activePeople} maxVisible={12} columns="fit" emptyLabel="Nobody else is here right now."
          onSelectPerson={onMessage} onSelectSharedWork={onSharedWork} data-testid="communication-overview-active-grid" />
      </PageSection>
      <PageSection size="sm" title={`Your ${noun}`} count={groupItems.length} data-testid="communication-overview-groups">
        <ActionRowList aria-label={`Your ${noun}`} items={groupItems} emptyLabel={<T size="xs" tone="tertiary">{groupsEmpty}</T>}
          onOpen={(row) => onSelectGroup(row.id)} data-testid="communication-overview-group-rows" />
      </PageSection>
      <PageSection size="sm" title="Latest shared work" count={shared.length} data-testid="communication-overview-shared">
        <ActionRowList aria-label="Latest shared work" items={shared}
          emptyLabel={<T size="xs" tone="tertiary">Nobody here is sharing work right now.</T>}
          onOpen={(row) => onSharedWork(row.id)} data-testid="communication-overview-shared-rows" />
      </PageSection>
      <PageSection size="sm" title="Channels you can join" count={joinable.length} data-testid="communication-overview-channels"
        {...(joinable[0] ? {
          actions: <Button variant="primary" size="sm" onClick={() => navigate(channelPath(joinable[0]!.slug))} data-testid="communication-join-channel">Join a channel</Button>,
        } : {})}>
        <ActionRowList aria-label="Channels you can join" action="Open"
          items={joinable.map((c) => ({ id: c.slug, title: `#${c.slug}`, description: c.description ?? c.name, meta: `${c.memberCount} ${c.memberCount === 1 ? 'member' : 'members'}` }))}
          emptyLabel={<T size="xs" tone="tertiary">There are no other channels to join.</T>}
          onOpen={(row) => navigate(channelPath(row.id))} data-testid="communication-overview-channel-rows" />
      </PageSection>
    </Stack>
  );
}
