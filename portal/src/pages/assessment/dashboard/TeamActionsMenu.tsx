// Team actions — the scorecard header's Change lead / Reset assessment /
// Delete team controls, mirroring the source app's TeamActionsMenu. All four
// mutating verbs (create is a separate "New team" affordance on the
// dashboard) are gated on `ScoreAssessment` — the same capability
// `PATCH/DELETE/POST reset-assessment /teams/:id...` gate on server-side
// (routes/assessment.ts) — so the whole menu is absent, not merely disabled,
// for a role that lacks it.

import { useEffect, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  FormField,
  Inline,
  Input,
  Modal,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../../lib/capabilities';
import { toastError, toastSuccess } from '../../../lib/toastStore';

interface TeamActionsMenuProps {
  teamId: string;
  teamName: string;
  currentLead: string;
  /** PATCH (lead) or POST reset-assessment succeeded — refetch the team detail. */
  onChanged: () => void;
  /** DELETE succeeded — the team is gone, navigate away from its scorecard. */
  onDeleted: () => void;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${res.status}`;
}

export function TeamActionsMenu({ teamId, teamName, currentLead, onChanged, onDeleted }: TeamActionsMenuProps) {
  const { can, ready } = useCapabilities();
  const [leadOpen, setLeadOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [lead, setLead] = useState(currentLead);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (leadOpen) setLead(currentLead); }, [leadOpen, currentLead]);

  if (!ready || !can('ScoreAssessment')) return null;

  async function saveLead() {
    setBusy(true);
    try {
      const res = await fetch(`/api/assessment/teams/${encodeURIComponent(teamId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assessment_lead: lead.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toastSuccess(null, 'Assessment lead updated');
      setLeadOpen(false);
      onChanged();
    } catch (err) {
      toastError(null, 'Could not update lead', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetAssessment() {
    setBusy(true);
    try {
      const res = await fetch(`/api/assessment/teams/${encodeURIComponent(teamId)}/reset-assessment`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readError(res));
      toastSuccess(null, 'Assessment reset', `${teamName}'s scoring is back to a clean slate.`);
      setResetOpen(false);
      onChanged();
    } catch (err) {
      toastError(null, 'Could not reset', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTeam() {
    setBusy(true);
    try {
      const res = await fetch(`/api/assessment/teams/${encodeURIComponent(teamId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readError(res));
      toastSuccess(null, 'Team deleted', `${teamName} (${teamId}) has been removed.`);
      setDeleteOpen(false);
      onDeleted();
    } catch (err) {
      toastError(null, 'Could not delete', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu
        trigger="⋯"
        triggerLabel={`Actions for ${teamName}`}
        align="end"
        sections={[{
          items: [
            { label: 'Change lead', onSelect: () => setLeadOpen(true) },
            { label: 'Reset assessment', onSelect: () => setResetOpen(true) },
            { label: 'Delete team', danger: true, onSelect: () => setDeleteOpen(true) },
          ],
        }]}
      />

      <Modal
        open={leadOpen}
        onClose={() => setLeadOpen(false)}
        title="Change assessment lead"
        maxWidth={420}
        footer={
          <Inline gap="sm" justify="end">
            <Button variant="ghost" onClick={() => setLeadOpen(false)} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void saveLead()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </Inline>
        }
      >
        <FormField label="Assessment lead">
          {({ id }) => <Input id={id} value={lead} placeholder="e.g. Dana Ko" onChange={(e) => setLead(e.target.value)} />}
        </FormField>
      </Modal>

      <ConfirmDialog
        open={resetOpen}
        onConfirm={() => void resetAssessment()}
        onCancel={() => setResetOpen(false)}
        title="Reset assessment?"
        tone="caution"
        confirmLabel={busy ? 'Resetting…' : 'Reset assessment'}
        confirmDisabled={busy}
        body={`Every dimension's score returns to unassessed and the workflow resets to step 1. Evidence and lineage are kept. This cannot be undone.`}
      />

      <ConfirmDialog
        open={deleteOpen}
        onConfirm={() => void deleteTeam()}
        onCancel={() => setDeleteOpen(false)}
        title="Delete team?"
        tone="destructive"
        confirmLabel={busy ? 'Deleting…' : 'Delete team'}
        confirmDisabled={busy}
        body={`This permanently removes ${teamName} (${teamId}) and all of its assessment data — scores, evidence, stories, and run history. This cannot be undone.`}
      />
    </>
  );
}
