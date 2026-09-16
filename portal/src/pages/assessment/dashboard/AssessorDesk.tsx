// VIEW 1 — the assessor's desk. One dense table of every team in the
// program: what its certification says on both tracks, where it stands on
// the six-step ladder, what is waiting on a person, and the one action that
// moves it next. The motion (cohort) is a filter on this table, not a
// separate landing page — three cards that each said "2 teams" were a page
// spent on a number the strip already carries.
import { useMemo, useState } from 'react';
import {
  Button,
  Chip,
  DataTable,
  DotMeter,
  ErrorState,
  Inline,
  Input,
  LoadingState,
  MetaLine,
  PageHeader,
  PresenceAvatars,
  SegmentedControl,
  Select,
  Stack,
  StatStrip,
  WorkflowStepper,
  type ChipTone,
} from '@connorhoehnslalom/ui-components/shared';
import { Can } from '../../../lib/capabilities';
import {
  contributorAvatars,
  deskSummary, filterAndSortTeams, formatTeamStatus, nextActionFor, statusOptions, teamsForCohort,
  type NextActionKind,
} from '../assessmentFormat';
import { MOTIONS, fmtDate, highestVerifiedLevel, motionFor, type Cohort, type TeamSummary } from '../types';

const ALL = 'all';

const ACTION_TONE: Record<NextActionKind, ChipTone> = {
  intake: 'neutral',
  assess: 'info',
  close_claims: 'warning',
  answer: 'accent',
  publish: 'success',
  follow_up: 'neutral',
};

interface AssessorDeskProps {
  teams: TeamSummary[];
  isLoading: boolean;
  isError: boolean;
  /** `?cohort=` — the motion filter lives in the URL so a filtered desk can be shared. */
  cohort: Cohort | 'all';
  onCohortChange: (cohort: Cohort | 'all') => void;
  onSelectTeam: (teamId: string) => void;
  onNewTeam: () => void;
  onRetry: () => void;
}

/** "L3 verified · 12/17" on the verified track, with the claim gap beside it. */
function CertificationCell({ team }: { team: TeamSummary }) {
  const cert = team.certification;
  if (!cert || !cert.assessed) return <MetaLine size="xs" tone="tertiary" items={['Not yet assessed']} />;
  const verified = highestVerifiedLevel(cert);
  const claims = cert.claims_open ?? 0;
  return (
    <Inline gap="xs" align="center" wrap={false}>
      <Chip
        size="xs"
        tone={cert.at_or_above_target > 0 ? 'success' : 'neutral'}
        title={cert.headline ?? undefined}
      >
        {verified === null ? 'unverified' : `L${verified} verified`}
      </Chip>
      <MetaLine size="xs" tone="secondary" items={[`${cert.at_or_above_target}/${cert.applicable} at L${cert.target_level}`]} />
      {claims > 0 && (
        <Chip size="xs" tone="warning" title="Dimensions whose claim sits above what verification reached">
          {claims} claim{claims === 1 ? '' : 's'} open
        </Chip>
      )}
    </Inline>
  );
}

