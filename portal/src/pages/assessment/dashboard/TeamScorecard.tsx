// VIEW 3 — team scorecard: one header in rows, the tab strip (Certification ·
// Improvement Plan · Stories · Evidence & Intake · Documents · Activity) in
// it, all panes kept MOUNTED (toggled via `hidden`) so dimension selection,
// expanded plan entries, and intake form state survive round-trips between
// tabs — exactly the source's TeamScorecard.tsx behaviour.
//
// The header (the user, 2026-10-07: "get things into rows together so I can
// have more space for the content and then the chat") is the library
// `PageHeader`: row 1 the title, the cohort pill, status · updated, the info
// card, the collapse chevron and the actions; row 2 (comfortable only) the
// coverage as ONE `StatStrip variant="line" size="sm"` — the verified level
// with its progress toward the target drawn inline, assessed, open
// follow-ups, workflow step; then the tabs. The certification sentences, the
// six-step workflow and the evidence-coverage strip — what the retired
// "Assessment progress & evidence coverage" bar held — live in the title's
// info card. Rich content (the Activity graph) takes the compact header, the
// facts moving into that card too.
//
// The team's realtime context (realtime-parity gap 3): its discussion and its
// huddle share one family, `assessment:team:<id>`, which the BFF gateway admits
// with GET /teams/:id's own authority (ViewAssessment in the active assessment
// tenant, and the team row now). The page registers it with the shell's call
// host, so the footer reads "<team> huddle". The discussion is the shell's
// right pane (the library `SidePane`, as on the initiative page), open by
// default and not a tab; `?tab=discussion` lands on Certification with the
// pane revealed. The pane draws the thread only (the user, 2026-10-07: "keep
// the chat in the main content… just keep the dialogue thread there"): on
// Certification the dimension composer in the content column is the thread's
// one input; on the other tabs a team composer is docked at the bottom of the
// content column instead.

import { useCrumbLabel } from '../../../lib/crumbLabels';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { SidePane, useSidePane } from '@connorhoehnslalom/ui-components';
import {
  Button,
  Chip,
  PageSection,
  DropdownMenu,
  Drawer,
  T,
  ErrorState,
  HeaderDescriptionInfo,
  Inline,
  Link,
  LoadingState,
  DetailSection,
  PageHeader,
  Stack,
  StatStrip,
  WorkflowStepper,
  useHeaderDensity,
  type StatStripItem,
} from '@connorhoehnslalom/ui-components/shared';
import { usePageHuddleComposer } from '../../../components/shell/HuddleComposerDock';
import { ConversationPaneBody, useConversationPane } from '../../../components/shell/ConversationPane';
import { WorkGraphActivity } from '../../../components/work-graph/WorkGraphActivity';
import { useShellBreadcrumbItems } from '../../../components/shell/Breadcrumbs';
import { Can, useCapabilities } from '../../../lib/capabilities';
import { ConversationOwner, ConversationThread, type ConversationRuntime } from '../../../components/chat/ConversationThread';
import { ConversationComposer } from '../../../lib/conversationComposer';
import { useCallBlock } from '../../../lib/conversationCall';
import { DimensionMasterDetail } from './DimensionMasterDetail';
import { renderDimensionReference } from './DimensionReferenceCard';
import { teamDiscussionChannel } from './dimensionComposerModel';
import { EvidenceCoverage } from './EvidenceCoverage';
import { EvidenceIntake } from './EvidenceIntake';
import { ExceptionsModal } from './ExceptionsModal';
import { ImprovementPlan } from './ImprovementPlan';
import { ScoringLogsDrawer } from './ScoringLogsDrawer';
import { StoriesPanel } from './StoriesPanel';
import { TeamActionsMenu } from './TeamActionsMenu';
import { TeamFiles } from './TeamFiles';
import { useTeamDetail } from './useTeamDetail';
import { SCORECARD_TABS, scorecardFacts, type ScorecardTab } from './scorecardHeaderModel';
import { fmtDate, teamCertificationHeadline, teamCertificationSubline } from '../types';
import { formatTeamStatus } from '../assessmentFormat';
import { relativeTime } from '../../../lib/relativeTime';

export type { ScorecardTab } from './scorecardHeaderModel';

/** The team page's realtime family: its discussion and its huddle lobby. */
export const teamChannel = teamDiscussionChannel;
const READER_REASON = 'Your current role cannot read this team — ask an assessment lead for access';

interface TeamScorecardProps {
  teamId: string;
  tab: ScorecardTab;
  onTabChange: (tab: ScorecardTab) => void;
  /** The URL asked for the retired Discussion tab: reveal the right pane (then the host drops the param). */
  revealDiscussion?: boolean;
}

