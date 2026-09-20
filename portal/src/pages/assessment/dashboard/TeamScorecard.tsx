// VIEW 3 — team scorecard: slim header bar, tab strip (Certification ·
// Improvement Plan · Stories · Evidence & Intake · Documents), all panes kept
// MOUNTED (toggled via `hidden`) so dimension selection, expanded plan
// entries, and intake form state survive round-trips between tabs — exactly
// the source's TeamScorecard.tsx behaviour. `Tabs` drives the strip; panes
// are hand-managed (not `TabPanel`, which unmounts) to get that persistence.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Card,
  CollapsibleSection,
  Chip,
  EmptyState,
  DropdownMenu,
  Drawer,
  T,
  ErrorState,
  Inline,
  Link,
  LoadingState,
  DetailSection,
  PageHeader,
  Stack,
  StatStrip,
  Tabs,
  WorkflowStepper,
  type TabItem,
} from '@connorhoehnslalom/ui-components/shared';
import { Can } from '../../../lib/capabilities';
import { DimensionMasterDetail } from './DimensionMasterDetail';
import { EvidenceCoverage } from './EvidenceCoverage';
import { EvidenceIntake } from './EvidenceIntake';
import { ExceptionsModal } from './ExceptionsModal';
import { ImprovementPlan } from './ImprovementPlan';
import { ScoringLogsDrawer } from './ScoringLogsDrawer';
import { StoriesPanel } from './StoriesPanel';
import { TeamActionsMenu } from './TeamActionsMenu';
import { useTeamDetail } from './useTeamDetail';
import { fmtDate, teamCertificationHeadline, teamCertificationSubline } from '../types';

type ScorecardTab = 'scorecard' | 'plan' | 'stories' | 'evidence' | 'documents';

const TABS: TabItem[] = [
  { id: 'scorecard', label: 'Certification' },
  { id: 'plan', label: 'Improvement Plan' },
  { id: 'stories', label: 'Stories' },
  { id: 'evidence', label: 'Evidence & Intake' },
  { id: 'documents', label: 'Documents' },
];

interface TeamScorecardProps {
  teamId: string;
  tab: ScorecardTab;
  onTabChange: (tab: ScorecardTab) => void;
}