export function AssessorDesk({
  teams, isLoading, isError, cohort, onCohortChange, onSelectTeam, onNewTeam, onRetry,
}: AssessorDeskProps) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(ALL);

  const inMotion = useMemo(() => teamsForCohort(teams, cohort), [teams, cohort]);
  const statuses = useMemo(() => statusOptions(inMotion), [inMotion]);
  const rows = useMemo(() => filterAndSortTeams(inMotion, { search, status }), [inMotion, search, status]);
  const summary = useMemo(() => deskSummary(rows), [rows]);
  const hasFilters = search.trim() !== '' || status !== ALL;

  if (isLoading) return <LoadingState label="Loading the program…" />;
  if (isError) {
    return <ErrorState title="Couldn't load the teams" description="The roster did not answer." actionLabel="Retry" onAction={onRetry} />;
  }

  return (
    <Stack gap="md">
      <PageHeader
        title="Assessor's desk"
        description="Every team in the program: what its certification says on both tracks, where it stands, and the one thing that moves it next."
        actions={(
          <Can do="ScoreAssessment">
            <Button size="sm" onClick={onNewTeam}>+ New team</Button>
          </Can>
        )}
      />

      <StatStrip
        aria-label="Program summary"
        items={[
          { label: 'Teams', value: summary.teams, hint: cohort === ALL ? 'in the program' : `in ${motionFor(cohort).title}` },
          {
            label: summary.targetLevel === null ? 'Verified' : `Verified at L${summary.targetLevel}`,
            value: summary.targetLevel === null ? '—' : summary.verifiedAtTarget,
            hint: summary.targetLevel === null ? 'nothing assessed yet' : 'teams with a dimension at target',
          },
          { label: 'Claims open', value: summary.claimsOpen, tone: summary.claimsOpen > 0 ? 'danger' : 'default', hint: 'claimed above what evidence verifies' },
          { label: 'Questions open', value: summary.questionsOpen, tone: summary.questionsOpen > 0 ? 'danger' : 'default', hint: 'waiting on a person' },
        ]}
      />

      <Inline wrap align="center" gap="sm">
        <SegmentedControl
          size="sm"
          aria-label="Assessment motion"
          value={cohort}
          onChange={(v) => onCohortChange(v as Cohort | 'all')}
          options={[{ label: 'All motions', value: ALL }, ...MOTIONS.map((m) => ({ label: m.title, value: m.cohort }))]}
        />
        <Select
          size="sm"
          className="w-44"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[{ value: ALL, label: 'All statuses' }, ...statuses.map((s) => ({ value: s, label: formatTeamStatus(s) }))]}
        />
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by team name or ID…"
          className="w-[280px]"
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setStatus(ALL); }}>
            Clear filters
          </Button>
        )}
        <MetaLine
          size="xs"
          tone="tertiary"
          className="ml-auto"
          items={[`${rows.length} of ${teams.length} team${teams.length === 1 ? '' : 's'}`, 'sorted by fewest dimensions at target']}
        />
      </Inline>

      <DataTable<TeamSummary>
        data={rows}
        keyField={(t) => t.id}
        onRowClick={(t) => onSelectTeam(t.id)}
        striped
        emptyMessage={teams.length === 0 ? 'No teams in the program yet.' : 'No teams match the current filters.'}
        columns={[
          {
            key: 'name',
            header: 'Team',
            sortable: true,
            // The row's one focusable, Enter-activatable control: DataTable's
            // row click is a bare <tr onClick>, so a keyboard user needs a
            // real button in the row to open it.
            render: (t) => (
              <Stack gap="none" align="start">
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-0 font-semibold text-text-primary"
                  onClick={(e) => { e.stopPropagation(); onSelectTeam(t.id); }}
                >
                  {t.name}
                </Button>
                <MetaLine size="xs" tone="tertiary" items={[t.id, t.assessment_lead || 'no lead yet']} />
              </Stack>
            ),
          },
          {
            key: 'cohort',
            header: 'Motion',
            sortable: true,
            render: (t) => <Chip size="xs" tone={motionFor(t.cohort).accent}>{motionFor(t.cohort).title}</Chip>,
          },
          { key: 'certification', header: 'Certification', render: (t) => <CertificationCell team={t} /> },
          {
            key: 'dimensions_assessed',
            header: 'Assessed',
            sortable: true,
            align: 'right',
            render: (t) => (
              <DotMeter
                value={t.dimensions_total > 0 ? t.dimensions_assessed / t.dimensions_total : 0}
                segments={10}
                showPercent={false}
                note={`${t.dimensions_assessed}/${t.dimensions_total}`}
                tone="surface"
              />
            ),
          },
          {
            // `TeamSummary.workflow_steps` now carries the same six-step
            // ladder the detail page's `WorkflowStepper` renders
            // (TeamScorecard.tsx:207) — built server-side by ONE function,
            // `buildWorkflowSteps` in `middleware/src/providers/assessment.ts`,
            // shared by both the list and detail wires, so there is no
            // second label vocabulary to keep in step. At 1692px with nine
            // columns a full-width six-label stepper would dominate the row —
            // the table has `table-layout: auto`, so a bare column `width`
            // is only a hint and the stepper's intrinsic content (six labels)
            // would still stretch the column and the table past it. This
            // caps the stepper's own element at a fixed `w-40` (matching the
            // column's `width`) so IT clips and scrolls internally
            // (`overflow-x-auto`, built into WorkflowStepper) instead of the
            // table growing — a reader scans the filled-in dots at a glance
            // and can scroll the one cell to read the labels. Falls back to
            // a bare Chip when a caller hands a row without `workflow_steps`
            // (e.g. a hand-built test fixture), since the field is optional
            // on the type.
            key: 'workflow_step',
            header: 'Step',
            sortable: true,
            width: '160px',
            render: (t) => (
              t.workflow_steps && t.workflow_steps.length > 0 ? (
                <WorkflowStepper
                  steps={t.workflow_steps}
                  size="sm"
                  className="w-40"
                  data-testid={`workflow-stepper-${t.id}`}
                />
              ) : (
                <Chip size="xs" tone="neutral" title={`Step ${t.workflow_step} of 6`}>
                  {t.workflow_step}/6 · {t.workflow_step_label}
                </Chip>
              )
            ),
          },
          {
            key: 'contributors',
            header: 'Contributors',
            render: (t) => {
              const avatars = contributorAvatars(t.contributors);
              return avatars.length > 0 ? (
                <PresenceAvatars users={avatars} maxVisible={4} size={22} />
              ) : (
                <MetaLine size="xs" tone="tertiary" items={['—']} />
              );
            },
          },
          {
            key: 'followups_open',
            header: 'Questions',
            sortable: true,
            align: 'right',
            render: (t) => (
              t.followups_open > 0
                ? <Chip tone="warning" size="xs">{t.followups_open} open</Chip>
                : <MetaLine size="xs" tone="tertiary" items={['—']} />
            ),
          },
          {
            key: 'next',
            header: 'Next action',
            render: (t) => {
              const next = nextActionFor(t);
              return <Chip size="xs" tone={ACTION_TONE[next.kind]} dot="static">{next.label}</Chip>;
            },
          },
          { key: 'updated_at', header: 'Updated', sortable: true, render: (t) => fmtDate(t.updated_at) },
        ]}
      />
    </Stack>
  );
}
