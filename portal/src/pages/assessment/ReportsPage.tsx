// Reports — the program rollup, "where to start" and a per-team table. Structure mirrors
// the source app's Reports.tsx / WhereToStartCard.tsx, trimmed to the numbers the
// `/rollup` and `/recommendations` mock endpoints actually carry
// (docs/assessment-tenant.md). The three recommendation kinds — close the claim, advance
// the practice, answer the question — stay visibly distinct: never folded into one list
// with no marker, never re-ranked client-side (the server already ordered them).

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Inline,
  InlinePlaceholder,
  LoadingState,
  MetaLine,
  PageHeader,
  Stack,
  PageSection,
  StatStrip,
  type ChipTone,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { RECOMMENDATION_KIND_LABEL, type RecommendationsResponse, type RecommendationTeamGroup, type RollupResponse, type SecondaryRecommendationKind } from './secondaryTypes';
import { useTeams } from './dashboard/useTeams';
import type { TeamSummary } from './types';

const KIND_TONE: Record<SecondaryRecommendationKind, ChipTone> = {
  close_claim: 'warning',
  advance: 'info',
  answer: 'neutral',
};

function WhereToStartCard() {
  const [data, setData] = useState<RecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/assessment/recommendations', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: RecommendationsResponse) => { setData(body); setError(null); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const groups: RecommendationTeamGroup[] = (data?.teams ?? []).filter((g) => g.top != null);
  return (
    <PageSection title="Where to start" description="Each team's top-ranked entry, ranked by the server — never re-ordered here. The kind is the point: closing a claim asks for an artifact, advancing a practice is real work, answering a question unblocks assessment.">
      {loading ? (
        <LoadingState label="Reading each team's plan…" />
      ) : error ? (
        <EmptyState title="Couldn't load recommendations" body={error} />
      ) : groups.length === 0 ? (
        <EmptyState title="Nothing open" body="No team has an open recommendation right now." />
      ) : (
        <Stack gap="sm">
          {groups.map((g) => (
            <Card key={g.id} padding="sm">
              <Inline justify="between" align="center" wrap gap="sm">
                <Inline align="center" wrap gap="sm">
                  <Chip tone={KIND_TONE[g.top!.kind]} size="xs">{RECOMMENDATION_KIND_LABEL[g.top!.kind]}</Chip>
                  <strong className="text-sm font-semibold text-text-primary">{g.name}</strong>
                  <Chip size="xs" mono tone="neutral">{g.id}</Chip>
                  <MetaLine size="xs" items={[`${g.top!.title} (dim ${g.top!.dimension_id})`]} />
                </Inline>
                <MetaLine
                  size="xs"
                  items={[(['close_claim', 'advance', 'answer'] as const).map((k) => `${g.counts[k] ?? 0} ${RECOMMENDATION_KIND_LABEL[k].toLowerCase()}`).join(' · ')]}
                />
              </Inline>
              {(g.top!.headline ?? g.top!.summary) && (
                <Stack gap="none" className="mt-1 text-sm text-text-secondary">{g.top!.headline ?? g.top!.summary}</Stack>
              )}
            </Card>
          ))}
        </Stack>
      )}
    </PageSection>
  );
}

export default function ReportsPage() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const canPublish = ready && can('PublishReport');

  const { teams } = useTeams();
  const [rollup, setRollup] = useState<RollupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    fetch('/api/assessment/rollup', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: RollupResponse) => { setRollup(body); setError(null); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

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
        title="Reports"
        description="Portfolio-level rollups and cohort analytics across every assessment cohort."
        actions={canPublish ? <Button onClick={() => void publish()} disabled={publishing}>{publishing ? 'Publishing…' : 'Publish report'}</Button> : undefined}
      />

      {loading ? (
        <LoadingState label="Loading portfolio analytics…" />
      ) : error ? (
        <EmptyState title="Couldn't load portfolio analytics" body={error} />
      ) : rollup ? (
        <>
          <StatStrip
            items={[
              { label: 'Teams', value: rollup.teams_total },
              { label: 'Dimensions assessed', value: `${rollup.dimensions_assessed} / ${rollup.dimensions_applicable}`, hint: 'of applicable' },
              { label: `At or above L${rollup.target_level}`, value: rollup.at_or_above_target, tone: 'accent', hint: 'dimensions' },
              { label: 'Claims open', value: rollup.claims_open, tone: rollup.claims_open > 0 ? 'danger' : 'default', hint: 'verification below the claim' },
            ]}
          />
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
          <WhereToStartCard />
          <PageSection title="Teams">
            {teams.length === 0 ? (
              <EmptyState title="No teams yet" />
            ) : (
              <DataTable<TeamSummary>
                data={teams}
                keyField={(t) => t.id}
                striped
                onRowClick={(t) => navigate(`/assessment/teams/${encodeURIComponent(t.id)}`)}
                columns={[
                  {
                    key: 'team',
                    header: 'Team',
                    // The name is a real Button: DataTable's row-click is a bare
                    // <tr onClick> with no tabIndex/keydown, so a keyboard user
                    // had no way to open a team from this table (same defect
                    // the dashboard's all-teams table had). In-app navigation
                    // too — the old window.location assignment reloaded the
                    // whole app and dropped every in-memory state.
                    render: (t) => (
                      <Stack gap="none">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="justify-start font-semibold"
                          onClick={(e) => { e.stopPropagation(); navigate(`/assessment/teams/${encodeURIComponent(t.id)}`); }}
                        >
                          {t.name}
                        </Button>
                        <Chip size="xs" mono tone="neutral">{t.id}</Chip>
                      </Stack>
                    ),
                  },
                  { key: 'cohort', header: 'Cohort', render: (t) => t.cohort_label },
                  {
                    key: 'verified',
                    header: 'Verified level',
                    render: (t) => {
                      const lvl = t.certification?.max_verified_level ?? t.certification?.highest_verified_level ?? null;
                      return lvl == null ? <Chip tone="neutral" size="xs">Not yet</Chip> : `Level ${lvl}`;
                    },
                  },
                  { key: 'claims_open', header: 'Open claims', align: 'right', render: (t) => t.certification?.claims_open ?? 0 },
                  { key: 'follow_ups', header: 'Open follow-ups', align: 'right', render: (t) => t.followups_open },
                ]}
              />
            )}
          </PageSection>
        </>
      ) : (
        <Card padding="md"><InlinePlaceholder>No data.</InlinePlaceholder></Card>
      )}
    </Stack>
  );
}
