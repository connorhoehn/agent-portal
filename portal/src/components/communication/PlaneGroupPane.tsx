// One of the user's groups opened on the Communication plane
// (docs/communication-plane-goal.md §1.3): an initiative (orgiq), a team
// (assessment) or a pipeline definition (pipelines) with no bound Social
// channel. The content column shows the group's own page discussion — the same
// chat family its page uses (`orgiq:initiative:<id>`, `assessment:team:<id>`,
// `pipelines:def:<id>`), drawn by the same `ConversationThread` composition, so
// the gateway's page read gate decides the subscribe and the family's write
// authority decides the composer — under the library `ChannelBindingStrip`,
// whose Bind is offered only to a ManageChannels holder (the BFF's
// `canManage`, routes/social.ts). A bound group never lands here: its row
// opens the bound channel's conversation.

import { useNavigate } from 'react-router';
import { ChannelBindingStrip } from '@connorhoehn/ui-components/social';
import { Button, ChannelHeader, EmptyState, ExternalLinkIcon, Inline, Stack, T } from '@connorhoehn/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { ChannelThread } from '../chat/ConversationThread';
import { useChannelBinding } from '../social/ChannelBindingStrip';
import { channelHref } from '../../pages/social/socialChat';
import { GROUP_DISCUSSION_LABEL, GROUP_NOUN, groupBindingContext, groupDiscussionChannel, groupPageHref, type PlaneGroup, type PlaneGroupKind } from './planeRailModel';
import type { PlaneOrg } from './usePlaneOrg';
import { CommunicationAccessState } from './CommunicationAccessState';

export function PlaneGroupPane({ org, group: ref, base }: { org: PlaneOrg; group: { kind: PlaneGroupKind; id: string }; base: string }) {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const group: PlaneGroup | null = org.groups.find((g) => g.kind === ref.kind && g.id === ref.id) ?? null;
  const context = groupBindingContext(ref);
  const binding = useChannelBinding(group ? context : null);
  if (!group) {
    if (org.groupsLoading) return <CommunicationAccessState state="loading" title="Loading your discussion…" detail="Finding this group in your workspace." />;
    if (org.groupsError) return <CommunicationAccessState state="unavailable" title="Your groups could not be loaded"
      detail="The group list is unavailable. Try again to open this discussion." onRetry={org.refreshGroups} />;
    return <EmptyState align="start" testId="plane-group-missing" title="Not one of your groups"
        description={`This plane lists your own ${GROUP_NOUN[org.tenant]}. Open the page itself to read its discussion.`}
        actionLabel="Open page" onAction={() => navigate(groupPageHref(ref))} />;
  }
  // The family's write authority (lib/tenant-channels.ts): DispatchAgentRun on an orgiq page,
  // ViewAssessment / ViewPipelines on the others. The gateway asks it again on every publish.
  const canPost = ready && can(group.kind === 'initiative' ? 'DispatchAgentRun' : group.kind === 'team' ? 'ViewAssessment' : 'ViewPipelines');
  const bound = binding.data?.binding ?? null;
  const openPage = (
    <Button variant="secondary" size="sm" onClick={() => navigate(groupPageHref(group))} data-testid="plane-group-open-page">
      <Inline gap="xs" align="center" wrap={false}>Open page<ExternalLinkIcon size={14} /></Inline>
    </Button>
  );
  return (
    <Stack gap="sm" className="min-h-0 min-w-0 flex-1" data-testid="plane-group-pane" data-group={`${group.kind}:${group.id}`}>
      <ChannelHeader name={group.name} size="sm" actions={openPage} data-testid="plane-group-header" />
      {!bound && <T size="xs" tone="secondary" data-testid="plane-group-destination">{GROUP_DISCUSSION_LABEL[group.kind]}</T>}
      {context && binding.data && (bound || binding.data.canManage) && (
        <ChannelBindingStrip label="Channel" data-testid="plane-group-binding"
          {...(bound ? { channel: { name: bound.slug ?? bound.name, ...(bound.privacy ? { privacy: bound.privacy } : {}) } } : {})}
          {...(bound && bound.slug ? { onOpen: () => navigate(channelHref(bound.slug!, base)), openLabel: 'Open channel' } : {})}
          unboundLabel="Add a channel"
          {...(!bound && binding.data.canManage ? {
            choices: binding.data.choices.map((c) => ({ value: c.channel, label: `#${c.slug}${c.privacy === 'private' ? ' (private)' : ''}` })),
            onBind: async (value: string) => { await binding.bind(value); org.refreshBindings(); },
          } : {})}
          {...(bound && binding.data.canManage ? { onUnbind: async () => { await binding.unbind(); org.refreshBindings(); } } : {})}
          busy={binding.busy} error={binding.writeError} />
      )}
      <ChannelThread key={groupDiscussionChannel(group)} channel={groupDiscussionChannel(group)} maySend={canPost} title={GROUP_DISCUSSION_LABEL[group.kind]}
        confirmHistory composer={{ answersFocus: true }}
        emptyState={<EmptyState align="start" testId="scope-discussion-empty"
          title={canPost ? 'Start the conversation' : 'No messages yet'}
          description={canPost ? 'Use the composer below to discuss this group’s work.' : 'This group’s discussion has no messages yet.'} />}
        notices pins={{ canPin: canPost }} attachments={canPost} reactions placeholder={`Message the ${GROUP_DISCUSSION_LABEL[group.kind].toLowerCase()}…`}
        data-testid="scope-discussion-panel" />
    </Stack>
  );
}
