// GovernanceEditor — the initiative's governance affordances: who runs it
// (owner) and which contributors are reserved-role (owner / sme).
//
// Permission model is attempt-and-surface: the controls always render, the
// PATCH is optimistic, and a 403 maps to a quiet "needs dispatch rights"
// toast with a revert — no capability probe up front. A 503 means the owner
// column predates the migration; the server's error is shown as-is.

import { useState } from 'react';
import { Chip } from '@connorhoehnslalom/ui-components/shared';
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
  const [open, setOpen] = useState(false);

  async function pick(person: GovernanceContributor | null) {
    setOpen(false);
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

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Change who runs this initiative"
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 2px',
          fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1,
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-primary)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)'; }}
      >
        ✎
      </button>
      {open && (
        <div
          role="listbox"
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 30,
            minWidth: 200, maxHeight: 240, overflowY: 'auto', padding: 4,
            background: 'var(--color-surface)', border: '1.5px solid var(--color-border)',
            borderRadius: 8, boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
          }}
        >
          {contributors.length === 0 && (
            <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
              No contributors to pick from yet.
            </div>
          )}
          {contributors.map((c) => (
            <button
              key={c.personId}
              type="button"
              role="option"
              aria-selected={c.personId === ownerId}
              onClick={() => void pick(c)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                padding: '5px 10px', border: 'none', borderRadius: 5, cursor: 'pointer',
                background: 'transparent', fontSize: 12.5,
                color: c.personId === ownerId ? 'var(--color-primary)' : 'var(--color-text-primary)',
                fontWeight: c.personId === ownerId ? 700 : 500,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-inset)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span style={{ flex: 1 }}>{c.name}</span>
              {c.personId === ownerId && <span aria-hidden="true">✓</span>}
            </button>
          ))}
          {ownerId != null && (
            <>
              <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 0' }} />
              <button
                type="button"
                onClick={() => void pick(null)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '5px 10px',
                  border: 'none', borderRadius: 5, cursor: 'pointer', background: 'transparent',
                  fontSize: 12, color: 'var(--color-text-secondary)',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-inset)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                Clear owner
              </button>
            </>
          )}
        </div>
      )}
    </span>
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
  const norm = normalizeRole(role);
  const next = nextRole(role);

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
    <button
      type="button"
      disabled={busy}
      onClick={(e) => { e.stopPropagation(); void cycle(); }}
      title={`Role: ${role ?? '—'} — click to make ${next ?? '—'}`}
      style={{
        border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
        opacity: busy ? 0.5 : 1, font: 'inherit',
      }}
    >
      {norm === 'owner' ? (
        <Chip tone="purple" size="xs">owner</Chip>
      ) : norm === 'sme' ? (
        <Chip tone="info" size="xs">sme</Chip>
      ) : (
        <span style={{
          fontSize: 13, color: 'var(--color-text-secondary)',
          borderBottom: '1px dashed var(--color-border-emphasis)',
        }}>
          {role ?? '—'}
        </span>
      )}
    </button>
  );
}
