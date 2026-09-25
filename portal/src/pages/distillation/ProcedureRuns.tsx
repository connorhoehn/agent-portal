// A procedure's Runs tab (spec §1 "procedure"; the Overview mockup's Runs
// tab): the latest-run callout, the ordered steps with a run's marker on each
// (the latest, or the run a "View run" link named — `?run=`), the run
// history, and — for
// ManageBots — "Record a run" (POST /procedures/:id/apply, the one write on a
// Knowledge record).
//
// Steps are the procedure's ordered facts (lineage `fact` nodes with an
// ordinal); run outcomes come from GET /procedures/:id/runs. Both are folded
// by procedureRunsModel.ts. Run markers live ONLY here: the Content tab shows
// the approach as neutral numbered steps and names a failed latest run in one
// callout (docs/distillation-guide-record-spec.md).
import { useMemo, useState } from 'react';
import { ProcedureSteps, WorkActivityList, type WorkActivityEvent } from '@connorhoehnslalom/ui-components';
import {
  Banner, Button, DetailSection, FormField, InlineAlert, Inline, SegmentedControl, Select, Stack, Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { stepsFromLineage } from './distillationFormat';
import {
  chosenRun, latestRun, latestRunCallout, runHistoryRows, stepMarkers, type ProcedureStepDef,
} from './procedureRunsModel';
import type { ApplicationOutcome, Lineage, ProcedureRunsResponse } from './types';

export interface ProcedureData {
  steps: ProcedureStepDef[];
  runs: ProcedureRunsResponse['runs'];
  loading: boolean;
  error: string | null;
  refreshRuns: () => void;
}

export function useProcedure(artifactId: string | null): ProcedureData {
  const lineage = useFetch<Lineage>(
    artifactId ? `/api/distillation/items/${encodeURIComponent(artifactId)}/lineage?depth=2` : null, 0,
  );
  const runs = useFetch<ProcedureRunsResponse>(
    artifactId ? `/api/distillation/procedures/${encodeURIComponent(artifactId)}/runs` : null, 0,
  );
  const steps = useMemo<ProcedureStepDef[]>(
    // The plain wording when the fact has one (the same text the Content
    // tab's approach shows), else the fact's statement.
    () => (lineage.data
      ? stepsFromLineage(lineage.data).map((s) => {
        const plain = s.meta?.['plain'];
        return { id: s.id, title: typeof plain === 'string' && plain ? plain : s.label, ordinal: s.ordinal };
      })
      : []),
    [lineage.data],
  );
  return {
    steps,
    runs: runs.data?.runs ?? [],
    loading: (lineage.isLoading && !lineage.data) || (runs.isLoading && !runs.data),
    error: lineage.error ?? runs.error,
    refreshRuns: runs.refresh,
  };
}

/** The steps once, each with the chosen run's outcome (the latest when none
 *  is named). */
function ProcedureStepList({ data, runId }: { data: ProcedureData; runId: string | null }) {
  const steps = useMemo(() => stepMarkers(data.steps, data.runs, runId), [data.steps, data.runs, runId]);
  const chosen = chosenRun(data.runs, runId);
  const title = chosen && chosen !== latestRun(data.runs) ? 'Steps in the chosen run' : 'Steps in the latest run';
  return (
    <DetailSection first title={title}>
      <ProcedureSteps
        aria-label="Procedure steps"
        numbered
        steps={steps}
        emptyLabel={data.loading ? 'Loading steps…' : data.error ? `Steps could not be read: ${data.error}` : 'No ordered steps on this procedure.'}
      />
    </DetailSection>
  );
}

const CALLOUT_TONE = { danger: 'error', success: 'success', warning: 'warning', neutral: 'info' } as const;

function RecordRunForm({ artifactId, steps, onRecorded }: {
  artifactId: string;
  steps: ProcedureStepDef[];
  onRecorded: () => void;
}) {
  const [outcome, setOutcome] = useState<ApplicationOutcome>('succeeded');
  const [stepId, setStepId] = useState('');
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
      setNote(''); setStepId(''); setOutcome('succeeded');
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
            {(p) => (
              <Select
                {...p}
                value={stepId}
                onChange={(e) => setStepId(e.target.value)}
                placeholder="Pick the step it failed on"
                options={steps.map((s, i) => ({ value: s.id, label: `${s.ordinal ?? i + 1}. ${s.title}` }))}
              />
            )}
          </FormField>
        )}
        <FormField label="Note" hint="one line: what you saw">
          {(p) => <Textarea {...p} autoResize minRows={2} maxRows={5} value={note} onChange={(e) => setNote(e.target.value)} />}
        </FormField>
        {error && <Banner variant="error">{error}</Banner>}
        <Inline className="justify-end">
          <Button size="sm" variant="primary" onClick={() => { void submit(); }} disabled={busy || (outcome === 'failed' && !stepId)}>
            {busy ? 'Recording…' : 'Record run'}
          </Button>
        </Inline>
      </Stack>
    </DetailSection>
  );
}

const OUTCOME_TEXT = {
  succeeded: 'Succeeded', failed: 'Failed', partial: 'Stopped part-way', 'not-started': 'No step outcomes',
} as const;

/** The Runs tab: latest-run callout, steps with statuses, history, record. */
export function ProcedureRunsTab({ artifactId, data, canRecord, runId }: {
  artifactId: string;
  data: ProcedureData;
  canRecord: boolean;
  /** The run a link named (`?run=`); null shows the latest. */
  runId: string | null;
}) {
  const callout = useMemo(() => latestRunCallout(data.steps, data.runs), [data.steps, data.runs]);
  const events = useMemo<WorkActivityEvent[]>(
    () => runHistoryRows(data.steps, data.runs).map((r) => ({
      id: r.id,
      kind: 'run',
      at: r.at,
      actor: r.actor,
      text: r.failedAtStep != null ? `Failed at step ${r.failedAtStep}` : OUTCOME_TEXT[r.outcome],
      detail: [r.summary, r.note].filter(Boolean).join(' — '),
    })),
    [data.steps, data.runs],
  );
  return (
    <Stack gap="md">
      {callout && <InlineAlert tone={CALLOUT_TONE[callout.tone]}>{callout.text}</InlineAlert>}
      <ProcedureStepList data={data} runId={runId} />
      <WorkActivityList
        title="Run history"
        events={events}
        loading={data.loading}
        error={data.error ? `Runs could not be read: ${data.error}` : null}
        emptyLabel="Never run — this procedure is unproven until a session applies it."
      />
      {canRecord && data.steps.length > 0 && (
        <RecordRunForm artifactId={artifactId} steps={data.steps} onRecorded={data.refreshRuns} />
      )}
    </Stack>
  );
}
