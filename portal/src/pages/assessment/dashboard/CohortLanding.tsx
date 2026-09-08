// VIEW 1 — cohort/motion landing: one card per assessment motion (White
// Glove / Self-Service / Assessment Factory), plus a mini roster of all
// teams. Reproduces agentic-assessment-accelerator's CohortLanding.tsx —
// re-expressed entirely on ui-components primitives.

import {
  Button,
  Chip,
  DataTable,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  MetaLine,
  PageHeader,
  SectionLabel,
  SelectableCard,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { Can } from '../../../lib/capabilities';
import { cohortCards } from '../assessmentFormat';
import { MOTIONS, fmtDate, teamCertificationCellLabel, type TeamSummary } from '../types';
import { LevelBadge } from './LevelBadge';

interface CohortLandingProps {
  teams: TeamSummary[];
  isLoading: boolean;
  isError: boolean;
  onSelectCohort: (cohort: TeamSummary['cohort']) => void;
  onSelectTeam: (team: TeamSummary) => void;
  onViewAllTeams: () => void;
  /** Opens the "New team" modal — omitted controls stay hidden without ScoreAssessment. */
  onNewTeam: () => void;
}

export function CohortLanding({ teams, isLoading, isError, onSelectCohort, onSelectTeam, onViewAllTeams, onNewTeam }: CohortLandingProps) {
  if (isLoading) return <LoadingState label="Loading assessment cohorts…" />;
  if (isError) {
    return (
      <ErrorState
        title="Couldn't load teams"
        body="The assessment API may be unavailable or not yet built out on this environment — try refreshing."
      />
    );
  }

  const cards = cohortCards(teams, MOTIONS);

  return (
    <Stack gap="lg">
      <PageHeader
        title="Engineering maturity cohorts"
        description="Choose an assessment motion to see its teams, certifications, and follow-up work."
        actions={
          <Can do="ScoreAssessment">
            <Button variant="primary" size="sm" onClick={onNewTeam}>+ New team</Button>
          </Can>
        }
      />

      {teams.length === 0 && (
        <EmptyState
          title="No teams yet"
          body="Ingest your first self-assessment via the Submissions wizard."
          actions={[{ label: 'Open the Submissions wizard', href: '/assessment/submissions' }]}
        />
      )}

      {/* SelectableCard IS the card — wrapping each one in a Card again drew a
          card inside a card, two rounded boxes a few pixels apart. */}
      <Inline gap="sm" wrap align="stretch">
        {cards.map(({ motion, teamCount, targetLevel, certifiedCount }) => (
          <SelectableCard
            key={motion.cohort}
            padding="md"
            onSelect={() => onSelectCohort(motion.cohort)}
            className="flex min-w-[240px] flex-1 flex-col gap-3 text-left"
          >
            <Inline gap="sm" justify="between" align="center">
              <Chip tone={motion.accent} uppercase size="xs">
                {motion.tag}
              </Chip>
              <strong aria-hidden="true" className="text-accent">→</strong>
            </Inline>
            <strong className="block text-base font-bold leading-snug text-text-primary">{motion.title}</strong>
            <MetaLine size="xs" tone="secondary" items={[motion.description]} />
            <Inline gap="sm" justify="between" align="baseline">
              <MetaLine size="xs" items={[`${teamCount} team${teamCount === 1 ? '' : 's'}`]} />
              {targetLevel !== null && (
                <strong className="truncate text-[11px] font-semibold text-accent">
                  {certifiedCount} team{certifiedCount === 1 ? '' : 's'} verified at Level {targetLevel}
                </strong>
              )}
            </Inline>
          </SelectableCard>
        ))}
      </Inline>

      <Stack gap="sm">
        <Inline gap="sm" justify="between" align="baseline">
          <SectionLabel>All teams</SectionLabel>
          <Button variant="ghost" size="sm" onClick={onViewAllTeams}>
            View all teams →
          </Button>
        </Inline>
        <DataTable<TeamSummary>
          data={teams.slice(0, 8)}
          keyField={(t) => t.id}
          onRowClick={onSelectTeam}
          frameless={false}
          striped
          emptyMessage="No teams yet."
          columns={[
            {
              key: 'id',
              header: 'Team',
              // See TeamList.tsx's identical note: DataTable's row-click is a
              // bare <tr onClick> with no keyboard handling, so the row needs
              // one real focusable control of its own — the row click stays a
              // mouse convenience alongside it.
              render: (t) => (
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onSelectTeam(t); }}>
                  <Stack gap="none">
                    <strong className="font-semibold text-text-primary">{t.name}</strong>
                    <Chip size="xs" mono tone="neutral">{t.id}</Chip>
                  </Stack>
                </Button>
              ),
            },
            { key: 'cohort_label', header: 'Cohort' },
            { key: 'certification', header: 'Certification', render: (t) => {
              const label = teamCertificationCellLabel(t.certification);
              return label ? (
                <LevelBadge level={t.certification?.assessed ? t.certification!.target_level : null} size="xs" />
              ) : (
                <MetaLine items={['Not yet assessed']} />
              );
            } },
            { key: 'dimensions', header: 'Assessed', render: (t) => `${t.dimensions_assessed}/${t.dimensions_total}` },
            { key: 'followups_open', header: 'Follow-ups', render: (t) => (t.followups_open > 0 ? <Chip tone="warning" size="xs">{t.followups_open} open</Chip> : '—') },
            { key: 'updated_at', header: 'Updated', render: (t) => fmtDate(t.updated_at) },
          ]}
        />
      </Stack>
    </Stack>
  );
}
