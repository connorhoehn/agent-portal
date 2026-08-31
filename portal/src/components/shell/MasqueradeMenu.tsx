import { useState, useRef, useEffect } from 'react';
import { useSession, type DirectoryUser, type SessionRole } from '../../lib/auth';

const ROLE_LABELS: Record<string, string> = {
  member: 'Member',
  sme: 'SME',
  'org-leader': 'Org Leader',
  'hr-admin': 'HR Admin',
  reporter: 'Reporter',
  editor: 'Editor',
  admin: 'Admin',
};

const ROLE_HINTS: Record<string, string> = {
  member: 'IC. Search + org chart.',
  sme: 'Dispatches agent runs against a sprint envelope.',
  'org-leader': 'VP / Director. + leaderboards, approvals.',
  'hr-admin': 'Sees salary + perf. Edits guardrails.',
  reporter: 'Files stories + pitches.',
  editor: 'Publishes. Manages newsroom KB.',
  admin: 'Cross-tenant operator. Every role, both accounts.',
};

const TENANT_LABELS: Record<string, string> = { orgiq: 'Org', newsroom: 'Newsroom' };

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
function tenantLabel(t: string): string {
  return TENANT_LABELS[t] ?? t;
}

export function MasqueradeMenu() {
  const { session, setRole, login, stopMasquerade, listUsers, isLoading,
    ssoEnabled, ssoRequired, signInWithSso, logout } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<DirectoryUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Move focus into the panel when it opens so keyboard users land inside it.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // Escape closes the panel and returns focus to the trigger. Bound on the
  // wrapper so it fires wherever focus sits within the disclosure.
  const closeAndRefocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Load the user directory lazily, the first time the menu opens — and only
  // where the picker actually renders, so a real SSO deployment never fetches
  // a directory it has no control to show.
  useEffect(() => {
    if (open && !ssoRequired && users === null) {
      void listUsers().then(setUsers).catch(() => setUsers([]));
    }
  }, [open, ssoRequired, users, listUsers]);

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  if (isLoading || !session) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={menuRef}
      style={{ position: 'relative' }}
      onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); closeAndRefocus(); } }}
    >
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        disabled={busy}
        aria-haspopup="true"
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          background: session.masquerading ? 'var(--color-warning-bg, rgba(217,119,6,0.12))' : 'var(--color-surface)',
          border: `1px solid ${session.masquerading ? 'var(--color-warning)' : 'var(--color-border)'}`,
          borderRadius: 'var(--radius-md)',
          color: 'var(--color-text-primary)',
          cursor: busy ? 'wait' : 'pointer',
          fontSize: 13,
        }}
      >
        <span aria-hidden="true" style={{
          width: 8, height: 8, borderRadius: '50%',
          background: roleColor(session.role),
        }} />
        <span style={{ fontWeight: 500 }}>{session.name}</span>
        <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}>
          {tenantLabel(session.tenant)} · {roleLabel(session.role)}{session.masquerading ? ' · masquerade' : ''} <span aria-hidden="true">▾</span>
        </span>
      </button>

      {open && (
        <div ref={panelRef} tabIndex={-1} style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          right: 0,
          minWidth: 280,
          maxHeight: 480,
          overflowY: 'auto',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          padding: 6,
          zIndex: 100,
          outline: 'none',
        }}>
          {/* Current identity — always visible so "who/what am I now" is unambiguous. */}
          <div style={{ padding: '8px 10px 10px', borderBottom: '1px solid var(--color-border)', marginBottom: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{session.name}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 8 }}>{session.sub}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: roleColor(session.role) }} />
              <strong>{tenantLabel(session.tenant)}</strong>
              <span style={{ color: 'var(--color-text-tertiary)' }}>·</span>
              <span>{roleLabel(session.role)}</span>
              {session.masquerading && (
                <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--color-warning)' }}>
                  masquerading
                </span>
              )}
            </div>
          </div>

          {session.masquerading && (
            <div style={{
              margin: '2px 4px 6px',
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm, 4px)',
              background: 'var(--color-warning-bg, rgba(217,119,6,0.12))',
              border: '1px solid var(--color-warning)',
              fontSize: 12,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Viewing as {session.name}
              </div>
              <div style={{ color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                Signed in as {session.masquerading.actor}
              </div>
              <button
                onClick={() => void run(stopMasquerade)}
                disabled={busy}
                style={{
                  padding: '4px 10px',
                  fontSize: 12,
                  borderRadius: 'var(--radius-sm, 4px)',
                  border: '1px solid var(--color-warning)',
                  background: 'transparent',
                  color: 'var(--color-text-primary)',
                  cursor: busy ? 'wait' : 'pointer',
                }}
              >
                Stop masquerade
              </button>
            </div>
          )}

          {ssoEnabled && (
            <>
              <SectionLabel>Enterprise sign-in</SectionLabel>
              <div style={{ display: 'flex', gap: 8, padding: '2px 10px 10px' }}>
                <button
                  type="button"
                  onClick={() => signInWithSso()}
                  style={{
                    flex: 1, padding: '7px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                    borderRadius: 6, border: 'none', background: 'var(--color-primary)', color: '#fff',
                  }}
                >
                  Sign in with SSO
                </button>
              </div>
            </>
          )}

          {/* ROLE — within the current account only. Switching the account
              (tenant) is deliberately NOT offered here: the workspace boundary
              lives on /select, reached via "Switch workspace…" below. */}
          <SectionLabel>Role in {tenantLabel(session.tenant)}</SectionLabel>
          {session.availableRoles.map(role => {
            const active = role === session.role;
            return (
              <MenuItem
                key={role}
                active={active}
                busy={busy}
                onClick={() => active ? setOpen(false) : void run(() => setRole(role))}
                title={roleLabel(role)}
                hint={ROLE_HINTS[role] ?? ''}
                dotColor={roleColor(role)}
              />
            );
          })}

          {/* PEOPLE — the dev sign-in picker, and nothing more.

              This list used to double as "masquerade as <person>", which put a
              directory of names in front of an operator whose actual question
              is "what does this look like to an org-leader". Role is the axis
              that matters and it is already above; person-level view-as needs
              per-person data (their sprints, their grants, their inbox) that
              the models do not carry yet, so offering it here promised a
              fidelity the app cannot deliver.

              Masquerade itself is untouched server-side — the banner above
              still exits a live masquerade, and Cedar still gates the action.
              Only the entry point is gone, so it can come back deliberately.

              Gated on ssoRequired rather than ssoEnabled: with SSO on but
              AUTH_DEMO_MODE=true the picker still works and is still the way
              in. When a real sign-in is required, login() would 403 anyway. */}
          {!ssoRequired && (
            <>
              <SectionLabel>{ssoEnabled ? 'Sign in as · dev' : 'Sign in as'}</SectionLabel>
              {users === null && (
                <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Loading users…</div>
              )}
              {users?.map(u => {
                const active = u.id === session.sub;
                const tenantSummary = u.tenants
                  .map(t => `${t.tenant}: ${t.roles.map(roleLabel).join(', ')}`)
                  .join(' · ');
                return (
                  <MenuItem
                    key={u.id}
                    active={active}
                    busy={busy}
                    onClick={() => active ? setOpen(false) : void run(() => login(u.id))}
                    title={u.displayName}
                    hint={tenantSummary}
                    dotColor="var(--color-text-tertiary)"
                  />
                );
              })}
              {users !== null && users.length === 0 && (
                <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                  No users provisioned.
                </div>
              )}
            </>
          )}

          <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 6, paddingTop: 6 }}>
            {/* Hard navigation, not a router push: the chooser must re-drive
                from the server session, so it stays the authoritative tenant
                boundary rather than a client-side route. */}
            <button
              type="button"
              onClick={() => { setOpen(false); window.location.assign('/select'); }}
              style={{
                width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent',
                border: 'none', borderRadius: 'var(--radius-sm, 4px)', color: 'var(--color-primary)',
                cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
              }}
            >
              Switch workspace…
            </button>
            <button
              type="button"
              onClick={() => void run(logout)}
              disabled={busy}
              style={{
                width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent',
                border: 'none', borderRadius: 'var(--radius-sm, 4px)', color: 'var(--color-text-secondary)',
                cursor: busy ? 'wait' : 'pointer', fontSize: 12.5,
              }}
            >
              Sign out
            </button>
          </div>

          {error && (
            <div style={{
              margin: '6px 4px 2px',
              padding: '6px 10px',
              fontSize: 12,
              borderRadius: 'var(--radius-sm, 4px)',
              background: 'var(--color-danger-bg, rgba(220,38,38,0.12))',
              color: 'var(--color-danger, #dc2626)',
            }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '8px 10px 6px',
      fontSize: 10,
      color: 'var(--color-text-tertiary)',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    }}>
      {children}
    </div>
  );
}

function MenuItem({ active, busy, onClick, title, hint, dotColor }: {
  active: boolean;
  busy: boolean;
  onClick: () => void;
  title: string;
  hint: string;
  dotColor: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '8px 10px',
        background: active ? 'var(--color-surface-hover)' : 'transparent',
        border: 'none',
        borderRadius: 'var(--radius-sm, 4px)',
        color: 'var(--color-text-primary)',
        cursor: busy ? 'wait' : 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: active ? 600 : 400 }}>
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor }} />
        {title}
        {active && <span style={{ marginLeft: 'auto', color: 'var(--color-text-tertiary)', fontSize: 10 }}>active</span>}
      </span>
      {hint && (
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', paddingLeft: 14 }}>
          {hint}
        </span>
      )}
    </button>
  );
}

function roleColor(role: SessionRole | string): string {
  switch (role) {
    case 'member': return 'var(--color-text-secondary)';
    case 'org-leader': return 'var(--color-info)';
    case 'hr-admin': return 'var(--color-warning)';
    case 'reporter': return 'var(--color-text-secondary)';
    case 'editor': return 'var(--color-info)';
    case 'admin': return 'var(--color-danger)';
    default: return 'var(--color-text-tertiary)';
  }
}
