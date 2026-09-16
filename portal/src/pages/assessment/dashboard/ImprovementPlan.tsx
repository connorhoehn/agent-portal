// The improvement plan — what a team's baseline actually asks of them.
//
// Three things carried over verbatim from the source's ImprovementPlan.tsx:
// there is no grade or ranking against other teams; the three kinds of entry
// (close the claim / advance the practice / answer the question) are visibly
// distinct, not only by colour; and nothing here starts an agent run —
// "Draft story" is a real POST (gated on RunAssessmentAgent), but a person
// chooses it, it is never automatic.

import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  CollapsibleSection,
  EmptyState,
  Inline,
  LoadingState,
  MetaLine,
  SectionLabel,
  Stack,
  type ChipTone,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { toastError, toastSuccess } from '../../../lib/toastStore';
import { sendJson } from '../../../lib/writeJson';
import { useCapabilities } from '../../../lib/capabilities';
import {
  certificationFor,
  countsSentence,
  emptyStateFor,
  groupPlan,
  kindMeta,
  normalizePlan,
  type ApiRecommendationsResponse,
  orderedRecommendations,
  unassessedGroupHeading,
  type Recommendation,
  type RecommendationKind,
  type RecommendationsResponse,
} from '../assessmentFormat';
import { dimensionCertificationStatement } from '../types';
import { LevelBadge } from './LevelBadge';

const KIND_TONE: Record<RecommendationKind, ChipTone> = {
  close_claim: 'warning',
  advance: 'info',
  answer: 'neutral',
};

function KindChip({ kind }: { kind: RecommendationKind }) {
  const meta = kindMeta(kind);
  return (
    <Chip tone={KIND_TONE[kind]} uppercase size="xs" title={meta.meaning}>
      {meta.label}
    </Chip>
  );
}

function KindLegend({ kinds }: { kinds: RecommendationKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <Card padding="md" className="bg-surface-hover ring-1 ring-border">
      <Stack gap="sm">
        {kinds.map((kind) => (
          <Stack key={kind} gap="xs" className="sm:flex-row sm:items-start sm:gap-3">
            <Inline className="shrink-0 sm:w-44"><KindChip kind={kind} /></Inline>
            <Stack gap="none" className="text-xs leading-relaxed text-text-secondary">{kindMeta(kind).meaning}</Stack>
          </Stack>
        ))}
      </Stack>
    </Card>
  );
}

