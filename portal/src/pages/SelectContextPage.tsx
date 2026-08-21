// Post-login workspace chooser, modelled on the AWS "select account → assume
// role" screen. Shown when the signed-in identity holds more than one
// (tenant, role) context. Picking a role sets both the account (tenant) and the
// role in one step, then enters the app. A single-context identity never sees
// this (RootRedirect sends it straight in).

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useSession, type Tenant } from '../lib/auth';
import { NEWSROOM_ENABLED } from '../lib/features';
import { markContextChosen } from '../lib/contextChoice';

const TENANT_META: Record<Tenant, { label: string; blurb: string }> = {
  orgiq: { label: 'OrgIQ', blurb: 'Organizational intelligence — people, projects, decisions' },
  newsroom: { label: 'Newsroom', blurb: 'Editorial desk — articles, beats, pitches' },
};

const ROLE_META: Record<string, { label: string; hint: string }> = {
  member: { label: 'Member', hint: 'Search and view the org chart' },
  'org-leader': { label: 'Org Leader', hint: 'Leaderboards + transaction approvals' },
  'hr-admin': { label: 'HR Admin', hint: 'People ops, guardrails, identity admin' },
  admin: { label: 'Admin', hint: 'Cross-tenant operator — can masquerade' },
  reporter: { label: 'Reporter', hint: 'File stories and pitches' },
  editor: { label: 'Editor', hint: 'Publish + desk-lead the newsroom' },
};

const TENANT_ROOT: Record<Tenant, string> = {
  orgiq: '/iq/work',
  newsroom: '/newsroom/home',
};

function roleLabel(role: string): string { return ROLE_META[role]?.label ?? role; }

export default function SelectContextPage() {
  const { session, enterContext } = useSession();
  const navigate = useNavigate();

  // Build the account → roles structure from grants, newest-tenant filter applied.
  const accounts = useMemo(() => {
    const grants = session?.grants ?? {};
    return (Object.keys(grants) as Tenant[])
      .filter(t => NEWSROOM_ENABLED || t !== 'newsroom')
      .filter(t => (grants[t] ?? []).length > 0)
      .map(t => ({ tenant: t, roles: [...(grants[t] ?? [])].sort() }));
  }, [session?.grants]);

  async function choose(tenant: Tenant, role: string) {
    await enterContext(tenant, role);
    markContextChosen(session?.sub ?? '');
    navigate(TENANT_ROOT[tenant] ?? '/iq/work', { replace: true });
  }

  const name = session?.name ?? session?.sub ?? 'you';

  return (
    <div style={styles.screen}>
      <div style={styles.panel}>
        <div style={styles.brand}>OrgIQ</div>
        <h1 style={styles.title}>Choose a workspace</h1>
        <p style={styles.subtitle}>Signed in as <strong>{name}</strong>. Pick the account and role to continue with — you can switch any time from the menu.</p>

        <div style={styles.accounts}>
          {accounts.map(({ tenant, roles }) => (
            <section key={tenant} style={styles.account}>
              <div style={styles.accountHead}>
                <span style={styles.accountName}>{TENANT_META[tenant]?.label ?? tenant}</span>
                <span style={styles.accountBlurb}>{TENANT_META[tenant]?.blurb}</span>
              </div>
              <div style={styles.roles}>
                {roles.map(role => {
                  const isCurrent = session?.tenant === tenant && session?.role === role;
                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() => void choose(tenant, role)}
                      style={{ ...styles.roleBtn, ...(isCurrent ? styles.roleBtnCurrent : {}) }}
                    >
                      <span style={styles.roleName}>{roleLabel(role)}</span>
                      <span style={styles.roleHint}>{ROLE_META[role]?.hint ?? ''}</span>
                      {isCurrent && <span style={styles.currentTag}>current</span>}
                      <span style={styles.roleArrow} aria-hidden>→</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {accounts.length === 0 && (
            <p style={styles.empty}>Your account holds no workspace grants. Ask an administrator to add you.</p>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
  subtitle: { fontSize: 14, lineHeight: 1.6, color: 'var(--color-text-secondary)', margin: '0 0 24px', maxWidth: '52ch' },
  accounts: { display: 'flex', flexDirection: 'column', gap: 16 },
  account: {
    border: '1px solid var(--color-border)', borderRadius: 12, overflow: 'hidden',
    background: 'var(--color-surface)',
  },
  accountHead: {
    display: 'flex', flexDirection: 'column', gap: 2, padding: '12px 16px',
    borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface-2, rgba(255,255,255,0.02))',
  },
  accountName: { fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' },
  accountBlurb: { fontSize: 12, color: 'var(--color-text-tertiary)' },
  roles: { display: 'flex', flexDirection: 'column' },
  roleBtn: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', width: '100%',
    background: 'transparent', border: 'none', borderTop: '1px solid var(--color-border)',
    cursor: 'pointer', textAlign: 'left', color: 'var(--color-text-primary)', font: 'inherit',
  },
  roleBtnCurrent: { background: 'var(--color-primary-subtle, rgba(59,130,246,0.08))' },
  roleName: { fontSize: 14, fontWeight: 600, minWidth: 92 },
  roleHint: { fontSize: 12.5, color: 'var(--color-text-secondary)', flex: 1 },
  currentTag: {
    fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: 'var(--color-primary)', border: '1px solid var(--color-primary)', borderRadius: 4, padding: '1px 6px',
  },
  roleArrow: { color: 'var(--color-text-tertiary)', fontSize: 15 },
  empty: { fontSize: 14, color: 'var(--color-text-secondary)' },
};
