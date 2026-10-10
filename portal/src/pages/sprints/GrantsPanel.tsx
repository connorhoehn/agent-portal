// Per-sprint envelope grants — the ManageBudgets half of this page.
//
// List, add, re-size and revoke the budget_grants scoped to one sprint. Every
// write refetches both the grants and the sprint rollup above, because the
// sprint's "Envelope granted" tile is derived from exactly these rows.

import { useEffect, useReducer, useState, type KeyboardEvent } from 'react';
import {
  Button,
  Card,
  CheckIcon,
  CloseIcon,
  ConfirmDialog,
  EditIcon,
  FormField,
  IconButton,
  InlineAlert,
  InlinePlaceholder,
  Inline,
  Input,
  LoadingState,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh, T,
  TrashIcon,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { escapeNestReducer, INITIAL_ESCAPE_NEST_STATE, shouldHostHandleEscape, topEscapeLayer } from './escapeNesting';
import { grantUrl, grantsUrl, validateGrantAmount } from './sprintForm';
import { usd } from './sprintFormat';
import { PeopleSelect, usePeopleOptions } from './PeopleSelect';
import { writeJson } from '../../lib/writeJson';
import type { GrantRow, Sprint } from './types';

const EDIT_PREFIX = 'edit:';

function AddGrantForm({ sprint, onDone, onCancel, onError }: {
  sprint: Sprint; onDone: () => void; onCancel: () => void; onError: (msg: string | null) => void;
}) {
  const { groups, isLoading } = usePeopleOptions(sprint.orgProjectId);
  const [grantee, setGrantee] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!grantee) { onError('Pick who the envelope is granted to.'); return; }
    const amt = validateGrantAmount(amount);
    if (!amt.ok) { onError(amt.error); return; }
    setBusy(true); onError(null);
    const res = await writeJson<{ grant: GrantRow }>('/api/grants', 'POST', {
      initiativeId: sprint.orgProjectId,
      sprintId: sprint.id,
      granteePersonId: grantee,
      amountUsd: amt.value,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) { onError(res.error); return; }
    toastSuccess(null, 'Envelope granted', usd(amt.value));
    onDone();
  }

  return (
    <Card padding="sm">
      <Inline gap="sm" align="end">
        <FormField label="Grantee" className="flex-1 basis-[180px]">
          {({ id }) => (
            <PeopleSelect
              id={id} value={grantee} onChange={setGrantee}
              groups={groups} loading={isLoading} emptyLabel="Select…"
              // The form mounts fresh every time "+ Grant envelope" opens it
              // (conditionally rendered, not just hidden) — autoFocus lands
              // the keyboard here instead of leaving it on `<body>`, which is
              // what made the form's own Escape handler never see the key.
              autoFocus
            />
          )}
        </FormField>
        <FormField label="Amount (USD)" className="grow-0 basis-[140px]">
          {({ id }) => (
            <Input id={id} inputMode="decimal" placeholder="0.00"
              value={amount} onChange={(e) => setAmount(e.target.value)} />
          )}
        </FormField>
        <FormField label="Note" className="flex-1 basis-[180px]">
          {({ id }) => (
            <Input id={id} value={note} placeholder="Optional"
              onChange={(e) => setNote(e.target.value)} />
          )}
        </FormField>
        <Inline gap="xs" className="pb-0.5">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void submit()}>Grant</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
        </Inline>
      </Inline>
    </Card>
  );
}

