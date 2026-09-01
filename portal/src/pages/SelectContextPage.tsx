// Post-login workspace chooser, modelled on the AWS "select account → assume
// role" screen. Shown when the signed-in identity holds more than one
// (tenant, role) context. Picking a role sets both the account (tenant) and the
// role in one step, then enters the app. A single-context identity never sees
// this (RootRedirect sends it straight in).
//
// This page is THE tenant boundary: there is no inline tenant switching inside
// a workspace — the menu's "Switch workspace…" hard-navigates back here.
// Entering a workspace hard-navigates via enterContext, which re-mints the
// cookie for the new tenant AND scrubs the previous tenant's client caches
// (auth.tsx → clearTenantScopedCaches). Making that exit legible here is part
// of the security story: a switch is a deliberate act that leaves the current
// workspace behind, not a soft in-place toggle.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Chip } from '@connorhoehnslalom/ui-components/shared';
import { useSession, type DirectoryUser, type Tenant } from '../lib/auth';
import { toastError } from '../lib/toastStore';
import { NEWSROOM_ENABLED } from '../lib/features';
import { markContextChosen } from '../lib/contextChoice';

const TENANT_META: Record<Tenant, { label: string; blurb: string; accent: string }> = {
  orgiq: { label: 'Org', blurb: 'Organizational intelligence — people, projects, decisions', accent: 'var(--color-primary)' },
  newsroom: { label: 'Newsroom', blurb: 'Editorial desk — articles, beats, pitches', accent: 'var(--color-info, #22b8cf)' },
};

const ROLE_META: Record<string, { label: string; hint: string }> = {
  member: { label: 'Member', hint: 'Search and view the org chart' },
  sme: { label: 'SME', hint: 'Dispatch agent runs against a sprint envelope' },
  'org-leader': { label: 'Org Leader', hint: 'Leaderboards + transaction approvals' },
  'hr-admin': { label: 'HR Admin', hint: 'People ops, guardrails, identity admin' },
  admin: { label: 'Admin', hint: 'Cross-tenant operator — every role, both accounts' },
  reporter: { label: 'Reporter', hint: 'File stories and pitches' },
  editor: { label: 'Editor', hint: 'Publish + desk-lead the newsroom' },
};

function roleLabel(role: string): string { return ROLE_META[role]?.label ?? role; }
function tenantLabel(tenant: string): string { return TENANT_META[tenant as Tenant]?.label ?? tenant; }

/** Inline tenant mark — a tinted rounded badge with a per-tenant glyph. No
 *  external assets. Purely decorative, so aria-hidden. */