export function TeamScorecard({ teamId, tab, onTabChange }: TeamScorecardProps) {
  const navigate = useNavigate();
  const { data, isLoading, isError, notFound, refresh } = useTeamDetail(teamId);
  const [selectedDimId, setSelectedDimId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [exceptionsOpen, setExceptionsOpen] = useState(false);
  const [scoringLogsOpen, setScoringLogsOpen] = useState(false);
  // Certification ('scorecard') is always mounted; the other four panes mount
  // on FIRST selection and stay mounted afterward (never unmounted once
  // visited), so a team open costs only the certification pane's reads
  // (ImprovementPlan/StoriesPanel/EvidenceIntake each fetch on mount) instead
  // of all five, while tab-switch state (e.g. EvidenceIntake's form) still
  // survives round-trips exactly as it did when every pane stayed mounted.
  const [visited, setVisited] = useState<Set<ScorecardTab>>(() => new Set<ScorecardTab>(['scorecard', tab]));

  // Switching teams collapses any dimension selection back to the team level,
  // and resets which non-default panes have been opened for the new team.
  useEffect(() => { setSelectedDimId(null); setVisited(new Set<ScorecardTab>(['scorecard', tab]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);
  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  if (isLoading) return <LoadingState label="Loading certification…" />;
  // A 404 is a wrong id (typed, stale link, deleted team) — say so and offer
  // the way back, rather than the outage copy a real failure gets below.
  if (notFound) {
    return (
      <EmptyState
        title={`No team ${teamId ?? ''}`.trim()}
        body="There is no team with this id. It may have been deleted, or the link is out of date."
        actionLabel="Back to the dashboard"
        onAction={() => navigate('/assessment/teams')}
      />
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
  const verifiedLevel =
    team.certification?.max_verified_level ?? team.certification?.highest_verified_level ?? null;
  const certSubline = teamCertificationSubline(team.certification, team.dimensions_total);
  const activeStep = workflow_steps.find((s) => s.active);
  const dimensionTitle = (dimensionId: string) => dimensions.find((d) => d.id === dimensionId)?.title ?? dimensionId;

  return (
    <Stack gap="lg">
      <PageHeader
        className="[&>div]:flex-wrap"
        title={team.name}
        badge={<Chip tone="accent" uppercase size="xs">{team.cohort_label}</Chip>}
        description={`${team.status} · Updated ${fmtDate(team.updated_at)}`}
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
      />

      <StatStrip
        className="max-lg:grid max-lg:grid-cols-2 max-lg:divide-x-0"
        items={[
          {
            label: 'Highest verified',
            value: verifiedLevel != null ? `L${verifiedLevel}` : 'Not yet assessed',
            tone: verifiedLevel != null ? 'accent' : 'default',
            hint: 'Across assessed dimensions',
          },
          { label: 'Assessed', value: `${team.dimensions_assessed}/${team.dimensions_total}` },
          { label: 'Open follow-ups', value: team.followups_open, tone: team.followups_open > 0 ? 'danger' : 'default' },
          { label: 'Workflow step', value: activeStep?.label ?? team.workflow_step_label },
        ]}
      />

      <Stack gap="xs" className="px-1">
        <T className="text-sm text-text-primary">{certHeadline}</T>
        {certSubline && <T className="text-xs text-text-secondary">{certSubline}</T>}
      </Stack>

      <Tabs idPrefix="scorecard" aria-label="Team scorecard" items={TABS} value={tab} onValueChange={(id) => onTabChange(id as ScorecardTab)} />

      {/* All five panes stay mounted — toggled with `hidden`, not unmounted —
          so selection/form state in each survives switching tabs. */}
      <Stack hidden={tab !== 'scorecard'} gap="lg">
        <CollapsibleSection title="Assessment progress & evidence coverage" defaultOpen={false} storageKey="assessment.scorecard.overview">
          <Stack gap="md">
            <Card padding="sm" className="overflow-x-auto">
              <WorkflowStepper steps={workflow_steps} size="sm" />
            </Card>
            <EvidenceCoverage dimensions={dimensions} />
          </Stack>
        </CollapsibleSection>
        <DimensionMasterDetail dimensions={dimensions} selectedId={selectedDimId} onSelect={setSelectedDimId} />
      </Stack>

      {visited.has('plan') && (
        <Stack hidden={tab !== 'plan'}>
          <ImprovementPlan teamId={team.id} />
        </Stack>
      )}

      {visited.has('stories') && (
        <Stack hidden={tab !== 'stories'}>
          <StoriesPanel teamId={team.id} />
        </Stack>
      )}

      {visited.has('evidence') && (
        <Stack hidden={tab !== 'evidence'}>
          <EvidenceIntake teamId={team.id} />
        </Stack>
      )}

      <Stack hidden={tab !== 'documents'}>
        <EmptyState
          title="Documents live in Workspace"
          body="This team's documents are in the Informatics › Workspace explorer, alongside the shared enterprise context."
          actionLabel="Open Workspace"
          onAction={() => navigate('/assessment/workspace')}
        />
      </Stack>

      <Drawer open={detailsOpen} onClose={() => setDetailsOpen(false)} title="Team details" width={420}>
        <Stack gap="md" className="p-4">
          <T className="text-sm text-text-primary">{team.name}</T>
          <DetailSection title="Assessment lead">
            <T>{team.assessment_lead || 'Unassigned'}</T>
          </DetailSection>
          <DetailSection title={`Repositories (${team.repos.length})`}>
            <Stack gap="sm" data-testid="team-repos">
              {team.repos.length === 0 && <T>No repositories on file</T>}
              {team.repos.map((repo) => <Link key={repo.gitlab_url || repo.name} href={repo.gitlab_url} external className="break-all text-sm">{repo.name}</Link>)}
            </Stack>
          </DetailSection>
          <DetailSection title="Contacts">
            <Stack gap="sm">
              {team.contacts.length === 0 && <T>No contacts on file</T>}
              {team.contacts.map((contact) => <T key={contact} className="break-all text-sm">{contact}</T>)}
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
