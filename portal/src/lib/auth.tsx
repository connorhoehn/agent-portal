import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clearContextChosen, markContextChosen } from './contextChoice';
import { tenantHome } from './tenantHome';
import { clearTenantScopedCaches } from './tenantCaches';
import { Button, Inline, LoadingState, MetaLine, SectionLabel, Stack } from '@connorhoehnslalom/ui-components/shared';

export type Role = 'member' | 'sme' | 'program-owner' | 'org-leader' | 'hr-admin';
export type SessionRole = Role | 'admin';
export type Tenant = 'orgiq' | 'assessment' | 'social' | 'pipelines';

/** tenant id → roles held there (from user_tenant_roles via the session cookie). */
export type Grants = Record<string, string[]>;

export interface Session {
  sub: string;
  name: string;
  role: SessionRole;
  tenant: Tenant;
  grants: Grants;
  /** What the identity may still switch to — equals `grants` for a real
   *  user; wider for the demo persona, whose session is narrowed to the one
   *  role it picked while the picker keeps offering every persona. */
  switchable: Grants;
  availableRoles: string[];
  availableTenants: Tenant[];
  masquerading: { asUser: string; actor: string } | null;
}

export interface DirectoryUser {
  id: string;
  displayName: string;
  email: string | null;
  tenants: Array<{ tenant: string; roles: string[] }>;
}

interface SessionContextValue {
  session: Session | null;
  isLoading: boolean;
  /** True when Cognito SSO is configured — the portal offers a real sign-in. */
  ssoEnabled: boolean;
  /** True when the middleware rejected the anonymous request (401 with
   * ssoRequired) — a real sign-in is required, no demo fallback. */
  ssoRequired: boolean;
  setRole: (role: string) => Promise<void>;
  /** Switch account (tenant) AND role in one step. This is the ONLY tenant
   * switch the portal exposes, and it belongs to the /select chooser — there
   * is deliberately no inline setTenant: switching workspaces goes back
   * through the chooser so the boundary stays authoritative. */
  enterContext: (tenant: Tenant, role: string, to?: string) => Promise<void>;
  login: (userId: string) => Promise<void>;
  masquerade: (userId: string) => Promise<void>;
  stopMasquerade: () => Promise<void>;
  /** Redirect to the Cognito Hosted UI, returning to the current path after. */
  signInWithSso: () => void;
  /** Clear the session; bounce through Cognito logout when SSO is on. */
  logout: () => Promise<void>;
  /** Bump the server-side session epoch so every OTHER cookie for this user is
   * invalidated (within ≤120s), while this session's cookie is re-issued and
   * survives. No navigation. Throws the server's `{ error }` on failure —
   * including a 409 while masquerading. */
  revokeOtherSessions: () => Promise<void>;
  listUsers: () => Promise<DirectoryUser[]>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);


// Fail closed. When /api/session/me is unreachable we do NOT know who the user
// is, so we grant nothing: an empty grants map, no switchable roles/tenants.
// Every RequireRole gate then falls back and every gated nav item hides,
// instead of a middleware blip silently painting the full admin surface.
// (In normal operation the server owns the demo identity: in dev, /me returns
// a permissive demo session, so this constant is only ever seen on error.)
const UNAVAILABLE_SESSION: Session = {
  sub: 'unknown',
  name: 'Session unavailable',
  role: 'member',
  tenant: 'orgiq',
  grants: {},
  switchable: {},
  availableRoles: [],
  availableTenants: ['orgiq'],
  masquerading: null,
};

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try { detail = ((await res.json()) as { error?: string }).error ?? detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
}