function TenantMark({ tenant, size = 34 }: { tenant: Tenant; size?: number }) {
  const accent = TENANT_META[tenant]?.accent ?? 'var(--color-primary)';
  const g = Math.round(size * 0.53);
  const glyph =
    tenant === 'newsroom' ? (
      // Newspaper
      <svg width={g} height={g} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3" y="5" width="15" height="14" rx="1.5" stroke={accent} strokeWidth="1.6" />
        <path d="M18 8h3v9a2 2 0 0 1-2 2H6" stroke={accent} strokeWidth="1.6" strokeLinecap="round" />
        <path d="M6 9h9M6 12h9M6 15h6" stroke={accent} strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ) : (
      // Org graph (three connected nodes)
      <svg width={g} height={g} viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="5" r="2.4" stroke={accent} strokeWidth="1.6" />
        <circle cx="5.5" cy="18" r="2.4" stroke={accent} strokeWidth="1.6" />
        <circle cx="18.5" cy="18" r="2.4" stroke={accent} strokeWidth="1.6" />
        <path d="M10.6 6.9 6.9 15.9M13.4 6.9l3.7 9M8 18h8" stroke={accent} strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  return (
    <span
      aria-hidden
      style={{
        ...styles.tenantMark, width: size, height: size, borderRadius: Math.round(size * 0.26),
        borderColor: accent, background: `color-mix(in srgb, ${accent} 12%, transparent)`,
      }}
    >
      {glyph}
    </span>
  );
}

export default function SelectContextPage() {
  const { session, enterContext, logout, ssoEnabled, signInWithSso, listUsers, login } = useSession();

  // The dev sign-in list. This page is the pre-app boundary, which makes it
  // the right — and now only — home for the user picker: the header menu
  // stopped listing people deliberately, and Identity → Users needs a role
  // most identities do not hold. Without this, signing out in dev stranded
  // you on a chooser whose Enter buttons cannot work (the cookie-less demo
  // identity has grants to render but no session to re-scope) and no way to
  // become anyone. SSO deployments never see it — the real IdP is the way in.
  const [directory, setDirectory] = useState<DirectoryUser[] | null>(null);
  useEffect(() => {
    if (ssoEnabled) return;
    let cancelled = false;
    listUsers().then((users) => { if (!cancelled) setDirectory(users); }).catch(() => setDirectory([]));
    return () => { cancelled = true; };
  }, [ssoEnabled, listUsers]);

  // Build the account → roles structure from grants, newsroom filter applied.
  const accounts = useMemo(() => {
    const grants = session?.grants ?? {};
    return (Object.keys(grants) as Tenant[])
      .filter(t => NEWSROOM_ENABLED || t !== 'newsroom')
      .filter(t => (grants[t] ?? []).length > 0)
      .map(t => ({ tenant: t, roles: [...(grants[t] ?? [])].sort() }));
  }, [session?.grants]);

  async function choose(tenant: Tenant, role: string) {
    // Mark chosen before entering, since enterContext hard-redirects into the
    // workspace (re-driving the layout from the re-minted cookie).
    markContextChosen(session?.sub ?? '');
    try {
      await enterContext(tenant, role);
    } catch (err) {
      // enterContext hard-navigates on success, so a swallowed failure has NO
      // observable outcome — a chooser full of buttons that sometimes do
      // nothing. The cookie-less fallback identity hits exactly this: the
      // permissive demo grants render every workspace, but there is no real
      // session to re-scope, so every Enter fails. Say so, and the sign-in
      // list below is the way forward.
      toastError(null, 'Could not enter that workspace', (err as Error).message);
    }
  }

  const name = session?.name ?? session?.sub ?? 'you';
  const currentTenant = session?.tenant;
  const currentRole = session?.role;

  // A demo identity should not be choosing real workspaces when a real IdP is
  // configured — offer the actual sign-in instead of the grant list.
  const demoWithRealIdp = session?.sub === 'demo-user' && ssoEnabled;

  if (demoWithRealIdp) {
    return (
      <Screen>
        <div style={styles.brand}>Org</div>
        <h1 style={styles.title}>Sign in to continue</h1>
        <p style={styles.subtitle}>
          You're on the fallback <strong>demo-user</strong> identity, but this
          deployment has enterprise sign-in configured. Sign in with your real
          identity to choose a workspace.
        </p>
        <button type="button" onClick={() => signInWithSso()} style={styles.ssoBtn}>
          Sign in with SSO
        </button>
        <button type="button" onClick={() => void logout()} style={styles.signOutLink}>
          Sign out
        </button>
      </Screen>
    );
  }

  return (
    <Screen>
      <div style={styles.brand}>Org</div>
      <h1 style={styles.title}>Choose a workspace</h1>
      <p style={styles.subtitle}>
        Signed in as <strong>{name}</strong>. Pick the account and role to enter.
      </p>

      {/* What you're switching FROM — makes the switch a deliberate act, and
          the "you leave this workspace" line is the security story made visible. */}
      {currentTenant && (
        <div style={styles.currentBanner} aria-label="Current workspace">
          <span style={styles.currentLabel}>Currently in</span>
          <TenantMark tenant={currentTenant} size={22} />
          <Chip tone="info" size="sm">
            {tenantLabel(currentTenant)} · {roleLabel(currentRole ?? '')}
          </Chip>
          <span style={styles.currentNote}>
            Entering another workspace fully leaves this one — your session is re-scoped to that tenant.
          </span>
        </div>
      )}

      <div style={styles.accounts}>
        {accounts.map(({ tenant, roles }) => (
          <section key={tenant} style={styles.account} aria-label={`${tenantLabel(tenant)} workspace`}>
            <div style={styles.accountHead}>
              <TenantMark tenant={tenant} />
              <div style={styles.accountHeadText}>
                <span style={styles.accountName}>{TENANT_META[tenant]?.label ?? tenant}</span>
                <span style={styles.accountBlurb}>{TENANT_META[tenant]?.blurb}</span>
              </div>
            </div>
            <div style={styles.roles}>
              {roles.map(role => {
                const isCurrent = currentTenant === tenant && currentRole === role;
                return (
                  <button
                    key={role}
                    type="button"
                    className="selctx-role"
                    aria-current={isCurrent ? 'true' : undefined}
                    aria-label={`Enter ${tenantLabel(tenant)} as ${roleLabel(role)}${isCurrent ? ' (current workspace)' : ''}`}
                    onClick={() => void choose(tenant, role)}
                    style={{ ...styles.roleBtn, ...(isCurrent ? styles.roleBtnCurrent : {}) }}
                  >
                    <span style={styles.roleName}>{roleLabel(role)}</span>
                    <span style={styles.roleHint}>{ROLE_META[role]?.hint ?? ''}</span>
                    {isCurrent && <Chip tone="info" size="xs" uppercase>current</Chip>}
                    <span className="selctx-arrow" style={styles.roleArrow} aria-hidden>→</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {accounts.length === 0 && (
          <div>
            <p style={styles.empty}>
              Your account holds no workspace grants. An administrator can add you
              from Identity → Users; until then there is nothing to enter.
            </p>
            <button
              type="button"
              onClick={() => void logout()}
              style={styles.emptyBtn}
            >
              Sign out and try another account
            </button>
          </div>
        )}
      </div>

      {!ssoEnabled && (directory?.length ?? 0) > 0 && (
        <section aria-label="Sign in as" style={styles.devUsers}>
          <div style={styles.devUsersHead}>Sign in as · dev</div>
          <div style={styles.devUsersList}>
            {directory!.map((u) => (
              <button
                key={u.id}
                type="button"
                className="selctx-role"
                style={styles.devUserBtn}
                onClick={() => {
                  login(u.id).catch((err: unknown) =>
                    toastError(null, `Could not sign in as ${u.displayName}`, (err as Error).message));
                }}
              >
                <span style={styles.roleName}>{u.displayName}</span>
                <span style={styles.roleHint}>
                  {u.tenants.map((t) => `${t.tenant}: ${t.roles.map(roleLabel).join(', ')}`).join(' · ')}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {accounts.length > 0 && (
        <button type="button" onClick={() => void logout()} style={styles.signOutLink}>
          Sign out
        </button>
      )}
    </Screen>
  );
}

/** Shared dark-panel shell + the scoped focus-visible/hover styles the inline
 *  style objects can't express. */
function Screen({ children }: { children: ReactNode }) {
  return (
    <div style={styles.screen}>
      <style>{FOCUS_CSS}</style>
      <div style={styles.panel}>{children}</div>
    </div>
  );
}

// Inline style objects can't carry pseudo-classes, so keyboard focus and hover
// affordances for the role buttons live here, scoped by className.
const FOCUS_CSS = `
.selctx-role:hover { background: var(--color-surface-2, rgba(255,255,255,0.04)); }
.selctx-role:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
  background: var(--color-primary-subtle, rgba(59,130,246,0.10));
}
.selctx-role:focus-visible .selctx-arrow { transform: translateX(2px); }
`;

const styles: Record<string, CSSProperties> = {
  screen: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24, background: 'var(--color-bg, #0e1116)',
  },
  panel: { width: '100%', maxWidth: 560 },
  brand: {
    fontSize: 13, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
    color: 'var(--color-primary)', marginBottom: 20,
  },
  title: { fontSize: 26, fontWeight: 700, margin: '0 0 8px', color: 'var(--color-text-primary)' },
  subtitle: { fontSize: 14, lineHeight: 1.6, color: 'var(--color-text-secondary)', margin: '0 0 16px', maxWidth: '52ch' },
  currentBanner: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 10px',
    padding: '10px 14px', marginBottom: 24, borderRadius: 10,
    border: '1px solid var(--color-border)', background: 'var(--color-surface, rgba(255,255,255,0.02))',
  },
  currentLabel: {
    fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
    color: 'var(--color-text-tertiary)',
  },
  currentNote: {
    flexBasis: '100%', fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-tertiary)',
  },
  accounts: { display: 'flex', flexDirection: 'column', gap: 16 },
  account: {
    border: '1px solid var(--color-border)', borderRadius: 12, overflow: 'hidden',
    background: 'var(--color-surface)',
  },
  accountHead: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
    borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface-2, rgba(255,255,255,0.02))',
  },
  accountHeadText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  accountName: { fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' },
  accountBlurb: { fontSize: 12, color: 'var(--color-text-tertiary)' },
  tenantMark: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, border: '1px solid',
  },
  roles: { display: 'flex', flexDirection: 'column' },
  roleBtn: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', width: '100%',
    background: 'transparent', border: 'none', borderTop: '1px solid var(--color-border)',
    cursor: 'pointer', textAlign: 'left', color: 'var(--color-text-primary)', font: 'inherit',
    transition: 'background 120ms ease',
  },
  roleBtnCurrent: { background: 'var(--color-primary-subtle, rgba(59,130,246,0.08))' },
  roleName: { fontSize: 14, fontWeight: 600, minWidth: 92 },
  roleHint: { fontSize: 12.5, color: 'var(--color-text-secondary)', flex: 1 },
  roleArrow: { color: 'var(--color-text-tertiary)', fontSize: 15, transition: 'transform 120ms ease' },
  empty: { fontSize: 14, color: 'var(--color-text-secondary)' },
  emptyBtn: {
    marginTop: 12, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    color: 'var(--color-primary)', background: 'transparent',
    border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 16px',
  },
  ssoBtn: {
    padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
    borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: '#fff',
  },
  devUsers: {
    marginTop: 28,
    width: '100%',
  },
  devUsersHead: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.6,
    textTransform: 'uppercase' as const,
    color: 'var(--color-text-tertiary)',
    marginBottom: 8,
  },
  devUsersList: {
    display: 'flex',
    flexDirection: 'column' as const,
    border: '1px solid var(--color-border)',
    borderRadius: 10,
    overflow: 'hidden',
    background: 'var(--color-surface)',
  },
  devUserBtn: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    padding: '10px 14px',
    background: 'transparent',
    border: 'none',
    borderTop: '1px solid var(--color-border)',
    textAlign: 'left' as const,
    cursor: 'pointer',
  },
  signOutLink: {
    display: 'block', marginTop: 20, padding: 0, fontSize: 13, cursor: 'pointer',
    background: 'transparent', border: 'none', color: 'var(--color-text-tertiary)',
    textDecoration: 'underline',
  },
};
