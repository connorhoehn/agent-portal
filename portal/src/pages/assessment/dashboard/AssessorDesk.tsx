// VIEW 1 — the assessor's desk. One dense table of every team in the
// program: what its certification says on both tracks, where it stands on
// the six-step ladder, what is waiting on a person, and the one action that
// moves it next. The motion (cohort) is a filter on this table, not a
// separate landing page — three cards that each said "2 teams" were a page
// spent on a number the strip already carries.
import { ofTotal } from '../../../lib/plural';
import type React from 'react';
import { useMemo, useState } from 'react';
import {
  Button,
  ChecklistIcon,
  Chip,
  CollectionToolbar,
  DataTable,
  DotMeter,
  ErrorState,
  Inline,
  LoadingState,
  MetaLine,
  PersonIcon,
  PresenceAvatars,
  RepeatIcon,
  Tooltip,
  Stack,
  StatStrip,
  T,
  type ChipTone,
} from '@connorhoehn/ui-components/shared';
import { UnavailableNotice } from '../../../components/UnavailableNotice';
import { RecordLink } from '../../decisions/RecordLink';
import { CollectionCommandHost } from '../../../components/collections/CollectionCommandHost';
import { CollectionCommandPage } from '../../../components/collections/CollectionCommandPage';
import { teamsCommandAdapter } from '../assessmentCollectionCommands';
import { useAnswerScope } from '../../../components/collections/useAnswerScope';
import { Can } from '../../../lib/capabilities';
import {
  contributorAvatars,
  deskSummary, filterAndSortTeams, formatTeamStatus, nextActionFor, statusOptions, teamsForCohort,
  type NextActionKind,
} from '../assessmentFormat';
import { deskColumnPriority } from './deskColumns';
import { MOTIONS, fmtDate, highestVerifiedLevel, motionFor, type Cohort, type TeamSummary } from '../types';

/** The Motion column's icon per cohort (narrow batch): the chip is the icon, the name and tag its tooltip. */
const MOTION_ICON: Record<Cohort, React.ReactNode> = {
  white_glove: <PersonIcon size={12} aria-hidden="true" />,
  self_service: <ChecklistIcon size={12} aria-hidden="true" />,
  general: <RepeatIcon size={12} aria-hidden="true" />,
};

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
  /** The wire's "we could not look" marker (`lib/degraded.ts`), or `null` on a real read. */
  degraded: string | null;
  /** `?cohort=` — the motion filter lives in the URL so a filtered desk can be shared. */
  cohort: Cohort | 'all';
  onCohortChange: (cohort: Cohort | 'all') => void;
  onSelectTeam: (teamId: string) => void;
  onNewTeam: () => void;
  onRetry: () => void;
}

/**
 * The desk's "Updated" date: the year only when it is not this year; the full
 * date is the cell's tooltip (UX leftovers, 10 November).
 */
function deskDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fmtDate(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * "L3 verified · 12/17 at L3" on the verified track, with the open-claims count beside it: the
 * thing an assessor acts on, so it stays in the row at every width (UX leftovers, 10 November,
 * restoring what 242429fe dropped to fit 1440; the fit is now the columns' priorities').
 */
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
        <Chip size="xs" tone="warning" title={`${claims} claim${claims === 1 ? '' : 's'} open — dimensions whose claim sits above what verification reached`}
          data-testid="desk-claims-open">
          {claims} open
        </Chip>
      )}
    </Inline>
  );
}