// Survives the round-trip to the Cognito Hosted UI (unlike a module variable),
// so a user who comes back still unauthenticated — cancelled login,
// unprovisioned account — gets a button instead of a redirect loop.
const SSO_REDIRECT_KEY = 'orgiq.ssoAutoRedirected';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // The current identity, readable from the stable ([]-dep) callbacks below
  // without making every one of them churn on each session refresh.
  const subRef = useRef<string>('');
  const [ssoRequired, setSsoRequired] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/session/me', { credentials: 'include' });
      if (res.status === 401) {
        // The middleware refused the anonymous request: a real IdP is
        // configured and the demo fallback is off. Surface the unauthenticated
        // state (session stays null → every gated surface hides) and let the
        // auto-redirect effect below route through Cognito.
        let sso = false;
        try { sso = !!((await res.json()) as { ssoRequired?: boolean }).ssoRequired; } catch { /* body optional */ }
        setSsoRequired(sso);
        setSession(null);
        return;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      const raw = (await res.json()) as Partial<Session>;
      setSsoRequired(false);
      // A real session arrived — allow a future sign-out to auto-redirect again.
      try { sessionStorage.removeItem(SSO_REDIRECT_KEY); } catch { /* private mode */ }
      // Take grants and switch lists only from the server — never inherit them
      // from a client-side default, so a malformed /me can't fabricate access.
      subRef.current = raw.sub ?? '';
      setSession({
        sub: raw.sub ?? 'unknown',
        name: raw.name ?? raw.sub ?? 'unknown',
        role: (raw.role as SessionRole) ?? 'member',
        tenant: (raw.tenant as Tenant) ?? 'orgiq',
        grants: raw.grants ?? {},
        switchable: raw.switchable ?? raw.grants ?? {},
        availableRoles: raw.availableRoles ?? [],
        availableTenants: raw.availableTenants ?? ['orgiq'],
        masquerading: raw.masquerading ?? null,
      });
    } catch {
      // Session lookup failed (middleware down, etc.). Fail closed: an identity
      // with no grants, so the UI hides gated surfaces instead of going blank
      // OR silently showing admin.
      setSession(UNAVAILABLE_SESSION);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const [ssoEnabled, setSsoEnabled] = useState(false);

  useEffect(() => {
    void refresh();
    // Ask the BFF whether enterprise SSO is configured.
    fetch('/api/auth/config', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((j: { ssoEnabled?: boolean } | null) => setSsoEnabled(!!j?.ssoEnabled))
      .catch(() => setSsoEnabled(false));
  }, [refresh]);

  const signInWithSso = useCallback(() => {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  }, []);

  // When the middleware demands a real sign-in, bounce to the Cognito screen
  // — once. The sessionStorage marker survives the redirect, so landing back
  // still unauthenticated renders the sign-in gate instead of looping.
  useEffect(() => {
    if (isLoading || !ssoRequired || !ssoEnabled) return;
    let already = false;
    try { already = sessionStorage.getItem(SSO_REDIRECT_KEY) === '1'; } catch { /* private mode */ }
    if (already) return;
    try { sessionStorage.setItem(SSO_REDIRECT_KEY, '1'); } catch { /* private mode */ }
    signInWithSso();
  }, [isLoading, ssoRequired, ssoEnabled, signInWithSso]);

  const logout = useCallback(async () => {
    let ssoLogoutUrl: string | undefined;
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      if (res.ok) ssoLogoutUrl = ((await res.json()) as { ssoLogoutUrl?: string }).ssoLogoutUrl;
    } catch { /* cookie may already be gone — still hard-redirect below */ }
    // Forget the chooser decision so the next login re-drives through /select.
    clearContextChosen();
    // Scrub tenant/user-scoped caches so a different identity signing in on this
    // (possibly shared) browser inherits none of the previous session's data.
    clearTenantScopedCaches();
    // Hard redirect: through the Cognito hosted logout when SSO is on (clears
    // the IdP session too), else to the root so the app remounts signed-out.
    window.location.href = ssoLogoutUrl ?? '/';
  }, []);

  // Identity changes go through the BFF (which re-mints the signed cookie) and
  // then HARD-REDIRECT, so the entire app remounts from the new session —
  // the AWS assume-role model. This "re-drives the layout" instead of patching
  // React state in place, which is what made switching feel flaky. A failed
  // POST (e.g. 403 on an ungranted role) throws before the redirect, so the
  // caller's error handling still shows the message.

  const setRole = useCallback(async (role: string) => {
    await post('/api/session/role', { role });
    // Reload the current page under the new role.
    window.location.assign(window.location.pathname + window.location.search);
  }, []);

  // Set the account (tenant) and role together, then enter that workspace. The
  // role must be held in the target tenant — the chooser only offers held ones.
  // (There is intentionally no standalone setTenant: the /select chooser is
  // the only tenant boundary, so inline switching can't bypass it.)
  const enterContext = useCallback(async (tenant: Tenant, role: string, to?: string) => {
    await post('/api/session/tenant', { tenant });
    await post('/api/session/role', { role });
    // Crossing the tenant boundary: drop the previous workspace's cached data
    // before the new tenant re-drives from its freshly re-minted cookie.
    clearTenantScopedCaches();
    // …and then re-mark the pick. The chooser calls markContextChosen() just
    // before calling us, but that marker lives in the sessionStorage the scrub
    // above wipes — so the call was dead, and a person who had just chosen a
    // workspace was sent straight back to the chooser by the very next home
    // resolution (`/`, or any guard fallback landing them there). Same `sub`
    // only: a different identity carries a different one, and login/logout
    // still clearContextChosen() outright.
    if (subRef.current) markContextChosen(subRef.current);
    // Switching account redirects to that tenant's front door so the whole
    // app re-drives from the freshly re-minted session cookie. The route is
    // lib/tenantHome's, not a second opinion about where people belong —
    // unless the caller names a page INSIDE that tenant (an embedded
    // "Open in Social" link, design §4.6); anything else falls back home.
    window.location.assign(to && to.startsWith(`${tenantHome(tenant).split('/').slice(0, 2).join('/')}/`) ? to : tenantHome(tenant));
  }, []);

  const login = useCallback(async (userId: string) => {
    await post('/api/session/login', { userId });
    // A different identity must make its own chooser decision.
    clearContextChosen();
    // Same threat as logout: this swaps identity outright, so the incoming user
    // must not inherit the previous one's tenant/user-scoped caches.
    clearTenantScopedCaches();
    window.location.assign('/');
  }, []);

  const masquerade = useCallback(async (userId: string) => {
    await post('/api/session/masquerade', { userId });
    // Root re-drives to the masqueraded identity's workspace (chooser is skipped
    // while masquerading).
    window.location.assign('/');
  }, []);

  const stopMasquerade = useCallback(async () => {
    await post('/api/session/masquerade/stop', {});
    window.location.assign('/');
  }, []);

  // Revoke this user's OTHER sessions. Deliberately does NOT navigate: the
  // server re-issues the current cookie, so this tab stays signed in. The POST
  // throws the server's error (e.g. 409 while masquerading) for the caller to
  // surface.
  const revokeOtherSessions = useCallback(async () => {
    await post('/api/session/revoke-others', {});
  }, []);

  const listUsers = useCallback(async (): Promise<DirectoryUser[]> => {
    const res = await fetch('/api/session/users', { credentials: 'include' });
    if (!res.ok) return [];
    return (await res.json()) as DirectoryUser[];
  }, []);

  const ctxValue = useMemo(
    () => ({ session, isLoading, ssoEnabled, ssoRequired, setRole, enterContext, login, masquerade, stopMasquerade, signInWithSso, logout, revokeOtherSessions, listUsers, refresh }),
    [session, isLoading, ssoEnabled, ssoRequired, setRole, enterContext, login, masquerade, stopMasquerade, signInWithSso, logout, revokeOtherSessions, listUsers, refresh],
  );

  // Unauthenticated + a real IdP required: replace the app with a sign-in
  // gate. This renders only after the one-shot auto-redirect above has been
  // spent (the user came back from Cognito still without a session).
  const showSsoGate = !isLoading && ssoRequired && session === null;

  return (
    <SessionContext.Provider value={ctxValue}>
      {showSsoGate ? <SsoGate ssoEnabled={ssoEnabled} onSignIn={signInWithSso} /> : children}
    </SessionContext.Provider>
  );
}

