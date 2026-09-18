// Reports — the portfolio. The program rollup, a maturity heatmap (every
// team × every dimension, the verified level in each cell and the team's
// claim marked where it sits higher), the cohort table, and "where to
// start" as a table whose kind column keeps the three recommendation kinds
// visibly distinct — never folded into one list, never re-ranked here.
//
// Before slice 3 of docs/assessment-ux-goal.md this page had no view of the
// portfolio by dimension: a program lead could see 41 dimensions at target
// but not which ones, nor which teams' claims run ahead of their evidence.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Button,
  Chip,
  DataTable,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  Card,
  MetaLine,
  PageHeader,
  PageSection,
  Stack,
  StatStrip,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
  type ChipTone,
} from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { RECOMMENDATION_KIND_LABEL, type RecommendationsResponse, type RecommendationTeamGroup, type RollupResponse, type SecondaryRecommendationKind } from './secondaryTypes';
import { useTeams } from './dashboard/useTeams';
import { LevelBadge } from './dashboard/LevelBadge';
import { useHeatmapIndex, type HeatmapDimension } from './useHeatmapIndex';
import { highestVerifiedLevel, motionFor, type TeamSummary } from './types';

const KIND_TONE: Record<SecondaryRecommendationKind, ChipTone> = {
  close_claim: 'warning',
  advance: 'info',
  answer: 'neutral',
};

