// Team actions — the scorecard header's Change lead / Reset assessment /
// Delete team controls (plus Create review deck, gated on RunAssessmentAgent), mirroring the source app's TeamActionsMenu. All four
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
import { sendJson } from '../../../lib/writeJson';
import { CreateDeckDialog } from '../decks/CreateDeckDialog';

interface TeamActionsMenuProps {
  teamId: string;
  teamName: string;
  currentLead: string;
  /** PATCH (lead) or POST reset-assessment succeeded — refetch the team detail. */
  onChanged: () => void;
  /** DELETE succeeded — the team is gone, navigate away from its scorecard. */
  onDeleted: () => void;
}

export function TeamActionsMenu({ teamId, teamName, currentLead, onChanged, onDeleted }: TeamActionsMenuProps) {
  const { can, ready } = useCapabilities();
  const [leadOpen, setLeadOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deckOpen, setDeckOpen] = useState(false);
  const [lead, setLead] = useState(currentLead);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (leadOpen) setLead(currentLead); }, [leadOpen, currentLead]);

  const canScore = ready && can('ScoreAssessment');
  const canDeck = ready && can('RunAssessmentAgent');
  if (!canScore && !canDeck) return null;

  async function saveLead() {
    setBusy(true);
    try {
      await sendJson(`/api/assessment/teams/${encodeURIComponent(teamId)}`, 'PATCH', { assessment_lead: lead.trim() });
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
      await sendJson(`/api/assessment/teams/${encodeURIComponent(teamId)}/reset-assessment`, 'POST');
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
      await sendJson(`/api/assessment/teams/${encodeURIComponent(teamId)}`, 'DELETE');
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
            ...(canDeck ? [{ label: 'Create review deck', onSelect: () => setDeckOpen(true) }] : []),
            ...(canScore ? [
              { label: 'Change lead', onSelect: () => setLeadOpen(true) },
              { label: 'Reset assessment', onSelect: () => setResetOpen(true) },
              { label: 'Delete team', danger: true, onSelect: () => setDeleteOpen(true) },
            ] : []),
          ],
        }]}
      />

      <CreateDeckDialog open={deckOpen} onClose={() => setDeckOpen(false)} teamId={teamId} teamName={teamName} />

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