function GrantRowView({ grant, editing, busy, onEdit, onSave, onCancelEdit, onRevoke }: {
  grant: GrantRow;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onSave: (amount: string, note: string) => void;
  onCancelEdit: () => void;
  onRevoke: () => void;
}) {
  const [amount, setAmount] = useState(String(grant.allocatedUsd));
  const [note, setNote] = useState(grant.note ?? '');
  const who = grant.granteeName ?? grant.granteePersonId;

  if (editing) {
    return (
      <TableRow>
        <TableTd>{grant.granteeName ?? grant.granteePersonId}</TableTd>
        <TableTd className="text-right">
          <Input size="sm" inputMode="decimal" aria-label="Envelope amount (USD)"
            className="w-28" value={amount} onChange={(e) => setAmount(e.target.value)}
            // First field of a row that just remounted into edit mode —
            // land the keyboard here instead of on `<body>`.
            autoFocus />
        </TableTd>
        <TableTd>
          <Input size="sm" aria-label="Grant note" placeholder="Note (optional)"
            value={note} onChange={(e) => setNote(e.target.value)} />
        </TableTd>
        <TableTd className="text-right">
          <Inline gap="xs" justify="end">
            <IconButton size="sm" variant="primary" icon={<CheckIcon />} disabled={busy}
              aria-label={`Save envelope for ${who}`} title="Save" onClick={() => onSave(amount, note)} />
            <IconButton size="sm" icon={<CloseIcon />} disabled={busy}
              aria-label={`Cancel editing envelope for ${who}`} title="Cancel" onClick={onCancelEdit} />
          </Inline>
        </TableTd>
      </TableRow>
    );
  }
  return (
    <TableRow>
      <TableTd >{grant.granteeName ?? grant.granteePersonId}</TableTd>
      <TableTd className="text-right tabular-nums">{usd(grant.allocatedUsd)}</TableTd>
      <TableTd className="text-text-tertiary">{grant.note ?? '—'}</TableTd>
      <TableTd className="text-right">
        <Inline gap="xs" justify="end">
          {/* Stable, re-queryable handle for closeEdit to refocus on Escape/
              Cancel — see the comment there. Button isn't forwardRef, and
              this row itself remounts (keyed on edit state) the moment
              editing starts, so a captured DOM ref would already be stale. */}
          <IconButton size="sm" icon={<EditIcon />} onClick={onEdit} data-grant-trigger={`edit:${grant.id}`}
            aria-label={`Edit envelope for ${who}`} title="Edit" />
          <IconButton size="sm" icon={<TrashIcon />} disabled={busy} onClick={onRevoke}
            aria-label={`Revoke envelope for ${who}`} title="Revoke" />
        </Inline>
      </TableTd>
    </TableRow>
  );
}

