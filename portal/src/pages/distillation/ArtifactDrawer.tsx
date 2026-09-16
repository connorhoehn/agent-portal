// The artifact detail drawer — extracted from ArtifactsPage.tsx (slice 4,
// docs/distillation-concept-audit-2026-09-16.md §3/§4) so the Lineage picker's
// row cards can open the exact same expand view instead of a second copy
// that drifts from it. ArtifactsPage.tsx still owns the table that opens it;
// this file owns the drawer body itself plus its two artifact-only sections
// (the Library "Published as" line, and a procedure's steps/runs).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Banner, Button, Card, Chip, DetailSection, EventRow, FormField, Inline, MarkdownView, MetaLine, SegmentedControl,
  Select, Stack, StackDiagram, Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { LineageFrame } from './LineageFrame';
import { T } from './Text';
import {
  ARTIFACT_STATUS_TONE, ARTIFACT_TYPE_LABEL, ARTIFACT_TYPE_TONE, OUTCOME_LABEL,
  OUTCOME_SEVERITY, artifactFactCount, evidenceLabel, factsFromLineage, runsLabel, stepTonesForRun,
  stepsFromLineage, stepsLabel,
} from './distillationFormat';
import type {
  ApplicationOutcome, ApplicationsResponse, Artifact, ArtifactClassification, ArtifactStatus, Lineage,
} from './types';

// Sensitivity chip — a separate vocabulary from ARTIFACT_STATUS_TONE
// (lifecycle) and ARTIFACT_TYPE_TONE (kind) above: classification answers
// "who is allowed to see this," not "is this done" or "what is this."
export const ARTIFACT_CLASSIFICATION_LABEL: Record<ArtifactClassification, string> = {
  internal: 'Internal',
  confidential: 'Confidential',
  public: 'Public',
};
export const ARTIFACT_CLASSIFICATION_TONE: Record<ArtifactClassification, 'neutral' | 'danger' | 'info'> = {
  internal: 'neutral',
  confidential: 'danger',
  public: 'info',
};

/** ArtifactStatus, as a StatusPillState — the card header wants a pill, the
 *  rest of this domain (table chips, drawer header) already uses Chip +
 *  ARTIFACT_STATUS_TONE, so this map stays local rather than growing a
 *  second convention into distillationFormat.ts. */
export const ARTIFACT_STATUS_PILL_STATE: Record<ArtifactStatus, 'neutral' | 'success' | 'warning'> = {
  draft: 'neutral',
  published: 'success',
  retired: 'warning',
};

/** "last used 2h ago" vs "never used" — `relativeTime(null)` silently
 *  returns `''`, which would make MetaLine just drop the item; a reader
 *  cannot tell "no data" from "genuinely never used" from an absent bullet,
 *  so this spells out the honest, deliberate difference. */
export function lastUsedLabel(lastUsedAt: string | null): string {
  return lastUsedAt ? `last used ${relativeTime(lastUsedAt)}` : 'never used';
}

/** The artifact-side mirror of the Library's "Distilled from" section — this
 *  artifact was PUBLISHED AS a real Library asset. Resolves the asset's name
 *  rather than showing the bare id, same reasoning as the Library section
 *  showing the artifact's title rather than its id. */
function PublishedAs({ libraryItemId }: { libraryItemId: string }) {
  const { data } = useFetch<{ asset: { name: string } }>(`/api/library/${encodeURIComponent(libraryItemId)}`, 0);
  if (!data?.asset) return null;
  return (
    <Inline gap="xs" align="center">
      <T className="text-[11px] text-text-tertiary">Published as</T>
      <Link
        to={`/iq/library/${encodeURIComponent(libraryItemId)}`}
        className="text-[11px] text-primary no-underline hover:underline"
      >
        {data.asset.name}
      </Link>
    </Inline>
  );
}

/** The one write on this surface: a person recording that a procedure was
 *  run and how it went. Same gate as Review (ManageBots); the route is
 *  `POST /procedures/:id/apply`. A failed run names the step it stopped on
 *  — that is what tones the steps above and what the Overview's verdict
 *  counts — so the step picker only appears for `failed`. */
