// VIEW 3 — team scorecard: slim header bar, tab strip (Certification ·
// Improvement Plan · Stories · Evidence & Intake · Documents), all panes kept
// MOUNTED (toggled via `hidden`) so dimension selection, expanded plan
// entries, and intake form state survive round-trips between tabs — exactly
// the source's TeamScorecard.tsx behaviour. `Tabs` drives the strip; panes
// are hand-managed (not `TabPanel`, which unmounts) to get that persistence.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Breadcrumbs as InlineBreadcrumbs,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  PageHeader,
  Stack,
  StatStrip,
  Tabs,
  WorkflowStepper,
  type TabItem,
} from '@connorhoehnslalom/ui-components/shared';
import { Can } from '../../../lib/capabilities';
import { DimensionMasterDetail } from './DimensionMasterDetail';
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
  const [exceptionsOpen, setExceptionsOpen] = useState(false);
  const [scoringLogsOpen, setScoringLogsOpen] = useState(false);

  // Switching teams collapses any dimension selection back to the team level.
  useEffect(() => { setSelectedDimId(null); }, [teamId]);

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
  const selectedDimension = tab === 'scorecard' ? dimensions.find((d) => d.id === selectedDimId) ?? null : null;
  const dimensionTitle = (dimensionId: string) => dimensions.find((d) => d.id === dimensionId)?.title ?? dimensionId;

  return (
    <Stack gap="lg">
      {/* No `back` here — the shell's breadcrumbs already render
          Assessment › Teams › <team>, and the dimension crumb below extends
          it live, so a second "← Teams" would be two doors to the same
          place stacked on top of each other. */}
      <PageHeader
        title={team.name}
        badge={<Chip tone="accent" uppercase size="xs">{team.cohort_label}</Chip>}
        description={`${team.status} · Updated ${fmtDate(team.updated_at)}`}
        actions={
          <Inline gap="sm" align="center">
            <Button variant="secondary" size="sm" onClick={() => setExceptionsOpen(true)}>
              Exceptions
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setScoringLogsOpen(true)}>
              How it was assessed
            </Button>
            {/* Opens in a new tab: the report is a printable, self-contained
                page and the scorecard should still be here when it closes. */}
            <Button
              variant="secondary"
              size="sm"
              title="Printable full report — save as PDF from the print dialog"
              onClick={() => window.open(`/assessment/reports?team=${encodeURIComponent(team.id)}`, '_blank', 'noopener,noreferrer')}
            >
              Report
            </Button>
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

      {/* A name, not a link — this tenant has no org-graph person behind it
          (see the note on TeamSummary in ../types.ts). */}
      <Inline gap="xs" align="center" className="text-xs text-text-secondary">
        Lead: {team.assessment_lead || 'Unassigned'}
      </Inline>

      <StatStrip
        frameless
        items={[
          // A stat strip value is a NUMBER-sized thing. The full headline
          // ("Verified to Level 3 on 17 of 17 dimensions") wrapped to three
          // lines in a 200px cell, so the level is the value and the sentence
          // is the hint — the strip stays one row tall and the sentence is
          // still there for anyone who reads past the number.
          {
            label: 'Certification',
            value: verifiedLevel != null ? `L${verifiedLevel}` : 'Not yet assessed',
            tone: verifiedLevel != null ? 'accent' : 'default',
            hint: certSubline ? `${certHeadline} · ${certSubline}` : certHeadline,
          },
          { label: 'Assessed', value: `${team.dimensions_assessed}/${team.dimensions_total}` },
          { label: 'Open follow-ups', value: team.followups_open, tone: team.followups_open > 0 ? 'danger' : 'default' },
          { label: 'Workflow step', value: activeStep?.label ?? team.workflow_step_label },
        ]}
      />

      {/* Trailing DIMENSION crumb — the shell breadcrumb (Assessment › Teams ›
          TEAM-002) is derived purely from the URL and stops there; this page
          owns the live extension for the dimension currently selected in the
          master-detail below. Clicking it collapses the selection, mirroring
          the source's imperative "collapse" crumb. */}
      {selectedDimension && (
        <InlineBreadcrumbs
          items={[
            { label: 'Certification', onClick: () => setSelectedDimId(null) },
            { label: selectedDimension.title },
          ]}
        />
      )}

      <Tabs idPrefix="scorecard" aria-label="Team scorecard" items={TABS} value={tab} onValueChange={(id) => onTabChange(id as ScorecardTab)} />

      {/* All five panes stay mounted — toggled with `hidden`, not unmounted —
          so selection/form state in each survives switching tabs. */}
      <Stack hidden={tab !== 'scorecard'} gap="lg">
        <Card padding="sm" className="overflow-x-auto shadow-sm ring-1 ring-border">
          <WorkflowStepper steps={workflow_steps} size="sm" />
        </Card>
        <DimensionMasterDetail dimensions={dimensions} selectedId={selectedDimId} onSelect={setSelectedDimId} />
      </Stack>

      <Stack hidden={tab !== 'plan'}>
        <ImprovementPlan teamId={team.id} />
      </Stack>

      <Stack hidden={tab !== 'stories'}>
        <StoriesPanel teamId={team.id} />
      </Stack>

      <Stack hidden={tab !== 'evidence'}>
        <EvidenceIntake teamId={team.id} />
      </Stack>

      <Stack hidden={tab !== 'documents'}>
        <EmptyState
          title="Documents live in Workspace"
          body="This team's documents are in the Informatics › Workspace explorer, alongside the shared enterprise context."
        />
      </Stack>

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
