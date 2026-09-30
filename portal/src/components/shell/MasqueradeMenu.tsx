import { useState, useRef } from 'react';
import {
  Button, ChoiceList, ChoiceRow, Inline, InlineAlert, InlinePopover, MetaLine, SectionLabel, Stack, StatusDot,
} from '@connorhoehnslalom/ui-components/shared';
import { useSession, type SessionRole } from '../../lib/auth';

const ROLE_LABELS: Record<string, string> = {
  member: 'Member',
  sme: 'SME',
  'program-owner': 'Program Owner',
  'org-leader': 'Org Leader',
  'hr-admin': 'HR Admin',
  admin: 'Admin',
  // The assessment tenant's roles (the same names the workspace picker's
  // ROLE_META uses); the menu showed the raw ids after the 2026-09-29 row
  // conversion (assessment journey re-audit, #12).
  assessor: 'Assessor',
  'lead-assessor': 'Lead Assessor',
  'program-lead': 'Program Lead',
  // The social and pipelines tenants' roles (the picker's ROLE_META names).
  participant: 'Participant',
  moderator: 'Moderator',
  'community-admin': 'Community Admin',
  author: 'Author',
  operator: 'Operator',
  'pipeline-admin': 'Pipeline Admin',
};

const ROLE_HINTS: Record<string, string> = {
  member: 'IC. Search + org chart.',
  sme: 'Dispatches agent runs against a sprint envelope.',
  'program-owner': 'Allocates and grants on their own initiatives; sprints, board and bots.',
  'org-leader': 'VP / Director. + leaderboards, approvals.',
  'hr-admin': 'Sees salary + perf. Edits guardrails.',
  admin: 'Cross-tenant operator. Every role, every account.',
  assessor: 'Score dimensions, manage submission intake.',
  'lead-assessor': 'Approve exceptions, publish reports.',
  'program-lead': 'Own the assessment program end to end.',
  participant: 'Post in channels and DMs, start and join calls.',
  moderator: 'Manage channels, teams and recordings.',
  'community-admin': 'Own the social workspace — configuration and users.',
  author: 'Write, version and dry-run pipeline definitions.',
  operator: 'Run pipelines, approve steps, cancel runs.',
  'pipeline-admin': 'Operator plus configuration and users.',
};

const TENANT_LABELS: Record<string, string> = { orgiq: 'Org', assessment: 'Assessment', social: 'Social', pipelines: 'Pipelines' };

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
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = () => { setOpen(false); setError(null); };

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
    <Stack gap="none" className="relative">
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

      {/* InlinePopover owns outside-click / Escape dismissal and focus
          capture-on-open + restore-on-close — the hand-rolled versions of
          all three used to live here. */}
      <InlinePopover
        trigger={triggerRef}
        open={open}
        onClose={close}
        placement="bottom-end"
        aria-label="Account menu"
        className="min-w-[280px] max-h-[480px] overflow-y-auto"
      >
        <>
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
          <ChoiceList data-testid="account-menu-roles">
            {session.availableRoles.map(role => {
              const active = role === session.role;
              return (
                <ChoiceRow
                  key={role}
                  title={roleLabel(role)}
                  description={ROLE_HINTS[role] || undefined}
                  selected={active}
                  disabled={busy}
                  onSelect={() => active ? close() : void run(() => setRole(role))}
                  data-testid={`account-menu-role-${role}`}
                />
              );
            })}
          </ChoiceList>

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
              className="border-0 justify-start text-left text-primary font-semibold"
              onClick={() => { close(); window.location.assign('/select'); }}
            >
              Switch workspace…
            </Button>
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              disabled={busy}
              className="border-0 justify-start text-left text-text-secondary"
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
        </>
      </InlinePopover>
    </Stack>
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
