// Per-sprint envelope grants — the ManageBudgets half of this page.
//
// List, add, re-size and revoke the budget_grants scoped to one sprint. Every
// write refetches both the grants and the sprint rollup above, because the
// sprint's "Envelope granted" tile is derived from exactly these rows.

import { useState } from 'react';
import {
  Button,
  FormField,
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
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess } from '../../lib/toastStore';
import { grantUrl, grantsUrl, validateGrantAmount } from './sprintForm';
import { usd } from './sprintFormat';
import { PeopleSelect, usePeopleOptions } from './PeopleSelect';
import { writeJson } from './writeJson';
import type { GrantRow, Sprint } from './types';

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
    <Inline gap="sm" align="end" className="rounded-lg border border-border p-3">
      <FormField label="Grantee" className="flex-1 basis-[180px]">
        {({ id }) => (
          <PeopleSelect
            id={id} value={grantee} onChange={setGrantee}
            groups={groups} loading={isLoading} emptyLabel="Select…"
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

  if (editing) {
    return (
      <TableRow>
        <TableTd>{grant.granteeName ?? grant.granteePersonId}</TableTd>
        <TableTd className="text-right">
          <Input size="sm" inputMode="decimal" aria-label="Envelope amount (USD)"
            className="w-28" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </TableTd>
        <TableTd>
          <Input size="sm" aria-label="Grant note" placeholder="Note (optional)"
            value={note} onChange={(e) => setNote(e.target.value)} />
        </TableTd>
        <TableTd className="text-right">
          <Inline gap="xs" justify="end">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onSave(amount, note)}>Save</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancelEdit}>Cancel</Button>
          </Inline>
        </TableTd>
      </TableRow>
    );
  }
  return (
    <TableRow>
      <TableTd className="font-semibold">{grant.granteeName ?? grant.granteePersonId}</TableTd>
      <TableTd className="text-right tabular-nums">{usd(grant.allocatedUsd)}</TableTd>
      <TableTd className="text-text-tertiary">{grant.note ?? '—'}</TableTd>
      <TableTd className="text-right">
        <Inline gap="xs" justify="end">
          <Button size="sm" variant="ghost" onClick={onEdit}>Edit</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRevoke}>Revoke</Button>
        </Inline>
      </TableTd>
    </TableRow>
  );
}

export function GrantsPanel({ sprint, onChanged }: { sprint: Sprint; onChanged: () => void }) {
  const { data, isLoading, error, refresh } = useFetch<{ grants: GrantRow[] }>(grantsUrl(sprint.id));
  const grants = data?.grants ?? [];

  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    setEditId(null);
    reload();
  }

  async function revoke(g: GrantRow) {
    setBusy(true);
    const res = await writeJson<{ ok: true }>(grantUrl(g.id), 'DELETE');
    setBusy(false);
    if (!res.ok) { toastError(null, 'Could not revoke grant', res.error ?? ''); return; }
    toastSuccess(null, 'Envelope revoked', `${g.granteeName ?? 'grantee'}'s grant removed.`);
    reload();
  }

  return (
    <Stack gap="sm">
      <Inline justify="between" align="baseline">
        <span className="text-[13px] text-text-secondary">
          Budget envelopes scoped to this sprint. Zeroing one freezes its spend without losing its history.
        </span>
        {!adding ? (
          <Button size="sm" variant="secondary" onClick={() => { setAdding(true); setFormError(null); }}>
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
          onCancel={() => { setAdding(false); setFormError(null); }}
          onDone={() => { setAdding(false); reload(); }}
        />
      ) : null}

      {error ? (
        <InlineAlert tone="error">Could not load grants: {error}</InlineAlert>
      ) : isLoading && !data ? (
        <LoadingState label="Loading grants…" />
      ) : grants.length === 0 ? (
        <InlinePlaceholder>No envelope is granted to this sprint yet.</InlinePlaceholder>
      ) : (
        <Table>
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
                onEdit={() => { setEditId(g.id); setFormError(null); }}
                onCancelEdit={() => setEditId(null)}
                onSave={(amount, note) => void saveEdit(g.id, amount, note)}
                onRevoke={() => void revoke(g)}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}