export function AssessorDesk({
  teams, isLoading, isError, degraded, cohort, onCohortChange, onSelectTeam, onNewTeam, onRetry,
}: AssessorDeskProps) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(ALL);

  const inMotion = useMemo(() => teamsForCohort(teams, cohort), [teams, cohort]);
  const statuses = useMemo(() => statusOptions(inMotion), [inMotion]);
  // "Which teams have no lead" answers as a fact (possibly "none"); the desk then lists the teams it cites.
  const scope = useAnswerScope(['assessment:unassigned-teams']);
  const rows = useMemo(
    () => filterAndSortTeams(inMotion, { search, status }).filter((t) => !scope.keys || scope.keys.has(`team:${t.id}`)),
    [inMotion, search, status, scope.keys],
  );
  const summary = useMemo(() => deskSummary(rows), [rows]);
  const adapter = teamsCommandAdapter(rows, {
    setQuery: setSearch,
    setMotion: onCohortChange,
    clearStatus: () => setStatus(ALL),
    refresh: onRetry,
    openTeam: onSelectTeam,
    showAnswer: scope.showAnswer,
  });
  const hasFilters = search.trim() !== '' || status !== ALL;

  if (isLoading) return <LoadingState label="Loading the program…" />;
  if (isError) {
    return <ErrorState title="Couldn't load the teams" description="The roster did not answer." actionLabel="Retry" onAction={onRetry} />;
  }

  // A degraded read (SummaryPage's `dash()` pattern): the request succeeded
  // but the server is telling us not to believe the body. The strip stays on
  // screen so the page keeps its shape, but every count reads "—" rather than
  // the zeros a degraded empty roster would otherwise show, and the table
  // itself gives way to the notice instead of a bare "No teams" emptyMessage
  // that would read as a genuinely empty program.
  const dash = (v: React.ReactNode): React.ReactNode => (degraded ? '—' : v);

  const stripItems = [
    { label: hasFilters || cohort !== ALL ? `of ${teams.length} team${teams.length === 1 ? '' : 's'}` : (summary.teams === 1 ? 'team' : 'teams'), value: dash(summary.teams) },
    {
      label: summary.targetLevel === null ? 'verified' : `verified at L${summary.targetLevel}`,
      value: summary.targetLevel === null ? '—' : dash(summary.verifiedAtTarget),
    },
    { label: 'claims open', value: dash(summary.claimsOpen), ...(!degraded && summary.claimsOpen > 0 ? { tone: 'danger' as const } : {}) },
    { label: 'questions open', value: dash(summary.questionsOpen), ...(!degraded && summary.questionsOpen > 0 ? { tone: 'danger' as const } : {}) },
  ];

  const motionOptions = [{ value: '', label: 'All motions' }, ...MOTIONS.map((m) => ({ value: m.cohort, label: m.title }))];
  const statusFilterOptions = [{ value: '', label: 'All statuses' }, ...statuses.map((s) => ({ value: s, label: formatTeamStatus(s) }))];

  return (
    <CollectionCommandPage
      data-testid="assessment-teams"
      title="Assessor's desk"
      description="Every team in the program: what its certification says on both tracks, where it stands, and the one thing that moves it next."
      headerActions={(
        <Can do="ScoreAssessment">
          <Button size="sm" onClick={onNewTeam}>+ New team</Button>
        </Can>
      )}
    >
      <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      <Stack gap="md" className="min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter)] pb-4">
      {degraded ? (
        <>
          <StatStrip aria-label="Program summary" variant="line" items={stripItems} />
          <UnavailableNotice
            error={degraded}
            what="the team roster"
            source="Teams are read from the assessment database"
            onRetry={onRetry}
          />
        </>
      ) : (
        <>
          <StatStrip aria-label="Program summary" variant="line" items={stripItems} />
          <CollectionToolbar
            label="Team filters"
            search={{ value: search, onChange: setSearch, placeholder: 'Search by team name or ID…', 'aria-label': 'Search teams' }}
            filters={[
              { id: 'motion', label: 'Assessment motion', value: cohort === ALL ? '' : cohort, onChange: (v) => onCohortChange(v ? v as Cohort : ALL), options: motionOptions },
              { id: 'status', label: 'Status', value: status === ALL ? '' : status, onChange: (v) => setStatus(v || ALL), options: statusFilterOptions },
            ]}
            summary={`${ofTotal(rows.length, teams.length, 'team')}`}
            onRefresh={onRetry}
          />

          {/* Column priorities (UX leftovers, 10 November): every column shows when the table has room
              for them, and the ones whose fact is elsewhere too (Step, Motion, Lead) give way first as the
              table narrows (deskColumns.ts; DataTable `responsiveColumns`, measured on the table's own width),
              one "+N columns" control in the "More" header listing what hid (ui-components 2.519.0
              `hiddenColumnsControl="header"`; each row's chevron shows its own hidden values, so rows no longer
              repeat "+3 columns"). Under 40rem a row is a stacked card with every field (`narrow`). */}
          <DataTable<TeamSummary>
            narrow
            responsiveColumns
            hiddenColumnsControl="header"
            data={rows}
            keyField={(t) => t.id}
            onRowClick={(t) => onSelectTeam(t.id)}
            striped
            // A full-page desk view over every team in the program — 20 is a
            // scannable screenful without turning this into an infinite list.
            pageSize={20}
            emptyMessage={teams.length === 0 ? 'No teams in the program yet.' : 'No teams match the current filters.'}
            columns={[
          {
            key: 'name',
            header: 'Team',
            sortable: true,
            // The name is the team's link (`/assessment/teams/:id`); the row also opens it.
            render: (t) => <RecordLink to={`/assessment/teams/${encodeURIComponent(t.id)}`}><T size="sm" weight="medium">{t.name}</T></RecordLink>,
          },
          {
            key: 'lead',
            header: 'Lead',
            truncate: true,
            width: '8.5rem',
            priority: deskColumnPriority('lead'),
            getFilterText: (t) => t.assessment_lead || 'no lead yet',
            render: (t) => <T size="sm" tone={t.assessment_lead ? 'primary' : 'tertiary'}>{t.assessment_lead || 'no lead yet'}</T>,
          },
          {
            key: 'cohort',
            header: 'Motion',
            sortable: true,
            width: '4.5rem',
            priority: deskColumnPriority('cohort'),
            // An icon chip: the motion's name and tag are its tooltip and accessible name (the toolbar filters by it too).
            render: (t) => {
              const m = motionFor(t.cohort);
              return (
                <Tooltip content={`${m.title} · ${m.tag.toLowerCase()}`}>
                  <Chip size="xs" tone={m.accent} aria-label={`Motion: ${m.title}`} data-testid="desk-motion-chip">{MOTION_ICON[m.cohort] ?? MOTION_ICON.general}</Chip>
                </Tooltip>
              );
            },
          },
          { key: 'certification', header: 'Certification', render: (t) => <CertificationCell team={t} /> },
          {
            key: 'dimensions_assessed',
            header: 'Assessed',
            sortable: true,
            numeric: true,
            priority: deskColumnPriority('dimensions_assessed'),
            render: (t) => (
              // DotMeter is a block; the Inline puts it flush right like the
              // column's other numbers.
              <Inline justify="end" wrap={false}>
                <DotMeter
                  value={t.dimensions_total > 0 ? t.dimensions_assessed / t.dimensions_total : 0}
                  segments={6}
                  showPercent={false}
                  note={`${t.dimensions_assessed}/${t.dimensions_total}`}
                  tone="surface"
                />
              </Inline>
            ),
          },
          {
            // `TeamSummary.workflow_steps` now carries the same six-step
             // The workflow ladder, compact enough that the cell never
            // scrolls.
            //
            // It used to render `WorkflowStepper` capped at `w-40`, which put
            // six labels into a 160px cell and let the cell scroll
            // horizontally to reach them. That trades one problem for a worse
            // one: a horizontal scrollbar inside a table cell is close to
            // undiscoverable, the labels past the cap were unreachable
            // without finding it, and half the rows showed a stepper
            // mid-scroll ("Publish", "Follow-up") with no indication that
            // earlier steps existed to its left.
            //
            // So the six labels collapse to the one that answers the
            // column — the step the team is on — and the ladder becomes a
            // connected timeline of dots beneath it: done filled with a
            // check, current a ring, ahead an empty outline. ~134px, so the
            // cell cannot scroll at any table width. Each dot keeps its own
            // label on hover and as its accessible name. See
            // `WorkflowTimeline.tsx`.
            //
            // Labels still come from `buildWorkflowSteps` in
            // `middleware/src/providers/assessment.ts`, the same function the
            // detail page's stepper reads, so there is no second label
            // vocabulary. Falls back to a bare Chip when a caller hands a row
            // without `workflow_steps` (a hand-built test fixture), since the
            // field is optional on the type.
            key: 'workflow_step',
            header: 'Step',
            sortable: true,
            width: '4.5rem',
            priority: deskColumnPriority('workflow_step'),
            render: (t) => {
              const ladder = t.workflow_steps && t.workflow_steps.length > 0
                ? t.workflow_steps.map((w) => `${w.done ? '✓' : w.active ? '●' : '○'} ${w.step} · ${w.label}`).join('\n')
                : `Step ${t.workflow_step} of 6`;
              // Compact (narrow batch): "3/6"; the step's name and the ladder are the tooltip.
              return (
                <Tooltip content={<T as="span" size="xs" wrap className="whitespace-pre-line">{`${t.workflow_step_label}\n${ladder}`}</T>}>
                  <Chip size="xs" tone="neutral" aria-label={`Step ${t.workflow_step} of 6: ${t.workflow_step_label}`} data-testid="desk-step-chip">
                    {t.workflow_step}/6
                  </Chip>
                </Tooltip>
              );
            },
          },
          {
            key: 'contributors',
            header: 'Contributors',
            priority: deskColumnPriority('contributors'),
            render: (t) => {
              const avatars = contributorAvatars(t.contributors);
              return avatars.length > 0 ? (
                <PresenceAvatars users={avatars} maxVisible={3} size={22} />
              ) : (
                <MetaLine size="xs" tone="tertiary" items={['—']} />
              );
            },
          },
          {
            key: 'followups_open',
            header: 'Questions',
            sortable: true,
            numeric: true,
            // Flush right like the header and the column's other values: a bare
            // MetaLine is a flex row, so its "—" sat at the cell's left edge
            // under a right-aligned header (walk, 10 November).
            render: (t) => (
              <Inline justify="end" wrap={false}>
                {t.followups_open > 0
                  ? <Chip tone="warning" size="xs">{t.followups_open} open</Chip>
                  : <MetaLine size="xs" tone="tertiary" items={['—']} />}
              </Inline>
            ),
          },
          {
            key: 'next',
            header: 'Next action',
            render: (t) => {
              const next = nextActionFor(t);
              return (
                <Chip size="xs" tone={ACTION_TONE[next.kind]} dot="static"
                  title={next.kind === 'close_claims' ? 'Dimensions whose claim sits above what verification reached' : undefined}>
                  {next.label}
                </Chip>
              );
            },
          },
          { key: 'updated_at', header: 'Updated', sortable: true, numeric: true, priority: deskColumnPriority('updated_at'),
            render: (t) => (
              <Tooltip content={fmtDate(t.updated_at)}>
                <T as="span" size="sm" tone="inherit">{deskDate(t.updated_at)}</T>
              </Tooltip>
            ) },
            ]}
          />
        </>
      )}
      </Stack>
      {!degraded && <CollectionCommandHost adapter={adapter} />}
      </Stack>
    </CollectionCommandPage>
  );
}
