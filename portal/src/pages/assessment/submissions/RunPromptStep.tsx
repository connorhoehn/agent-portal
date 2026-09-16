// Step 4 of the Submissions wizard: launch `process-self-assessment` for each committed
// envelope and watch the run ledger for the result. Completion is the RECORD returned by
// GET /runs/:id — never a self-reported "done" from the launch call itself
// (docs/assessment-tenant.md, docs/agent-runs.md §1).

import { useEffect, useRef, useState } from 'react';
import { Button, Card, Chip, Inline, MetaLine, Stack, StatusPill } from '@connorhoehnslalom/ui-components/shared';
import { launchResponseMessage, RUN_STATUS_PILL_STATE } from '../secondaryFormat';
import type { CommitResponse, RunRecord, RunStatus } from '../secondaryTypes';
import { useCapabilities } from '../../../lib/capabilities';
import { toastError, toastSuccess } from '../../../lib/toastStore';

const POLL_MS = 4000;
const COMMAND = 'process-self-assessment';

// Label only — the tone (state) is the shared RUN_STATUS_PILL_STATE
// (secondaryFormat.ts), so this can't quietly disagree with RunsPage on what
// "running" reads as, the way this file's own local table used to.
const RUN_STATE_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

function RunCard({ teamId, envelopeId }: { teamId: string; envelopeId: string }) {
  const { can, ready } = useCapabilities();
  const canRun = ready && can('RunAssessmentAgent');

  const [run, setRun] = useState<RunRecord | null>(null);
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function pollOnce(runId: string) {
    try {
      const res = await fetch(`/api/assessment/runs/${encodeURIComponent(runId)}`, { credentials: 'include' });
      if (!res.ok) return;
      const record = (await res.json()) as RunRecord;
      setRun(record);
      if (record.status !== 'running') stopPolling();
    } catch {
      // Transient — the interval tries again on the next tick.
    }
  }

  async function launch() {
    if (!canRun || launching) return;
    setLaunching(true);
    setMessage(null);
    try {
      const res = await fetch('/api/assessment/runs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: COMMAND, args: { team: teamId, submission: envelopeId }, team_id: teamId }),
      });
      const body = (await res.json().catch(() => ({}))) as { run_id?: string; started_at?: string; error?: string };
      const outcome = launchResponseMessage(res.status, body.error);
      if (!outcome.ok || !body.run_id) {
        setMessage(outcome.message);
        toastError(null, 'Run not started', outcome.message);
        return;
      }
      toastSuccess(null, 'Run started', `Processing ${envelopeId}.`);
      setRun({
        id: body.run_id,
        command: COMMAND,
        team_id: teamId,
        status: 'running',
        started_at: body.started_at ?? new Date().toISOString(),
        finished_at: null,
      });
      stopPolling();
      pollRef.current = setInterval(() => void pollOnce(body.run_id!), POLL_MS);
    } catch (err) {
      const msg = (err as Error).message || "Couldn't start the run.";
      setMessage(msg);
      toastError(null, 'Run not started', msg);
    } finally {
      setLaunching(false);
    }
  }

  const status = run?.status ?? null;

  return (
    <Card padding="md">
      <Inline align="center" gap="sm" className="mb-2">
        <Chip tone="neutral">{teamId}</Chip>
        <MetaLine size="xs" items={[envelopeId]} />
        {status && <StatusPill state={RUN_STATUS_PILL_STATE[status]} label={RUN_STATE_LABEL[status]} size="sm" />}
      </Inline>

      {status === 'completed' ? (
        <Stack gap="none" className="text-sm text-text-secondary">{run?.summary ?? 'Processing complete — results are on the team\'s record.'}</Stack>
      ) : status === 'failed' ? (
        <Stack gap="none" className="text-sm font-semibold text-danger">{run?.error ?? 'The processing run failed. See Activity for details.'}</Stack>
      ) : status === 'running' ? (
        <Stack gap="none" className="text-sm text-text-secondary">
          {run?.progress?.phase ?? 'Running'}
          {run?.progress?.detail ? ` — ${run.progress.detail}` : '…'}
        </Stack>
      ) : (
        <Stack gap="none" className="text-sm text-text-tertiary">Not started yet.</Stack>
      )}

      {message && <Stack gap="none" className="mt-1 text-xs font-semibold text-danger">{message}</Stack>}

      {canRun && status !== 'running' && (
        <Inline className="mt-3">
          <Button onClick={() => void launch()} disabled={launching}>
            {launching ? 'Starting…' : status === 'completed' ? 'Process again' : 'Process submission'}
          </Button>
        </Inline>
      )}
    </Card>
  );
}

interface RunPromptStepProps {
  commit: CommitResponse;
  onStartOver: () => void;
}

export default function RunPromptStep({ commit, onStartOver }: RunPromptStepProps) {
  return (
    <Stack gap="md">
      <Inline align="center" justify="between" gap="sm">
        <Stack gap="none" className="text-sm text-text-secondary">
          Process each submission — this watches its run and shows the record&apos;s status when it lands.
        </Stack>
        <Button variant="secondary" onClick={onStartOver}>Start over</Button>
      </Inline>
      <Stack gap="sm">
        {commit.results
          .filter((r) => !r.skipped)
          .map((result) => (
            <RunCard key={result.envelope_id} teamId={result.team_id} envelopeId={result.envelope_id} />
          ))}
      </Stack>
    </Stack>
  );
}
