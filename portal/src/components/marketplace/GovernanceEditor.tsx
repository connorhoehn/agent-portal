// GovernanceEditor — the initiative's governance affordances: who runs it
// (owner) and which contributors are reserved-role (owner / sme).
//
// Permission model: the controls render only when the session holds
// DispatchAgentRun (the capability the PATCH APIs enforce) — without it the
// owner line and role chips stay read-only. The PATCH is still optimistic and
// a 403 (e.g. authz-degraded probe was optimistic) maps to a quiet "needs
// dispatch rights" toast with a revert. A 503 means the owner column predates
// the migration; the server's error is shown as-is.
//
// The owner picker used to be a hand-rolled `<div role="listbox">` positioned
// with inline styles and closed only on outside click — Escape did nothing,
// so a keyboard user who opened it with the ✎ trigger had no way back short
// of Tab-ing past every row. It now renders on the library's `DropdownMenu`,
// which is built on `InlinePopover` and gets Escape-to-close plus
// focus-capture/restore (back to the ✎ trigger) for free — the same fix
// class as the rest of this codebase's popovers, not a one-off.

import { useState } from 'react';
import {
  Button, Chip, DropdownMenu, MetaLine, type DropdownMenuSection,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastInfo } from '../../lib/toastStore';

// ─── The reserved-role vocabulary ────────────────────────────────────────────

/** The roles the compact control cycles through: '—' → sme → owner → '—'. */
export type ReservedRole = 'owner' | 'sme' | null;

function normalizeRole(role: string | null): ReservedRole {
  const r = (role ?? '').toLowerCase();
  return r === 'owner' || r === 'sme' ? r : null;
}

function nextRole(role: string | null): ReservedRole {
  const norm = normalizeRole(role);
  if (norm === null) return 'sme';
  if (norm === 'sme') return 'owner';
  return null;
}

// ─── Shared PATCH plumbing ───────────────────────────────────────────────────

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function patchJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  const payload = await res.json().catch(() => ({})) as { error?: string };
  throw new HttpError(res.status, payload.error ?? `HTTP ${res.status}`);
}

/** 403 → quiet "needs dispatch rights"; anything else (incl. 503 pre-migration,
    404 not-a-contributor) shows the server's error. */
function surfacePatchError(err: unknown, what: string): void {
  if (err instanceof HttpError && err.status === 403) {
    toastInfo('Needs dispatch rights', `${what} requires agent-dispatch rights on this initiative.`);
    return;
  }
  toastError(null, `${what} failed`, err instanceof Error ? err.message : String(err));
}

// ─── Owner editor — the header's "Run by" affordance ─────────────────────────

export interface GovernanceContributor {
  personId: string;
  name: string;
  role: string | null;
}

export interface OwnerEditorProps {
  projectId: string;
  contributors: GovernanceContributor[];
  ownerId: string | null;
  ownerName: string | null;
  /** Optimistic apply / revert of the header's owner line. */
  onOwner: (ownerId: string | null, ownerName: string | null) => void;
  /** Optimistic apply / revert of one contributor's role chip. */
  onRole: (personId: string, role: string | null) => void;
}

export function OwnerEditor({ projectId, contributors, ownerId, ownerName, onOwner, onRole }: OwnerEditorProps) {
  const { can, ready } = useCapabilities();

  async function pick(person: GovernanceContributor | null) {
    if ((person?.personId ?? null) === ownerId) return;
    const prevOwnerId = ownerId, prevOwnerName = ownerName;
    const prevRole = person?.role ?? null;

    // Optimistic: the header flips now; the picked person also reads owner.
    onOwner(person?.personId ?? null, person?.name ?? null);
    if (person) onRole(person.personId, 'owner');

    // Fire both PATCHes; tolerate partial failure with a toast per half.
    const base = `/api/graph/projects/${encodeURIComponent(projectId)}`;
    const [ownerRes, roleRes] = await Promise.allSettled([
      patchJson(base, { ownerId: person?.personId ?? null }),
      person
        ? patchJson(`${base}/contributors/${encodeURIComponent(person.personId)}`, { role: 'owner' })
        : Promise.resolve(),
    ]);
    if (ownerRes.status === 'rejected') {
      onOwner(prevOwnerId, prevOwnerName);
      surfacePatchError(ownerRes.reason, 'Changing the initiative owner');
    }
    if (roleRes.status === 'rejected' && person) {
      onRole(person.personId, prevRole);
      surfacePatchError(roleRes.reason, "Marking the owner's contributor role");
    }
  }

  // Hide the affordance entirely without dispatch rights — the "Run by" line
  // in the header stays; only the pencil goes away.
  if (!ready || !can('DispatchAgentRun')) return null;

  const sections: DropdownMenuSection[] = [
    {
      items: contributors.length > 0
        ? contributors.map((c) => ({
            label: c.name,
            active: c.personId === ownerId,
            icon: c.personId === ownerId ? <span aria-hidden="true">✓</span> : undefined,
            onSelect: () => void pick(c),
          }))
        : [{ label: 'No contributors to pick from yet.', onSelect: () => {} }],
    },
    ...(ownerId != null
      ? [{ items: [{ label: 'Clear owner', onSelect: () => void pick(null) }] }]
      : []),
  ];

  return (
    <DropdownMenu
      trigger="✎"
      triggerLabel="Change who runs this initiative"
      triggerTitle="Change who runs this initiative"
      triggerClassName="border-none bg-transparent px-0.5 py-0 text-[11px] leading-none text-text-tertiary hover:text-primary hover:bg-transparent"
      sections={sections}
    />
  );
}

// ─── Role cycle chip — one contributor row's compact role control ────────────
// Click cycles '—' → sme → owner → '—'. Owner keeps purple, SME keeps info;
// a non-reserved role shows its raw label and cycles into sme first (so one
// stray click never clears a descriptive role).

export function RoleCycleChip({
  projectId,
  personId,
  role,
  onRole,
}: {
  projectId: string;
  personId: string;
  role: string | null;
  onRole: (personId: string, role: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { can, ready } = useCapabilities();
  const norm = normalizeRole(role);
  const next = nextRole(role);

  // Without dispatch rights the role stays informational: the same chip,
  // not a button.
  if (!ready || !can('DispatchAgentRun')) {
    return norm === 'owner' ? (
      <Chip tone="purple" size="xs">owner</Chip>
    ) : norm === 'sme' ? (
      <Chip tone="info" size="xs">sme</Chip>
    ) : (
      <MetaLine size="sm" tone="secondary" items={[role ?? '—']} />
    );
  }

  async function cycle() {
    if (busy) return;
    setBusy(true);
    const prev = role;
    onRole(personId, next);
    try {
      await patchJson(
        `/api/graph/projects/${encodeURIComponent(projectId)}/contributors/${encodeURIComponent(personId)}`,
        { role: next },
      );
    } catch (err) {
      onRole(personId, prev);
      surfacePatchError(err, 'Changing the contributor role');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={(e) => { e.stopPropagation(); void cycle(); }}
      title={`Role: ${role ?? '—'} — click to make ${next ?? '—'}`}
      className="h-auto w-auto min-w-0 border-0 bg-transparent p-0 font-normal hover:bg-transparent"
    >
      {norm === 'owner' ? (
        <Chip tone="purple" size="xs">owner</Chip>
      ) : norm === 'sme' ? (
        <Chip tone="info" size="xs">sme</Chip>
      ) : (
        <MetaLine
          size="sm"
          tone="secondary"
          className="border-b border-dashed border-border-emphasis"
          items={[role ?? '—']}
        />
      )}
    </Button>
  );
}