function SsoGate({ ssoEnabled, onSignIn }: { ssoEnabled: boolean; onSignIn: () => void }) {
  return (
    <Inline
      gap="none"
      justify="center"
      wrap={false}
      className="min-h-screen items-center p-6 bg-bg"
    >
      <Stack gap="none" className="max-w-[420px] text-center">
        <SectionLabel className="text-[13px] tracking-[0.14em] text-primary mb-4">Org</SectionLabel>
        <SectionLabel as="h1" className="text-[22px] font-bold text-text-primary normal-case tracking-normal mb-2">
          Sign in required
        </SectionLabel>
        <MetaLine
          tone="secondary"
          className="text-[14px] leading-relaxed mb-5"
          items={[ssoEnabled
            ? 'This deployment uses enterprise sign-in. Continue with your identity provider.'
            : 'No session and no sign-in method is available. Contact an administrator.']}
        />
        {ssoEnabled && (
          <Inline gap="none" justify="center">
            <Button variant="primary" onClick={onSignIn}>Sign in with SSO</Button>
          </Inline>
        )}
      </Stack>
    </Inline>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/**
 * Gate a whole route tree on the session's TENANT. The rail already hides
 * another tenant's entries, but hiding a door is not locking it: an orgiq SME
 * who typed /assessment/teams got the assessment shell and a page of
 * "Couldn't load" 403s — they could see the pages. This is the client half of
 * requireTenant(); the API gate stays the truth. `admin` is cross-tenant.
 */
export function RequireTenant({ tenant, children, fallback = null }: {
  tenant: Tenant;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { session, isLoading } = useSession();
  if (isLoading) return <LoadingState label="Loading session…" />;
  if (!session || (session.role !== 'admin' && session.tenant !== tenant)) return <>{fallback}</>;
  return <>{children}</>;
}

export function RequireRole({ roles, children, fallback = null }: {
  /** Role ids in any tenant (`SessionRole` names only orgiq's; `pipeline-admin` gates a pipelines route). */
  roles: ReadonlyArray<SessionRole | string>;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { session, isLoading } = useSession();
  if (isLoading) return <LoadingState label="Loading session…" />;
  // The cross-tenant 'admin' role always passes role gates.
  if (!session || (session.role !== 'admin' && !roles.includes(session.role))) return <>{fallback}</>;
  return <>{children}</>;
}
