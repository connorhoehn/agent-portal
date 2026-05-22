import { useState, useRef, useEffect } from 'react';
import { useSession, type Role, type SessionRole } from '../../lib/auth';

const ROLE_LABELS: Record<SessionRole, string> = {
  member: 'Member',
  'org-leader': 'Org Leader',
  'hr-admin': 'HR Admin',
  admin: 'Admin',
};

const ROLE_HINTS: Record<Role, string> = {
  member: 'IC. Search + org chart.',
  'org-leader': 'VP / Director. + leaderboards.',
  'hr-admin': 'Sees salary + perf. Edits guardrails.',
};

export function MasqueradeMenu() {
  const { session, setRole, isLoading } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Reset focus index when menu closes
  useEffect(() => {
    if (!open) setFocusIndex(-1);
  }, [open]);

  if (isLoading || !session) return null;

  const switchTo = async (role: Role) => {
    if (role === session.role) { setOpen(false); return; }
    setBusy(true);
    try {
      await setRole(role);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  function handleMenuKeyDown(e: React.KeyboardEvent) {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    if (!items.length) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusIndex(i => {
          const next = Math.min(i + 1, items.length - 1);
          items[next]?.focus();
          return next;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusIndex(i => {
          const prev = Math.max(i - 1, 0);
          items[prev]?.focus();
          return prev;
        });
        break;
      case 'Home':
        e.preventDefault();
        items[0]?.focus();
        setFocusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1]?.focus();
        setFocusIndex(items.length - 1);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
    }
  }

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
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
        <span style={{ fontWeight: 500 }}>{ROLE_LABELS[session.role]}</span>
        <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}>
          masquerade <span aria-hidden="true">▾</span>
        </span>
      </button>

      {open && (
        <div role="menu" style={{
          position: 'absolute',
          top: 'calc(100% + 6px)',
          right: 0,
          minWidth: 240,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          padding: 6,
          zIndex: 100,
        }}>
          <div style={{
            padding: '6px 10px 8px',
            fontSize: 10,
            color: 'var(--color-text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
          }}>
            Switch role · {session.sub}
          </div>
          {session.availableRoles.map((role, i) => {
            const active = role === session.role;
            return (
              <button
                key={role}
                ref={el => { itemRefs.current[i] = el; }}
                onClick={() => void switchTo(role)}
                onKeyDown={handleMenuKeyDown}
                disabled={busy}
                role="menuitem"
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
                  <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: roleColor(role) }} />
                  {ROLE_LABELS[role]}
                  {active && <span style={{ marginLeft: 'auto', color: 'var(--color-text-tertiary)', fontSize: 10 }}>active</span>}
                </span>
                <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', paddingLeft: 14 }}>
                  {ROLE_HINTS[role]}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function roleColor(role: SessionRole): string {
  switch (role) {
    case 'member': return 'var(--color-text-secondary)';
    case 'org-leader': return 'var(--color-info)';
    case 'hr-admin': return 'var(--color-warning)';
    case 'admin': return 'var(--color-danger)';
  }
}