function RecordRunForm({
  artifactId, steps, onRecorded,
}: {
  artifactId: string;
  steps: Array<{ id: string; ordinal: number; label: string }>;
  onRecorded: () => void;
}) {
  const [outcome, setOutcome] = useState<ApplicationOutcome>('succeeded');
  const [stepId, setStepId] = useState<string>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/distillation/procedures/${encodeURIComponent(artifactId)}/apply`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome,
          ...(outcome === 'failed' ? { failed_at_step_id: stepId || null } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) { setError(body.error ?? `HTTP ${res.status}`); return; }
      setNote('');
      setStepId('');
      setOutcome('succeeded');
      onRecorded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailSection title="Record a run" hint="what happened when a session ran this">
      <Stack gap="sm">
        <SegmentedControl
          size="sm"
          aria-label="Outcome"
          value={outcome}
          onChange={(v) => setOutcome(v as ApplicationOutcome)}
          options={[
            { label: 'Succeeded', value: 'succeeded' },
            { label: 'Failed', value: 'failed' },
            { label: 'Abandoned', value: 'abandoned' },
          ]}
        />
        {outcome === 'failed' && (
          <FormField label="Stopped at step" required>
            {/* FormField hands its render prop a `labelId` that is not a DOM
                attribute (queue: FormField `labelId` DOM leak) — dropped
                before the spread so React does not warn on every render. */}
            {({ labelId: _labelId, ...p }) => (
              <Select
                {...p}
                value={stepId}
                onChange={(e) => setStepId(e.target.value)}
                placeholder="Pick the step it failed on"
                options={steps.map((s) => ({ value: s.id, label: `${s.ordinal}. ${s.label}` }))}
              />
            )}
          </FormField>
        )}
        <FormField label="Note" hint="one line: what you saw">
          {({ labelId: _labelId, ...p }) => (
            <Textarea {...p} autoResize minRows={2} maxRows={5} value={note} onChange={(e) => setNote(e.target.value)} />
          )}
        </FormField>
        {error && <Banner variant="error">{error}</Banner>}
        <Inline className="justify-end">
          <Button
            size="sm"
            variant="primary"
            onClick={() => { void submit(); }}
            disabled={busy || (outcome === 'failed' && !stepId)}
          >
            Record run
          </Button>
        </Inline>
      </Stack>
    </DetailSection>
  );
}

function ProcedureSections({ artifact: a, lineage }: { artifact: Artifact; lineage: Lineage | null }) {
  const { data: runsData, isLoading: runsLoading, refresh: refreshRuns } =
    useFetch<ApplicationsResponse>(`/api/distillation/procedures/${encodeURIComponent(a.id)}/applications`, 0);
  const { can, ready } = useCapabilities();
  const canRecord = ready && can('ManageBots');
  const runs = runsData?.applications ?? [];
  const latest = runs[0] ?? null;
  const steps = lineage ? stepsFromLineage(lineage) : [];
  const tones = stepTonesForRun(steps, latest);
  const evidenceOf = (id: string) => (lineage?.edges ?? []).filter((e) => e.relation === 'supports' && e.to === id).length;

  return (
    <>
      <DetailSection title="Steps" hint={steps.length > 0 ? stepsLabel(steps.length) : undefined}>
        {steps.length === 0 ? (
          <T className="text-[11px] text-text-tertiary">{lineage ? 'No ordered steps on this procedure.' : 'Loading steps…'}</T>
        ) : (
          <StackDiagram
            orientation="vertical"
            connector="arrow"
            data-testid="procedure-steps"
            layers={steps.map((s, i) => ({
              id: s.id,
              label: `${s.ordinal}. ${s.label}`,
              description: typeof s.meta['confidence'] === 'number'
                ? `confidence ${Math.round((s.meta['confidence'] as number) * 100)}%`
                : undefined,
              tone: tones[i] ?? 'neutral',
              meta: <Chip tone="neutral" size="xs">{evidenceLabel(evidenceOf(s.id))}</Chip>,
            }))}
          />
        )}
      </DetailSection>

      {canRecord && steps.length > 0 && (
        <RecordRunForm artifactId={a.id} steps={steps} onRecorded={() => { void refreshRuns(); }} />
      )}

      <DetailSection title="Runs" hint={runsData ? runsLabel({
        total: runs.length,
        succeeded: runs.filter((r) => r.outcome === 'succeeded').length,
        failed: runs.filter((r) => r.outcome === 'failed').length,
        abandoned: runs.filter((r) => r.outcome === 'abandoned').length,
      }) : undefined}>
        {runsLoading && !runsData ? (
          <T className="text-[11px] text-text-tertiary">Loading runs…</T>
        ) : runs.length === 0 ? (
          <T className="text-[11px] text-text-tertiary">Never run to completion — this procedure is unproven until a session applies it.</T>
        ) : (
          <Stack gap="none" data-testid="procedure-runs">
            {runs.map((r) => {
              const stoppedAt = r.failed_at_step_id ? steps.find((s) => s.id === r.failed_at_step_id) : undefined;
              const where = stoppedAt ? ` — stopped at step ${stoppedAt.ordinal}: ${stoppedAt.label}` : '';
              return (
                <EventRow
                  key={r.id}
                  timestamp={relativeTime(r.applied_at)}
                  type={OUTCOME_LABEL[r.outcome]}
                  severity={OUTCOME_SEVERITY[r.outcome]}
                  summary={`${r.session_id} · ${r.box_id}${where}${r.note ? ` — ${r.note}` : ''}`}
                />
              );
            })}
          </Stack>
        )}
      </DetailSection>
    </>
  );
}

export function ArtifactDrawerBody({ artifact: a }: { artifact: Artifact }) {
  const navigate = useNavigate();
  const { data: lineage, isLoading: lineageLoading, error: lineageError } =
    useFetch<Lineage>(`/api/distillation/items/${encodeURIComponent(a.id)}/lineage?depth=2`, 0);
  const isProcedure = a.type === 'procedure';

  return (
    <Stack gap="lg">
      <Stack gap="xs" as="header">
        <Inline gap="xs" wrap align="center">
          <Chip tone={ARTIFACT_TYPE_TONE[a.type]} size="xs">{ARTIFACT_TYPE_LABEL[a.type]}</Chip>
          <Chip tone={ARTIFACT_STATUS_TONE[a.status]} size="xs" dot="static">{a.status}</Chip>
          <Chip tone={ARTIFACT_CLASSIFICATION_TONE[a.classification]} size="xs">
            {ARTIFACT_CLASSIFICATION_LABEL[a.classification]}
          </Chip>
          <T className="text-[15px] font-semibold text-text-primary">{a.title}</T>
        </Inline>
        <T className="text-[12px] text-text-secondary">{a.summary}</T>
        <MetaLine
          size="xs"
          items={[
            `owner ${a.owner}`,
            `${a.cluster_ids.length} cluster${a.cluster_ids.length === 1 ? '' : 's'}`,
            `${artifactFactCount(a)} fact${artifactFactCount(a) === 1 ? '' : 's'}`,
            `confidence ${Math.round(a.confidence * 100)}%`,
            lastUsedLabel(a.last_used_at),
            a.reviewed_by ? `reviewed by ${a.reviewed_by}` : null,
          ]}
        />
        {a.library_item_id && <PublishedAs libraryItemId={a.library_item_id} />}
      </Stack>

      <Inline gap="xs">
        {a.library_item_id && (
          <Button size="sm" variant="secondary" onClick={() => navigate(`/iq/library/${encodeURIComponent(a.library_item_id!)}`)}>
            Open in Library
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => navigate(`/iq/distillation/lineage?focus=${encodeURIComponent(a.id)}`)}>
          Open lineage
        </Button>
      </Inline>

      <DetailSection first title="Body">
        <MarkdownView markdown={a.body_markdown} />
      </DetailSection>

      {isProcedure && <ProcedureSections artifact={a} lineage={lineage ?? null} />}

      {(() => {
        // A fact's content only exists in lineage — `Artifact.facts` is bare
        // IDs (there is no `GET /facts/:id`) — so this section waits on the
        // same lineage fetch the mini-lineage below already needs. A
        // procedure's steps are facts too; they are listed once, as steps.
        const stepIds = new Set(isProcedure && lineage ? stepsFromLineage(lineage).map((s) => s.id) : []);
        const facts = lineage ? factsFromLineage(lineage).filter((f) => !stepIds.has(f.id)) : [];
        if (lineageLoading && !lineage) return <DetailSection title="Facts"><T className="text-[11px] text-text-tertiary">Loading facts…</T></DetailSection>;
        if (facts.length === 0) return null;
        return (
          <DetailSection title="Facts" hint={`${facts.length} fact${facts.length === 1 ? '' : 's'}`}>
            <Stack gap="xs">
              {facts.map((f) => (
                <Card key={f.id} padding="sm">
                  <Stack gap="xs">
                    <T className="text-[12.5px] text-text-primary">{f.statement}</T>
                    <Inline gap="xs" align="center">
                      <Chip tone="neutral" size="xs">{evidenceLabel(f.evidenceCount)}</Chip>
                      <T className="text-[10px] text-text-tertiary">confidence {Math.round(f.confidence * 100)}%</T>
                    </Inline>
                  </Stack>
                </Card>
              ))}
            </Stack>
          </DetailSection>
        );
      })()}

      <DetailSection title="Distilled from" hint="mini-lineage — observations → cluster → this artifact">
        <LineageFrame lineage={lineage ?? null} loading={lineageLoading} error={lineageError} focusId={a.id} compact />
      </DetailSection>
    </Stack>
  );
}