export function GrantsPanel({ sprint, onChanged }: { sprint: Sprint; onChanged: () => void }) {
  const { data, isLoading, error, refresh } = useFetch<{ grants: GrantRow[] }>(grantsUrl(sprint.id));
  const grants = data?.grants ?? [];

  // Which inline form is open, as a stack the drawer's own Escape-to-close
  // never sees while it isn't empty — see escapeNesting.ts. At most one of
  // "add" or "edit:<id>" is ever open in this panel, but the stack shape is
  // shared with SprintBoard's own nested form so both close on the same rule.
  const [nest, dispatchNest] = useReducer(escapeNestReducer, INITIAL_ESCAPE_NEST_STATE);
  const topLayer = topEscapeLayer(nest);
  const adding = topLayer === 'add';
  const editId = topLayer?.startsWith(EDIT_PREFIX) ? topLayer.slice(EDIT_PREFIX.length) : null;

  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Focus target for Escape/Cancel to return to, restored by a `useEffect`
  // rather than a `requestAnimationFrame`. Both "+ Grant envelope" and each
  // row's "Edit" are conditionally rendered (not just hidden) while their
  // form is open, and the row itself remounts (keyed on edit state) — a
  // captured DOM ref would go stale the moment its trigger unmounts — so
  // each trigger instead carries a stable, re-queryable `data-grant-trigger`
  // (see GrantRowView and the "+ Grant envelope" button below).
  //
  // This used to schedule the refocus with `requestAnimationFrame`, which
  // ties the callback to the next paint — a frame that a hidden/backgrounded
  // tab can defer or skip outright, and Escape and a Cancel click don't
  // reliably drive the same next-paint timing even in a foregrounded tab.
  // `closeAdd`/`closeEdit` now just record *which* selector should receive
  // focus (`pendingFocus`) alongside the state change that closes the form;
  // the effect below runs on React's own commit — after `adding`/`editId`
  // have flipped and the trigger button has remounted — for BOTH paths
  // identically, with no dependency on frame scheduling.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  // Revoking a grant is irreversible money — confirm before the DELETE.
  const [confirmRevoke, setConfirmRevoke] = useState<GrantRow | null>(null);

  useEffect(() => {
    if (!pendingFocus) return;
    document.querySelector<HTMLElement>(pendingFocus)?.focus();
    setPendingFocus(null);
    // Re-run once the DOM this selector targets has actually changed shape
    // (a trigger remounting), not just when the selector string is set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocus, adding, editId]);

  function openAdd() {
    setFormError(null);
    dispatchNest({ type: 'open', id: 'add' });
  }
  function closeAdd() {
    dispatchNest({ type: 'close', id: 'add' });
    setFormError(null);
    setPendingFocus('[data-grant-trigger="add"]');
  }
  function openEdit(id: string) {
    setFormError(null);
    dispatchNest({ type: 'open', id: `${EDIT_PREFIX}${id}` });
  }
  function closeEdit(id: string) {
    dispatchNest({ type: 'close', id: `${EDIT_PREFIX}${id}` });
    setPendingFocus(`[data-grant-trigger="edit:${CSS.escape(id)}"]`);
  }

  // The first Escape while a form is open cancels ONLY the form and returns
  // focus to the control that opened it — stopping the event here keeps it
  // from ever reaching the Drawer's window-level Escape-to-close listener.
  // A second Escape, with nothing left on the stack, is left alone and
  // bubbles up to close the drawer itself (which restores focus to the row).
  function handleNestedEscape(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (shouldHostHandleEscape(nest)) return;
    e.preventDefault();
    e.stopPropagation();
    const closing = topLayer;
    if (closing === 'add') closeAdd();
    else if (closing?.startsWith(EDIT_PREFIX)) closeEdit(closing.slice(EDIT_PREFIX.length));
  }

  function reload() { refresh(); onChanged(); }

  async function saveEdit(id: string, rawAmount: string, note: string) {
    // Edit allows $0 — zeroing an envelope freezes its spend without deleting
    // the row (the backend accepts amountUsd >= 0). Create still forbids $0.
    const amt = validateGrantAmount(rawAmount, { allowZero: true });
    if (!amt.ok) { setFormError(amt.error); return; }
    setBusy(true); setFormError(null);
    // Send the note alongside the amount so a mistyped note can be corrected
    // (or cleared). Trimmed empty string clears it per the PATCH contract.
    const res = await writeJson<{ grant: GrantRow }>(grantUrl(id), 'PATCH', {
      amountUsd: amt.value,
      note: note.trim(),
    });
    setBusy(false);
    if (!res.ok) { toastError(null, 'Could not update grant', res.error ?? ''); return; }
    toastSuccess(null, 'Envelope updated', usd(amt.value));
    closeEdit(id);
    reload();
  }

  async function revoke(g: GrantRow) {
    setBusy(true);
    const res = await writeJson<{ ok: true }>(grantUrl(g.id), 'DELETE');
    setBusy(false);
    setConfirmRevoke(null);
    if (!res.ok) { toastError(null, 'Could not revoke grant', res.error ?? ''); return; }
    toastSuccess(null, 'Envelope revoked', `${g.granteeName ?? 'grantee'}'s grant removed.`);
    reload();
  }

  return (
    <Stack gap="sm" onKeyDown={handleNestedEscape}>
      <Inline justify="between" align="baseline">
        <T size="sm" className="text-text-secondary" wrap>
          Budget envelopes scoped to this sprint. Zeroing one freezes its spend without losing its history.
        </T>
        {!adding ? (
          <Button size="sm" variant="secondary" onClick={openAdd} data-grant-trigger="add">
            + Grant envelope
          </Button>
        ) : null}
      </Inline>

      {formError ? (
        <InlineAlert tone="error" onDismiss={() => setFormError(null)}>{formError}</InlineAlert>
      ) : null}

      {adding ? (
        <AddGrantForm
          sprint={sprint}
          onError={setFormError}
          onCancel={closeAdd}
          onDone={() => { closeAdd(); reload(); }}
        />
      ) : null}

      {error ? (
        <InlineAlert tone="error">Could not load grants: {error}</InlineAlert>
      ) : isLoading && !data ? (
        <LoadingState label="Loading grants…" />
      ) : grants.length === 0 ? (
        <InlinePlaceholder>No envelope is granted to this sprint yet.</InlinePlaceholder>
      ) : (
        <Table size="sm">
          <TableHead>
            <TableRow>
              <TableTh>Grantee</TableTh>
              <TableTh className="text-right">Envelope</TableTh>
              <TableTh>Note</TableTh>
              <TableTh className="text-right">Actions</TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {grants.map((g) => (
              <GrantRowView
                // Keyed on the edit state too, so entering edit mode
                // remounts the row and its inputs start from the row's
                // current amount and note rather than a stale first render.
                key={`${g.id}:${editId === g.id}`}
                grant={g}
                editing={editId === g.id}
                busy={busy}
                onEdit={() => openEdit(g.id)}
                onCancelEdit={() => closeEdit(g.id)}
                onSave={(amount, note) => void saveEdit(g.id, amount, note)}
                onRevoke={() => setConfirmRevoke(g)}
              />
            ))}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={confirmRevoke != null}
        tone="destructive"
        title="Revoke grant?"
        body={confirmRevoke
          ? `${confirmRevoke.granteeName ?? confirmRevoke.granteePersonId}'s ${usd(confirmRevoke.allocatedUsd)} envelope is removed immediately. This cannot be undone.`
          : ''}
        confirmLabel={busy ? 'Revoking…' : 'Revoke grant'}
        confirmDisabled={busy}
        onConfirm={() => { if (confirmRevoke) void revoke(confirmRevoke); }}
        onCancel={() => setConfirmRevoke(null)}
      />
    </Stack>
  );
}
