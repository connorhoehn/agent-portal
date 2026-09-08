// N/A exceptions — `GET /teams/:id/exceptions`: every requested/approved/denied
// exception on the team, with Approve/Deny for a role holding ApproveException
// (lead-assessor/program-lead) and read-only rows for an assessor, who may
// propose an exception (see EvidenceIntake / dimension detail) but — per
// docs/assessment-tenant.md's separation of duties — never approve their own.

import { useState } from 'react';
import {
  Button,
  Chip,
  DataTable,
  EmptyState,
  Inline,
  InlineAlert,
  LoadingState,
  MetaLine,
  Modal,
  Stack,
  StatusPill,
  type StatusPillState,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { toastError, toastSuccess } from '../../../lib/toastStore';
import { fmtDate, type ExceptionStatus, type TeamException, type TeamExceptionsResponse } from '../types';

const STATUS_STATE: Record<ExceptionStatus, StatusPillState> = {
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

  async function decide(dimensionId: string, status: 'approved' | 'denied') {
    setBusyDimension(dimensionId);
    try {
      const res = await fetch(
        `/api/assessment/teams/${encodeURIComponent(teamId)}/exceptions/${encodeURIComponent(dimensionId)}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      toastSuccess(null, status === 'approved' ? 'Exception approved' : 'Exception denied');
      refresh();
    } catch (err) {
      toastError(null, 'Could not update exception', (err as Error).message);
    } finally {
      setBusyDimension(null);
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
          rowActions={canDecide ? (e) => (
            e.status === 'requested' ? (
              <Inline gap="xs">
                <Button size="sm" variant="secondary" disabled={busyDimension === e.dimension_id} onClick={() => void decide(e.dimension_id, 'approved')}>
                  Approve
                </Button>
                <Button size="sm" variant="danger" disabled={busyDimension === e.dimension_id} onClick={() => void decide(e.dimension_id, 'denied')}>
                  Deny
                </Button>
              </Inline>
            ) : null
          ) : undefined}
          columns={[
            { key: 'dimension_id', header: 'Dimension', render: (e) => dimensionTitle(e.dimension_id) },
            { key: 'source', header: 'Source', render: (e) => <Chip size="xs" tone="neutral">{e.source}</Chip> },
            { key: 'reason', header: 'Reason' },
            {
              key: 'status',
              header: 'Status',
              // The decision rides under the pill rather than in a sixth
              // column, which is what pushed the row actions past the edge.
              render: (e) => (
                <Stack gap="none">
                  <StatusPill state={STATUS_STATE[e.status]} label={e.status} size="sm" />
                  {e.status !== 'requested' && <MetaLine size="xs" items={[e.approved_by, fmtDate(e.approved_at)]} />}
                </Stack>
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}
