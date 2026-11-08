// N/A exceptions — `GET /teams/:id/exceptions`: every requested/approved/denied
// exception on the team, with Approve/Deny for a role holding ApproveException
// (lead-assessor/program-lead) and read-only rows for an assessor, who may
// propose an exception (see EvidenceIntake / dimension detail) but — per
// docs/assessment-tenant.md's separation of duties — never approve their own.

import { useState } from 'react';
import {
  Button,
  CheckIcon,
  Chip,
  CloseIcon,
  ConfirmDialog,
  DataTable,
  EmptyState,
  IconButton,
  InlineAlert,
  LoadingState,
  Modal,
  StatusPill,
  T,
  type StatusPillState,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { toastError, toastSuccess } from '../../../lib/toastStore';
import { sendJson } from '../../../lib/writeJson';
import { fmtDate, type ExceptionStatus, type TeamException, type TeamExceptionsResponse } from '../types';

// Named apart from RunsPage.tsx's run-status table — both used to be called
// `STATUS_STATE` locally, which read as the same concept from the name alone
// even though one is an agent run and the other an N/A exception request.
const EXCEPTION_STATUS_STATE: Record<ExceptionStatus, StatusPillState> = {
  requested: 'pending',
  approved: 'success',
  denied: 'error',
};

interface ExceptionsModalProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  /** Resolves a dimension id to its title — TeamScorecard already has the
   *  team's dimension list loaded, so this reads it rather than refetching. */
  dimensionTitle: (dimensionId: string) => string;
}

export function ExceptionsModal({ open, onClose, teamId, dimensionTitle }: ExceptionsModalProps) {
  const { can } = useCapabilities();
  const canDecide = can('ApproveException');
  const { data, isLoading, error, refresh } = useFetch<TeamExceptionsResponse>(
    open ? `/api/assessment/teams/${encodeURIComponent(teamId)}/exceptions` : null,
  );
  const [busyDimension, setBusyDimension] = useState<string | null>(null);
  const [confirmDecision, setConfirmDecision] = useState<{ dimensionId: string; status: 'approved' | 'denied' } | null>(null);

  async function decide(dimensionId: string, status: 'approved' | 'denied') {
    setBusyDimension(dimensionId);
    try {
      await sendJson(
        `/api/assessment/teams/${encodeURIComponent(teamId)}/exceptions/${encodeURIComponent(dimensionId)}`,
        'PATCH',
        { status },
      );
      toastSuccess(null, status === 'approved' ? 'Exception approved' : 'Exception denied');
      refresh();
    } catch (err) {
      toastError(null, 'Could not update exception', (err as Error).message);
    } finally {
      setBusyDimension(null);
      setConfirmDecision(null);
    }
  }

  return (
    // 960 wide: at 720 the table's five columns plus the Approve/Deny row
    // actions overflowed the dialog and the buttons were clipped at its edge.
    // The library's Modal has no header close slot (unlike Drawer's built-in
    // ✕) — ConfirmDialog, the app's other Modal-based dialog, signposts
    // dismissal the same way: a labeled button in the `footer` slot, not a
    // hand-rolled header icon. A reader with no decision to make (the
    // assessor, who cannot approve/deny) previously had zero buttons in the
    // dialog at all; this footer action is always rendered, regardless of role.
    <Modal
      open={open}
      onClose={onClose}
      title="N/A exceptions"
      maxWidth={960}
      footer={<Button size="sm" variant="secondary" onClick={onClose}>Close</Button>}
    >
      {isLoading ? (
        <LoadingState label="Loading exceptions…" />
      ) : error ? (
        <InlineAlert tone="error">{error}</InlineAlert>
      ) : !data || data.exceptions.length === 0 ? (
        <EmptyState
          title="No exceptions on file"
          body="No dimension has been requested as N/A for this team."
        />
      ) : (
        <DataTable<TeamException>
          data={data.exceptions}
          keyField={(e) => `${e.dimension_id}:${e.approved_at || 'pending'}`}
          striped
          // A modal's list of one team's N/A exceptions — 10 keeps the modal
          // from growing past a comfortable dialog height.
          pageSize={10}
          rowActions={canDecide ? (e) => (
            e.status === 'requested' ? (
              <>
                <IconButton size="sm" icon={<CheckIcon />} aria-label={`Approve exception for ${dimensionTitle(e.dimension_id)}`} title="Approve" disabled={busyDimension === e.dimension_id} onClick={() => setConfirmDecision({ dimensionId: e.dimension_id, status: 'approved' })} />
                <IconButton size="sm" icon={<CloseIcon />} aria-label={`Deny exception for ${dimensionTitle(e.dimension_id)}`} title="Deny" disabled={busyDimension === e.dimension_id} onClick={() => setConfirmDecision({ dimensionId: e.dimension_id, status: 'denied' })} />
              </>
            ) : null
          ) : undefined}
          columns={[
            { key: 'dimension_id', header: 'Dimension', render: (e) => dimensionTitle(e.dimension_id) },
            { key: 'source', header: 'Source', render: (e) => <Chip size="xs" tone="neutral">{e.source}</Chip> },
            { key: 'reason', header: 'Reason', render: (e) => <T size="sm" title={e.reason}>{e.reason}</T> },
            {
              key: 'status',
              header: 'Status',
              width: '128px',
              render: (e) => <StatusPill state={EXCEPTION_STATUS_STATE[e.status]} label={e.status} size="sm" />,
            },
            {
              key: 'decided',
              header: 'Decided',
              numeric: true,
              render: (e) => (e.status !== 'requested' ? <T size="sm" title={e.approved_by ?? undefined}>{fmtDate(e.approved_at)}</T> : '—'),
            },
          ]}
        />
      )}

      <ConfirmDialog
        open={confirmDecision != null}
        tone={confirmDecision?.status === 'denied' ? 'caution' : 'info'}
        title={confirmDecision?.status === 'approved' ? 'Approve this exception?' : 'Deny this exception?'}
        body={confirmDecision
          ? `${dimensionTitle(confirmDecision.dimensionId)} is marked N/A ${confirmDecision.status === 'approved' ? 'and excluded from scoring' : 'is not excused and stays in scope for scoring'}. This decision is recorded against the team.`
          : ''}
        confirmLabel={
          confirmDecision && busyDimension === confirmDecision.dimensionId
            ? 'Saving…'
            : confirmDecision?.status === 'approved' ? 'Approve' : 'Deny'
        }
        confirmDisabled={!!confirmDecision && busyDimension === confirmDecision.dimensionId}
        onConfirm={() => { if (confirmDecision) void decide(confirmDecision.dimensionId, confirmDecision.status); }}
        onCancel={() => setConfirmDecision(null)}
      />
    </Modal>
  );
}