/** Dimension ids are "1".."17"; the column order is the rubric's. */
function dimensionColumns(index: ReturnType<typeof useHeatmapIndex>['index']): HeatmapDimension[] {
  for (const dims of index.values()) {
    if (dims.size > 0) return Array.from(dims.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }
  return [];
}

function HeatmapCell({ dim }: { dim: HeatmapDimension | undefined }) {
  if (!dim) return <TableTd className="px-1.5 py-1 text-center" data-verified="" data-claimed="">—</TableTd>;
  const cert = dim.certification;
  const verified = cert?.verified_level ?? dim.current_level;
  const claimed = cert?.claimed_level ?? null;
  const claimOpen = claimed !== null && verified !== null && claimed > verified;
  const title = [
    dim.title,
    dim.is_na ? 'N/A — approved exception' : verified === null ? 'not assessed' : `verified L${verified}`,
    claimed !== null ? `claimed L${claimed}` : null,
    cert?.statement ?? null,
  ].filter(Boolean).join(' · ');
  return (
    <TableTd
      className="px-1.5 py-1 text-center whitespace-nowrap"
      title={title}
      data-verified={dim.is_na ? 'na' : verified ?? ''}
      data-claimed={claimed ?? ''}
    >
      <Inline gap="none" align="center" justify="center" wrap={false}>
        <LevelBadge level={verified} isNa={dim.is_na} size="xs" />
        {claimOpen && <Chip size="xs" tone="warning" title={`claimed L${claimed}`}>↑{claimed}</Chip>}
      </Inline>
    </TableTd>
  );
}

function MaturityHeatmap({ teams, onSelectTeam }: { teams: TeamSummary[]; onSelectTeam: (id: string) => void }) {
  const { index, loading } = useHeatmapIndex();
  const columns = useMemo(() => dimensionColumns(index), [index]);
  if (teams.length === 0) return <EmptyState title="No teams yet" />;
  if (columns.length === 0) return loading ? <LoadingState label="Reading every team's scorecard…" /> : <EmptyState title="No dimensions scored yet" />;
  return (
    <Stack gap="sm">
      <MetaLine
        size="xs"
        tone="tertiary"
        items={['each cell is the verified level', '↑n marks a claim the evidence has not reached', 'N/A is an approved exception', '— is not assessed', 'hover a column head for the dimension']}
      />
      {/* The 19 columns (Team + seventeen dimensions + Verified) are wider than
          the content column at any realistic width, and `Table` is a bare
          <table> with no wrapper of its own — so with nothing containing it the
          PAGE scrolled sideways instead of the grid. The breadcrumb, the title,
          the stat strip and the Publish button all slid off to the left and
          clipped, which is the one thing a horizontal scroll must never do.
          Same `Card padding="none" overflow-x-auto` this tenant already uses
          for the equally wide scorecard grid (dashboard/TeamScorecard.tsx) and
          the budgets report — the heatmap simply never got it. */}
      <Card padding="none" className="overflow-x-auto">
      <Table data-testid="maturity-heatmap" className="text-xs">
        <TableHead>
          <TableRow>
            <TableTh scope="col" className="px-3 py-2">Team</TableTh>
            {columns.map((d) => (
              <TableTh key={d.id} scope="col" className="px-1.5 py-2 text-center" title={d.title} abbr={d.title}>
                {d.id.padStart(2, '0')}
              </TableTh>
            ))}
            <TableTh scope="col" className="px-3 py-2 text-right">Verified</TableTh>
          </TableRow>
        </TableHead>
        <TableBody>
          {teams.map((t) => {
            const dims = index.get(t.id);
            const top = highestVerifiedLevel(t.certification);
            return (
              <TableRow key={t.id}>
                <TableTd className="px-3 py-1 whitespace-nowrap">
                  <Stack gap="none" align="start">
                    <Button variant="ghost" size="sm" className="border-0 px-0 font-semibold text-text-primary" onClick={() => onSelectTeam(t.id)}>{t.name}</Button>
                    <MetaLine size="xs" tone="tertiary" items={[t.id, motionFor(t.cohort).title]} />
                  </Stack>
                </TableTd>
                {columns.map((d) => <HeatmapCell key={d.id} dim={dims?.get(d.id)} />)}
                <TableTd className="px-3 py-1 text-right whitespace-nowrap">
                  <Inline gap="xs" align="center" justify="end" wrap={false}>
                    <LevelBadge level={top} size="xs" />
                    {(t.certification?.claims_open ?? 0) > 0 && (
                      <MetaLine size="xs" tone="tertiary" items={[`${t.certification!.claims_open} claim${t.certification!.claims_open === 1 ? '' : 's'} open`]} />
                    )}
                  </Inline>
                </TableTd>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      </Card>
    </Stack>
  );
}

function WhereToStart({ onSelectTeam, teamId }: { onSelectTeam: (id: string) => void; teamId?: string }) {
  const { data, isLoading: loading, error, degraded, refresh } = useFetch<RecommendationsResponse>('/api/assessment/recommendations');
  const groups: RecommendationTeamGroup[] = (data?.teams ?? [])
    .filter((g) => g.top != null)
    .filter((g) => !teamId || g.id === teamId);
  if (loading) return <LoadingState label="Reading each team's plan…" />;
  if (error) return <ErrorState title="Couldn't load recommendations" description={error} actionLabel="Retry" onAction={refresh} />;
  if (degraded) {
    return (
      <UnavailableNotice
        error={degraded}
        what="the recommendations"
        source="Recommendations are built from every team's dimension scores"
        onRetry={refresh}
      />
    );
  }
  if (groups.length === 0) return <EmptyState title="Nothing open" body={teamId ? 'This team has no open recommendation right now.' : 'No team has an open recommendation right now.'} />;
  return (
    <DataTable<RecommendationTeamGroup>
      data={groups}
      keyField={(g) => g.id}
      striped
      onRowClick={(g) => onSelectTeam(g.id)}
      // Every team with an open recommendation, program-wide — 20 is a
      // full-page screenful.
      pageSize={20}
      columns={[
        {
          key: 'name', header: 'Team',
          render: (g) => (
            <Stack gap="none" align="start">
              <Button variant="ghost" size="sm" className="border-0 px-0 font-semibold text-text-primary" onClick={(e) => { e.stopPropagation(); onSelectTeam(g.id); }}>{g.name}</Button>
              <MetaLine size="xs" tone="tertiary" items={[g.id]} />
            </Stack>
          ),
        },
        { key: 'kind', header: 'Start by', render: (g) => <Chip tone={KIND_TONE[g.top!.kind]} size="xs" dot="static">{RECOMMENDATION_KIND_LABEL[g.top!.kind]}</Chip> },
        { key: 'dimension', header: 'Dimension', render: (g) => <MetaLine size="xs" tone="secondary" items={[g.top!.title, `dim ${g.top!.dimension_id}`]} /> },
        { key: 'what', header: 'What it takes', render: (g) => <MetaLine size="xs" tone="secondary" items={[g.top!.headline ?? g.top!.summary ?? '—']} /> },
        { key: 'close_claim', header: 'Close', align: 'right', render: (g) => g.counts.close_claim ?? 0 },
        { key: 'advance', header: 'Advance', align: 'right', render: (g) => g.counts.advance ?? 0 },
        { key: 'answer', header: 'Answer', align: 'right', render: (g) => g.counts.answer ?? 0 },
      ]}
    />
  );
}

export default function ReportsPage() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const canPublish = ready && can('PublishReport');
  const { teams } = useTeams();
  const { data: rollup, isLoading: loading, error, degraded, refresh: refreshRollup } = useFetch<RollupResponse>('/api/assessment/rollup');
  const [publishing, setPublishing] = useState(false);
  const openTeam = (id: string) => navigate(`/assessment/teams/${encodeURIComponent(id)}`);

  // TeamScorecard's "Report" button (dashboard/TeamScorecard.tsx) opens
  // `/assessment/reports?team=<id>` in a new tab expecting a report scoped
  // to that one team — this page used to ignore the param entirely and
  // always render the portfolio rollup, so the button silently landed on
  // the wrong report. There is no separate per-team report route, so the
  // honest fix is here: scope the heatmap and "where to start" table to the
  // one team when `?team=` names one on the roster, and fall back to the
  // full portfolio otherwise (unknown/absent id).
  const [searchParams] = useSearchParams();
  const teamParam = searchParams.get('team');
  const scopedTeam = teamParam ? teams.find((t) => t.id === teamParam) : undefined;
  const isScoped = Boolean(teamParam && scopedTeam);

  async function publish() {
    setPublishing(true);
    try {
      const res = await fetch('/api/assessment/reports/publish', { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toastSuccess(null, 'Report published');
    } catch (err) {
      toastError(null, 'Could not publish', (err as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Stack gap="lg">
      <PageHeader
        title={isScoped ? `Report — ${scopedTeam!.name}` : 'Portfolio'}
        description={
          isScoped
            ? `${scopedTeam!.name}'s certification heatmap and open recommendations — the printable single-team report.`
            : "Every team against every dimension: what verification has reached, where the claims run ahead of it, and the one thing each team should start with."
        }
        actions={
          isScoped ? (
            <Link to="/assessment/reports" className="text-[12px] text-[var(--color-primary)] no-underline">
              ← Portfolio
            </Link>
          ) : canPublish ? (
            <Button onClick={() => void publish()} disabled={publishing}>{publishing ? 'Publishing…' : 'Publish report'}</Button>
          ) : undefined
        }
      />
      {loading ? (
        <LoadingState label="Loading the portfolio…" />
      ) : error ? (
        <ErrorState title="Couldn't load the portfolio" description={error} actionLabel="Retry" onAction={refreshRollup} />
      ) : degraded ? (
        <UnavailableNotice
          error={degraded}
          what="the portfolio rollup"
          source="The rollup is computed from every team's dimension scores"
          onRetry={refreshRollup}
        />
      ) : rollup ? (
        <>
          {!isScoped && (
            <StatStrip
              aria-label="Portfolio summary"
              items={[
                { label: 'Teams', value: rollup.teams_total },
                { label: 'Dimensions assessed', value: `${rollup.dimensions_assessed} / ${rollup.dimensions_applicable}`, hint: 'of applicable' },
                { label: `At or above L${rollup.target_level}`, value: rollup.at_or_above_target, tone: 'accent', hint: 'dimensions' },
                { label: 'Claims open', value: rollup.claims_open, tone: rollup.claims_open > 0 ? 'danger' : 'default', hint: 'verification below the claim' },
              ]}
            />
          )}
          <PageSection
            title={isScoped ? 'Certification' : 'Certification heatmap'}
            description={isScoped ? 'Columns are the rubric\'s seventeen dimensions.' : "Rows are teams, columns are the rubric's seventeen dimensions."}
          >
            <MaturityHeatmap teams={isScoped ? [scopedTeam!] : teams} onSelectTeam={openTeam} />
          </PageSection>
          <PageSection title="Where to start" description="Each team's top-ranked entry, ranked by the server — never re-ordered here. Closing a claim asks for an artifact, advancing a practice is real work, answering a question unblocks assessment.">
            <WhereToStart onSelectTeam={openTeam} teamId={isScoped ? scopedTeam!.id : undefined} />
          </PageSection>
          {!isScoped && (
            <PageSection title="By cohort">
              <DataTable<[string, RollupResponse['by_cohort'][string]]>
                data={Object.entries(rollup.by_cohort)}
                keyField={([cohort]) => cohort}
                striped
                columns={[
                  { key: 'cohort', header: 'Cohort', render: ([cohort]) => cohort.replace('_', ' ') },
                  { key: 'teams', header: 'Teams', align: 'right', render: ([, c]) => c.teams },
                  { key: 'assessed', header: 'Assessed', align: 'right', render: ([, c]) => `${c.assessed} / ${c.applicable}` },
                  { key: 'target', header: `At or above L${rollup.target_level}`, align: 'right', render: ([, c]) => c.at_or_above_target },
                ]}
              />
            </PageSection>
          )}
        </>
      ) : (
        <EmptyState title="No data" />
      )}
    </Stack>
  );
}
