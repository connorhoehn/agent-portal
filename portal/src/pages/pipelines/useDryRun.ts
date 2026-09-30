// Start a runbook dry-run (POST /api/pipelines/definitions/:id/dry-run) and
// answer the money brakes it shares with dispatch-work: a 409 names its gate
// and the ONE confirm flag that re-sends the write past that gate, so the
// confirmation a person gives can only ever confirm the fence they were shown.

import { useState } from 'react';
import { writeJson } from '../../lib/writeJson';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { brakesNote, type DryRunRecord } from '../../lib/pipelineDefinitions';

interface DryRunResponse { run: DryRunRecord; jobId: string; brakes: string[] }

export interface PendingConfirm { definitionId: string; title: string; message: string; flags: Record<string, true> }

export function useDryRun(onStarted: (run: DryRunRecord) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  async function send(definitionId: string, title: string, flags: Record<string, true>) {
    setBusy(definitionId);
    const tid = toastPending('Starting a dry-run', title);
    const res = await writeJson<DryRunResponse>(`/api/pipelines/definitions/${encodeURIComponent(definitionId)}/dry-run`, 'POST', flags);
    setBusy(null);
    if (res.ok && res.data) {
      toastSuccess(tid, 'Dry-run queued', `${res.data.run.id} — ${brakesNote(res.data.brakes)}`);
      onStarted(res.data.run);
      return;
    }
    if (res.status === 409 && res.confirmFlag) {
      toastError(tid, 'A money brake stopped the dry-run', res.error ?? undefined);
      setConfirm({ definitionId, title, message: res.error ?? 'Over budget.', flags: { ...flags, [res.confirmFlag]: true } });
      return;
    }
    toastError(tid, 'Could not start the dry-run', res.error ?? undefined);
  }

  return {
    busy,
    confirm,
    start: (definitionId: string, title: string) => void send(definitionId, title, {}),
    confirmNow: () => { if (confirm) { const c = confirm; setConfirm(null); void send(c.definitionId, c.title, c.flags); } },
    dismiss: () => setConfirm(null),
  };
}