function DraftStoryButton({ teamId, rec }: { teamId: string; rec: Recommendation }) {
  const { can } = useCapabilities();
  const [busy, setBusy] = useState(false);
  if (!can('RunAssessmentAgent')) return null;

  const draft = async () => {
    setBusy(true);
    try {
      await sendJson('/api/assessment/runs', 'POST', {
        command: 'develop-jira-story', args: { team: teamId, recommendation: rec.dimension_id },
      });
      toastSuccess(null, 'Story draft started', `Dimension ${rec.dimension_id} — check the Stories tab shortly.`);
    } catch (err) {
      toastError(null, 'Could not start the draft', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="primary" size="sm" disabled={busy} onClick={draft}>
      {busy ? 'Starting…' : 'Draft story'}
    </Button>
  );
}

function RecommendationCard({ rec, teamId }: { rec: Recommendation; teamId: string }) {
  const cert = certificationFor(rec);
  const statement = dimensionCertificationStatement(cert);

  return (
    <Card padding="md" className={`border-l-4 ${
      rec.kind === 'close_claim' ? 'border-l-warning' : rec.kind === 'advance' ? 'border-l-info' : 'border-l-border'
    }`}>
      <Inline justify="between" align="start" wrap gap="sm">
        <Stack gap="none" className="min-w-0">
          <SectionLabel>Dimension {rec.dimension_id}</SectionLabel>
          <strong className="mt-0.5 block text-base font-bold leading-tight text-text-primary">{rec.dimension_title}</strong>
        </Stack>
        <KindChip kind={rec.kind} />
      </Inline>

      <Stack gap="none" className="mt-2.5 text-[15px] font-semibold leading-snug text-text-primary">{rec.headline}</Stack>

      <Inline gap="sm" wrap align="center" className="mt-2.5">
        {cert && <LevelBadge level={cert.verified_level} size="xs" />}
        {statement && <MetaLine items={[statement]} size="xs" tone="secondary" />}
        {rec.team_flagged_priority && (
          <strong className="text-[11px] font-semibold text-text-secondary">The team asked us to look at this one</strong>
        )}
      </Inline>

      <CollapsibleSection
        className="mt-3"
        title="What this involves"
        badge={rec.existing_stories.length > 0 ? <Chip size="xs" mono>{rec.existing_stories.length}</Chip> : undefined}
      >
        <Stack gap="sm" className="px-4 py-3">
          <Stack gap="none">
            <SectionLabel>Why this is on the list</SectionLabel>
            {rec.why && <Stack gap="none" className="mt-1 text-sm text-text-primary">{rec.why}</Stack>}
          </Stack>
          {rec.what_would_help.length > 0 && (
            <Stack gap="none">
              <SectionLabel>
                {rec.kind === 'close_claim' ? 'What would let us confirm it' : 'What would help most'}
              </SectionLabel>
              <Stack gap="xs" className="mt-1 text-sm text-text-primary">
                {rec.what_would_help.map((t, i) => <Inline key={i} gap="xs" align="start">&bull; {t}</Inline>)}
              </Stack>
            </Stack>
          )}
          {rec.level_up_criteria.length > 0 && (
            <Stack gap="none">
              <SectionLabel>
                {rec.next_level !== null ? `What Level ${rec.next_level} asks for` : 'What the next level asks for'}
              </SectionLabel>
              <Stack gap="xs" className="mt-1 text-sm text-text-primary">
                {rec.level_up_criteria.map((t, i) => <Inline key={i} gap="xs" align="start">&bull; {t}</Inline>)}
              </Stack>
            </Stack>
          )}
          {rec.open_questions.length > 0 && (
            <Stack gap="none">
              <SectionLabel>Questions still open</SectionLabel>
              <Stack gap="xs" className="mt-1 text-sm text-text-primary">
                {rec.open_questions.map((t, i) => <Inline key={i} gap="xs" align="start">&bull; {t}</Inline>)}
              </Stack>
            </Stack>
          )}
          <Stack gap="none">
            {rec.existing_stories.length > 0 ? (
              <>
                <SectionLabel>
                  {rec.existing_stories.length === 1 ? 'Story already drafted' : 'Stories already drafted'}
                </SectionLabel>
                <Stack gap="xs" className="mt-1 text-sm text-text-primary">
                  {rec.existing_stories.map((s) => (
                    <Inline key={s.path} gap="xs" align="center">
                      {s.jira_key && <Chip size="xs" mono>{s.jira_key}</Chip>}
                      {s.title}
                    </Inline>
                  ))}
                </Stack>
              </>
            ) : (
              <>
                <SectionLabel>No story drafted for this yet</SectionLabel>
                <DraftStoryButton teamId={teamId} rec={rec} />
              </>
            )}
          </Stack>
        </Stack>
      </CollapsibleSection>
    </Card>
  );
}

function UnassessedGroup({ recs }: { recs: Recommendation[] }) {
  return (
    <Card padding="md" className="border-l-4 border-l-border">
      <Inline justify="between" align="start" wrap gap="sm">
        <Stack gap="none" className="min-w-0">
          <strong className="text-base font-bold leading-tight text-text-primary">{unassessedGroupHeading(recs.length)}</strong>
          <Stack gap="none" className="mt-1 text-sm leading-relaxed text-text-secondary">
            There is not enough on file yet to say anything about{' '}
            {recs.length === 1 ? 'this dimension' : 'these dimensions'}. Answering the questions is what would let an
            assessment start.
          </Stack>
        </Stack>
        <KindChip kind="answer" />
      </Inline>
      <CollapsibleSection
        className="mt-3"
        title="Which dimensions these are"
        badge={<Chip size="xs" mono>{recs.length}</Chip>}
      >
        <Stack gap="md" className="px-4 py-3">
          {recs.map((rec) => (
            <Stack key={`${rec.dimension_id}-${rec.rank}`} gap="none">
              <strong className="text-sm font-semibold text-text-primary">Dimension {rec.dimension_id} — {rec.dimension_title}</strong>
              <Stack gap="none" className="mt-0.5 text-sm text-text-secondary">{rec.headline}</Stack>
            </Stack>
          ))}
        </Stack>
      </CollapsibleSection>
    </Card>
  );
}

export function ImprovementPlan({ teamId }: { teamId: string }) {
  const { data: apiData, isLoading, error } = useFetch<ApiRecommendationsResponse>(
    `/api/assessment/teams/${encodeURIComponent(teamId)}/recommendations`,
  );
  // The wire shape is the contract; the page model is what the components read.
  const data = useMemo(() => (apiData ? normalizePlan(apiData) : apiData), [apiData]);

  if (isLoading) return <LoadingState label="Building the improvement plan…" />;
  if (error || !data) {
    return (
      <EmptyState
        title="No improvement plan on this environment yet"
        body="The assessment API here does not serve plans yet. The scorecard is unaffected — this panel will fill in once the plan endpoint is available."
      />
    );
  }

  const recommendations = orderedRecommendations(data);
  const { actionable, unassessed } = groupPlan(recommendations);
  const empty = emptyStateFor(data);
  const counts = countsSentence(data.counts, data.target_level);
  const kindsPresent = (['close_claim', 'advance', 'answer'] as const).filter((k) =>
    recommendations.some((r) => r.kind === k),
  );

  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <SectionLabel>Improvement plan</SectionLabel>
        {data.summary && <Stack gap="none" className="max-w-4xl text-lg font-semibold leading-snug text-text-primary">{data.summary}</Stack>}
        {counts && <Stack gap="none" className="max-w-4xl text-sm leading-relaxed text-text-secondary">{counts}</Stack>}
        <Stack gap="none" className="max-w-4xl text-xs leading-relaxed text-text-tertiary">
          Each entry states what the team has said about itself, how far the evidence reaches today, and what would
          let us confirm more. Nothing here is a comparison against another team.
        </Stack>
      </Stack>

      {empty ? (
        <EmptyState title={empty.title} body={empty.body} />
      ) : (
        <>
          <KindLegend kinds={kindsPresent} />
          {actionable.length > 0 && (
            <Stack gap="sm">
              {actionable.map((rec) => <RecommendationCard key={`${rec.dimension_id}-${rec.rank}`} rec={rec} teamId={teamId} />)}
            </Stack>
          )}
          {unassessed.length > 0 && <UnassessedGroup recs={unassessed} />}
        </>
      )}
    </Stack>
  );
}
