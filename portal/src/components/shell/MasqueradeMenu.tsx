import { useState, useRef, useEffect } from 'react';
import {
  Button, Card, Inline, InlineAlert, MetaLine, SectionLabel, Stack, StatusDot,
} from '@connorhoehnslalom/ui-components/shared';
import { useSession, type SessionRole } from '../../lib/auth';

const ROLE_LABELS: Record<string, string> = {
  member: 'Member',
  sme: 'SME',
  'org-leader': 'Org Leader',
  'hr-admin': 'HR Admin',
  admin: 'Admin',
};

const ROLE_HINTS: Record<string, string> = {
  member: 'IC. Search + org chart.',
  sme: 'Dispatches agent runs against a sprint envelope.',
  'org-leader': 'VP / Director. + leaderboards, approvals.',
  'hr-admin': 'Sees salary + perf. Edits guardrails.',
  admin: 'Cross-tenant operator. Every role, both accounts.',
};

const TENANT_LABELS: Record<string, string> = { orgiq: 'Org', assessment: 'Assessment' };

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}
function tenantLabel(t: string): string {
  return TENANT_LABELS[t] ?? t;
}

export function MasqueradeMenu() {
  const { session, setRole, stopMasquerade, isLoading,
    ssoEnabled, signInWithSso, logout } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
    <Stack
      gap="none"
      ref={menuRef}
      className="relative"
      onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); closeAndRefocus(); } }}
    >
      {/* Button takes a ref as of 2.242.0 — this trigger stayed a raw
          <button> until then, because Escape must return focus to it. */}
      <Button
        ref={triggerRef}
        variant="secondary"
        size="sm"
        onClick={() => setOpen(o => !o)}
        disabled={busy}
        aria-haspopup="true"
        aria-expanded={open}
        className={session.masquerading ? 'bg-warning-bg border-warning' : undefined}
      >
        {/* One line: the dot, the name, the role, the caret. The tenant, the
            subject and the masquerade state live in the panel below — the
            trigger used to stack them as three rows in a 100px-wide button. */}
        <Inline as="span" gap="xs" align="center" wrap={false} className="whitespace-nowrap">
          <StatusDot aria-hidden color={roleColor(session.role)} size="sm" />
          <Inline as="span" gap="none" className="font-medium">{session.name}</Inline>
          <Inline as="span" gap="none" className="text-text-tertiary text-[11px]">
            · {roleLabel(session.role)}{session.masquerading ? ' · masquerade' : ''} <span aria-hidden="true">▾</span>
          </Inline>
        </Inline>
      </Button>

      {open && (
        <Card
          ref={panelRef}
          tabIndex={-1}
          padding="none"
          className="absolute top-[calc(100%+6px)] right-0 min-w-[280px] max-h-[480px] overflow-y-auto shadow-[0_8px_24px_rgba(0,0,0,0.3)] p-1.5 z-[100] outline-none"
        >
          {/* Current identity — always visible so "who/what am I now" is unambiguous. */}
          <Stack gap="none" className="px-2.5 pt-2 pb-2.5 border-b border-border mb-1">
            <Inline as="div" gap="none" className="text-[13px] font-semibold">{session.name}</Inline>
            <MetaLine size="xs" className="mb-2" items={[session.sub]} />
            <Inline gap="xs" wrap={false} className="text-[12px]">
              <StatusDot aria-hidden color={roleColor(session.role)} size="xs" />
              <strong>{tenantLabel(session.tenant)}</strong>
              <Inline as="span" gap="none" className="text-text-tertiary">·</Inline>
              <Inline as="span" gap="none">{roleLabel(session.role)}</Inline>
              {session.masquerading && (
                <SectionLabel className="ml-auto text-warning">masquerading</SectionLabel>
              )}
            </Inline>
          </Stack>

          {session.masquerading && (
            <Stack gap="none" className="mx-1 mt-0.5 mb-1.5">
              <InlineAlert tone="warning">
                <Inline as="div" gap="none" className="font-semibold mb-1">
                  Viewing as {session.name}
                </Inline>
                <Inline as="div" gap="none" className="text-text-secondary mb-1.5">
                  Signed in as {session.masquerading.actor}
                </Inline>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(stopMasquerade)}>
                  Stop masquerade
                </Button>
              </InlineAlert>
            </Stack>
          )}

          {ssoEnabled && (
            <>
              <SectionLabel className="px-2.5 pt-2 pb-1.5">Enterprise sign-in</SectionLabel>
              <Inline gap="sm" wrap={false} className="px-2.5 pt-0.5 pb-2.5">
                <Button variant="primary" size="sm" fullWidth onClick={() => signInWithSso()}>
                  Sign in with SSO
                </Button>
              </Inline>
            </>
          )}

          {/* ROLE — within the current account only. Switching the account
              (tenant) is deliberately NOT offered here: the workspace boundary
              lives on /select, reached via "Switch workspace…" below. */}
          <SectionLabel className="px-2.5 pt-2 pb-1.5">Role in {tenantLabel(session.tenant)}</SectionLabel>
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

          {/* People do not appear here.

              The menu used to end in a directory of every provisioned user —
              first as "Masquerade as", then as the dev sign-in picker. Both
              put a list of names in front of an operator whose actual question
              is "what does this look like to an org-leader", which the role
              list above already answers. Person-level view-as also needs
              per-person sprints, grants and inbox to mean anything, and the
              models do not carry that yet.

              Signing in as another user still exists, in the place that
              already administers users: Identity → Users, where each row has a
              dev-only "Sign in as". Masquerade is untouched server-side — the
              banner above still exits a live one. */}

          <Stack gap="none" className="border-t border-border mt-1.5 pt-1.5">
            {/* Hard navigation, not a router push: the chooser must re-drive
                from the server session, so it stays the authoritative tenant
                boundary rather than a client-side route. */}
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              className="justify-start text-left text-primary font-semibold"
              onClick={() => { setOpen(false); window.location.assign('/select'); }}
            >
              Switch workspace…
            </Button>
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              disabled={busy}
              className="justify-start text-left text-text-secondary"
              onClick={() => void run(logout)}
            >
              Sign out
            </Button>
          </Stack>

          {error && (
            <Stack gap="none" className="mx-1 mt-1.5 mb-0.5">
              <InlineAlert tone="error">{error}</InlineAlert>
            </Stack>
          )}
        </Card>
      )}
    </Stack>
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
    // A ghost Button laid out as a stacked row. `dotColor` is the one runtime
    // value — a per-role colour Tailwind cannot build a class from — and it
    // rides on StatusDot, which owns the dot shape.
    <Button
      variant="ghost"
      size="sm"
      fullWidth
      disabled={busy}
      onClick={onClick}
      className={[
        'flex-col items-start gap-0.5 justify-start text-left px-2.5 py-2',
        active ? 'bg-surface-hover' : '',
      ].join(' ')}
    >
      <Inline as="span" gap="xs" wrap={false} className={`text-[13px] w-full ${active ? 'font-semibold' : 'font-normal'}`}>
        <StatusDot aria-hidden color={dotColor} size="xs" />
        {title}
        {active && (
          <Inline as="span" gap="none" className="ml-auto text-text-tertiary text-[10px]">active</Inline>
        )}
      </Inline>
      {hint && (
        <Inline as="span" gap="none" className="text-[11px] text-text-secondary pl-3.5">
          {hint}
        </Inline>
      )}
    </Button>
  );
}

function roleColor(role: SessionRole | string): string {
  switch (role) {
    case 'member': return 'var(--color-text-secondary)';
    case 'org-leader': return 'var(--color-info)';
    case 'hr-admin': return 'var(--color-warning)';
    case 'admin': return 'var(--color-danger)';
    default: return 'var(--color-text-tertiary)';
  }
}