export function TeamScorecard({ teamId, tab, onTabChange, revealDiscussion = false }: TeamScorecardProps) {
  const navigate = useNavigate();
  const { data, isLoading, isError, notFound, refresh } = useTeamDetail(teamId);
  // `?dimension=<id>` opens that dimension (a dimension reference card's Open lands here).
  const [searchParams] = useSearchParams();
  const linkedDimension = searchParams.get('dimension');
  const [selectedDimId, setSelectedDimId] = useState<string | null>(linkedDimension);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [exceptionsOpen, setExceptionsOpen] = useState(false);
  const [scoringLogsOpen, setScoringLogsOpen] = useState(false);
  // Certification ('scorecard') is always mounted; the other panes mount on
  // FIRST selection and stay mounted afterward (never unmounted once
  // visited), so a team open costs only the certification pane's reads
  // (ImprovementPlan/StoriesPanel/EvidenceIntake each fetch on mount) instead
  // of all of them, while tab-switch state (e.g. EvidenceIntake's form) still
  // survives round-trips exactly as it did when every pane stayed mounted.
  const [visited, setVisited] = useState<Set<ScorecardTab>>(() => new Set<ScorecardTab>(['scorecard', tab]));
  // The header's density (library useHeaderDensity): the Activity graph is
  // rich content — the one-row compact header, the facts and certification
  // lines moving into the title's info card; the other tabs keep the
  // comfortable header. The chevron is remembered per device.
  const headerDensity = useHeaderDensity({ contentKind: tab === 'activity' ? 'graph' : 'detail', headerId: 'assessment-scorecard' });
  const compact = headerDensity.headerProps.density === 'compact';
  const { can } = useCapabilities();
  const mayRead = can('ViewAssessment');
  const loaded = !!data && !isLoading && !notFound && !isError;
  const channel = loaded ? teamChannel(data.team.id) : null;
  // The right pane is the thread; its one input is in the content column — the
  // dimension composer on Certification, the team composer on the other tabs.
  const sidePane = useSidePane();
  const conversationPane = useConversationPane({ enabled: loaded });
  const huddleComposer = usePageHuddleComposer();
  const breadcrumbs = useShellBreadcrumbItems();
  const teamComposerShown = tab !== 'scorecard';
  // The team's huddle: its lobby is the team's channel (the footer's Huddle walks into it);
  // the team composer carries its call block off Certification.
  const { block: teamBlock } = useCallBlock(channel, { enabled: teamComposerShown,
    bind: { title: `${data?.team.name ?? teamId} huddle`, ...(mayRead ? {} : { blockedReason: READER_REASON }) } });
  // The team's ONE Discussion: the pane's thread and both composers share it.
  const [conversation, setConversation] = useState<ConversationRuntime | null>(null);
  // `?tab=discussion` (old links, bell items): Certification with the pane on screen.
  const tabChange = useRef(onTabChange);
  tabChange.current = onTabChange;
  useEffect(() => {
    if (!revealDiscussion) return;
    sidePane.reveal();
    tabChange.current('scorecard');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealDiscussion]);

  // Switching teams collapses any dimension selection back to the team level,
  // and resets which non-default panes have been opened for the new team.
  useEffect(() => { setSelectedDimId(null); setVisited(new Set<ScorecardTab>(['scorecard', tab]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);
  useEffect(() => { if (linkedDimension) setSelectedDimId(linkedDimension); }, [teamId, linkedDimension]);
  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  // The trail reads the team, not TEAM-001 (before the early returns: a hook).
  useCrumbLabel(teamId, data?.team.name ?? null);
  if (isLoading) return <LoadingState label="Loading certification…" />;
  // A 404 is a wrong id (typed, stale link, deleted team) — say so and offer
  // the way back, rather than the outage copy a real failure gets below.
  if (notFound) {
    return (
      <PageSection title={`No team ${teamId ?? ''}`.trim()}>
        <ErrorState title="Team not found" body="There is no team with this id. It may have been deleted, or the link is out of date."
          actionLabel="Back to the dashboard" onAction={() => navigate('/assessment/teams')} />
      </PageSection>
    );
  }
  if (isError || !data) {
    return (
      <ErrorState
        title="Couldn't load this team's certification"
        body="The assessment API may be unavailable — try refreshing."
      />
    );
  }

  const { team, workflow_steps, dimensions } = data;
  const certHeadline = teamCertificationHeadline(team.certification) ?? 'Not yet assessed';
  const certSubline = teamCertificationSubline(team.certification, team.dimensions_total);
  const activeStep = workflow_steps.find((s) => s.active);
  const dimensionTitle = (dimensionId: string) => dimensions.find((d) => d.id === dimensionId)?.title ?? dimensionId;
  // Short enough to share the title row with the actions; the full date is its tooltip.
  const updated = relativeTime(team.updated_at);
  const statusLine = [formatTeamStatus(team.status), updated].filter(Boolean).join(' · ');
  const facts = (
    <StatStrip
      variant="line"
      aria-label="Assessment coverage"
      data-testid="scorecard-facts"
      items={scorecardFacts(team, activeStep?.label).map((fact): StatStripItem => ({
        label: fact.label, value: fact.value, tone: fact.tone, title: fact.title, ...(fact.progress ? { progress: fact.progress } : {}),
      }))}
    />
  );

  return (
    // A flush page (data-shell-flush): the header prints the shell's trail as its
    // first row, at the 24px gutter, and the dimension rail below sits flush
    // against the shell rail — so the trail, the title row, the facts and the
    // tabs are one block (the initiative page's frame).
    <Stack gap="none" className="h-full min-h-0 min-w-0 bg-surface" data-shell-flush ref={headerDensity.contentRef}>
      <Stack gap="none" className="shrink-0 px-6">
      <PageHeader
        {...headerDensity.headerProps}
        breadcrumbs={breadcrumbs}
        title={team.name}
        badge={
          <Inline gap="sm" align="center" wrap={false} className="min-w-0">
            <Chip tone="accent" uppercase size="xs">{team.cohort_label}</Chip>
            <T size="xs" tone="secondary" className="truncate" title={`Updated ${fmtDate(team.updated_at)}`} data-testid="scorecard-status">{statusLine}</T>
          </Inline>
        }
        // The why behind the row: the certification sentences, the workflow
        // and the evidence coverage (the retired coverage bar), and in compact
        // density the facts the row no longer shows.
        info={
          <HeaderDescriptionInfo
            title={team.name}
            width="xl"
            data-testid="page-header-description"
            description={
              <Stack gap="sm" className="whitespace-normal">
                {compact && facts}
                <T size="sm" tone="primary" wrap>{certHeadline}</T>
                {certSubline && <T size="xs" tone="secondary" wrap>{certSubline}</T>}
                <WorkflowStepper steps={workflow_steps} className="py-1" />
                <EvidenceCoverage dimensions={dimensions} />
              </Stack>
            }
          />
        }
        actions={
          <Inline gap="sm" align="center" wrap>
            <Button variant="secondary" size="sm" onClick={() => setDetailsOpen(true)}>Team details</Button>
            <DropdownMenu trigger="Review" triggerClassName="text-xs px-2.5 py-1" triggerLabel="Assessment review actions" align="end" sections={[{ items: [
              { label: 'Exceptions', onSelect: () => setExceptionsOpen(true) },
              { label: 'How it was assessed', onSelect: () => setScoringLogsOpen(true) },
              { label: 'Printable report', onSelect: () => { window.open(`/assessment/reports?team=${encodeURIComponent(team.id)}`, '_blank', 'noopener,noreferrer'); } },
            ] }]} />
            <Can do="ScoreAssessment">
              <Button variant="primary" size="sm" onClick={() => onTabChange('evidence')}>
                + Add evidence
              </Button>
            </Can>
            <TeamActionsMenu
              teamId={team.id}
              teamName={team.name}
              currentLead={team.assessment_lead}
              onChanged={refresh}
              onDeleted={() => navigate('/assessment/teams')}
            />
          </Inline>
        }
        // Row 2, comfortable only: the coverage in one line.
        meta={facts}
        tabs={[...SCORECARD_TABS]}
        activeTab={tab}
        onTabChange={(id) => onTabChange(id as ScorecardTab)}
      />
      </Stack>

      {/* Every pane stays mounted once visited — toggled with `hidden`, not
          unmounted — so selection/form state in each survives switching tabs. */}
      <Stack hidden={tab !== 'scorecard'} gap="none" className="flex-1 min-h-0">
        <DimensionMasterDetail dimensions={dimensions} selectedId={selectedDimId} onSelect={setSelectedDimId} teamId={team.id} teamName={team.name}
          onChanged={refresh} active={tab === 'scorecard'} conversation={conversation} />
      </Stack>

      {visited.has('plan') && (
        <Stack hidden={tab !== 'plan'} className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
          <ImprovementPlan teamId={team.id} />
        </Stack>
      )}

      {visited.has('stories') && (
        <Stack hidden={tab !== 'stories'} className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
          <StoriesPanel teamId={team.id} />
        </Stack>
      )}

      {visited.has('evidence') && (
        <Stack hidden={tab !== 'evidence'} className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
          <EvidenceIntake teamId={team.id} />
        </Stack>
      )}

      {visited.has('documents') && <Stack hidden={tab !== 'documents'} gap="none" className="min-h-0 flex-1">
        <TeamFiles key={team.id} teamId={team.id} teamName={team.name} />
      </Stack>}

      {/* The team's own activity graph (dimensions assessed, evidence, drafts, decks, agent runs): the same
          projection and stream as /assessment/activity, scoped to this team. Mounts on first visit. */}
      {visited.has('activity') && mayRead && (
        <Stack hidden={tab !== 'activity'} gap="none" className="flex-1 min-h-0 px-6 pt-3" data-testid="team-activity">
          <WorkGraphActivity subject={{ kind: 'team', id: team.id }} cursorChannel={teamChannel(team.id)} title={team.name} mode="full" className="h-full min-h-0 w-full" />
        </Stack>
      )}

      {/* Off Certification, the team discussion's one composer, docked at the
          bottom of the content column (the pane beside it is the thread). */}
      {channel && <ConversationOwner key={channel} channel={channel} maySend={mayRead} onChange={setConversation} />}
      {teamComposerShown && channel && conversation && (
        <Stack gap="none" className="shrink-0 pt-2" data-testid="team-discussion-composer-dock">
          <ConversationComposer key={huddleComposer.editorKey} channel={channel} chat={conversation.chat} context={{ kind: 'conversation', id: team.id, title: team.name }}
            capabilities={{ maySend: mayRead, readOnlyReason: READER_REASON }} label="Team discussion composer"
            offline={conversation.connected ? null : 'The realtime gateway is not connected, so the discussion is unavailable.'}
            identity={{ userId: conversation.userId, displayName: conversation.displayName }} reply={conversation.quote}
            commands={conversation.commands} callBlock={teamBlock} modePlaceholders={{ chat: 'Message the team discussion…' }}
            recipients={[
              { id: 'discussion', label: 'Team discussion', channel,
                send: out => { conversation.chat.sendMessage(out.text, out.metadata); return true; } },
              ...(huddleComposer.recipient ? [huddleComposer.recipient] : []),
            ]}
            {...huddleComposer.composerProps}
            claim={{ label: 'the team composer', enabled: teamComposerShown }}
            answersFocus={mayRead} onReveal={() => sidePane.reveal()}
            data-testid="team-discussion-composer" />
        </Stack>
      )}

      {/* The right pane (the shell's fourth column, the library SidePane):
          the team discussion with its Chat / Pinned / Files / Calls views. */}
      <SidePane title={conversationPane.inHuddle ? 'Huddle dialogue' : 'Discussion'} subtitle={conversationPane.inHuddle ? conversationPane.huddle?.title : team.name} closeLabel="Collapse discussion" data-testid="team-pane">
        <ConversationPaneBody pane={conversationPane} pageLabel="Team discussion">
        <Stack gap="none" className="min-h-0 flex-1" data-testid="team-discussion">
          {conversation && <ConversationThread key={team.id} conversation={conversation} title="Team discussion" input="below" notices
            pins={{ canPin: mayRead }} attachments={mayRead} reactions renderMessageReferences={renderDimensionReference}
            data-testid="scope-discussion-panel" />}
        </Stack>
        </ConversationPaneBody>
      </SidePane>

      <Drawer open={detailsOpen} onClose={() => setDetailsOpen(false)} title="Team details" width={420}>
        <Stack gap="md" className="p-4">
          <T size="sm" tone="primary">{team.name}</T>
          <DetailSection title="Assessment lead">
            <T>{team.assessment_lead || 'Unassigned'}</T>
          </DetailSection>
          <DetailSection title={`Repositories (${team.repos.length})`}>
            <Stack gap="sm" data-testid="team-repos">
              {team.repos.length === 0 && <T>No repositories on file</T>}
              {team.repos.map((repo) => <Link key={repo.gitlab_url || repo.name} href={repo.gitlab_url} external className="break-all">{repo.name}</Link>)}
            </Stack>
          </DetailSection>
          <DetailSection title="Contacts">
            <Stack gap="sm">
              {team.contacts.length === 0 && <T>No contacts on file</T>}
              {team.contacts.map((contact) => <T key={contact} size="sm" className="break-all">{contact}</T>)}
            </Stack>
          </DetailSection>
        </Stack>
      </Drawer>
      <ExceptionsModal
        open={exceptionsOpen}
        onClose={() => setExceptionsOpen(false)}
        teamId={team.id}
        dimensionTitle={dimensionTitle}
      />
      <ScoringLogsDrawer
        open={scoringLogsOpen}
        onClose={() => setScoringLogsOpen(false)}
        teamId={team.id}
        dimensionTitle={dimensionTitle}
      />
    </Stack>
  );
}
