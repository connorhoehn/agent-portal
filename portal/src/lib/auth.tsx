import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clearContextChosen, markContextChosen } from './contextChoice';
import { tenantHome } from './tenantHome';
import { clearTenantScopedCaches } from './tenantCaches';
import { SESSION_INVALID_EVENT } from './apiFailure';
import { realtimeTokenSource } from './realtimeToken';
import { Button, Card, Inline, LoadingState, LockIcon, MetaLine, SectionLabel, Stack, T } from '@connorhoehnslalom/ui-components/shared';

export type Role = 'member' | 'sme' | 'program-owner' | 'org-leader' | 'hr-admin';
export type SessionRole = Role | 'admin';
export type Tenant = 'orgiq' | 'assessment' | 'social' | 'pipelines';
export type SessionStatus = 'loading' | 'ready' | 'invalid' | 'signed-out' | 'unavailable';

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
  /** Portrait URL (`app_users`/linked `people.avatar_url`); null renders initials. */
  avatarUrl?: string | null;
  tenants: Array<{ tenant: string; roles: string[] }>;
}

interface SessionContextValue {
  session: Session | null;
  isLoading: boolean;
  /** Authoritative session state, including a retired signed-cookie epoch. */
  sessionStatus: SessionStatus;
  /** True when Cognito SSO is configured — the portal offers a real sign-in. */
  ssoEnabled: boolean;
  /** True when the middleware rejected the anonymous request (401 with
   * ssoRequired) — a real sign-in is required, no demo fallback. */
  ssoRequired: boolean;
  setRole: (role: string) => Promise<void>;
  /** Authoritative tenant boundary shared by the header and workspace chooser.
   * Omit role to retain the server-selected eligible role in the destination. */
  enterContext: (tenant: Tenant, role?: string, to?: string) => Promise<void>;
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
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('loading');
  // The current identity, readable from the stable ([]-dep) callbacks below
  // without making every one of them churn on each session refresh.
  const subRef = useRef<string>('');
  const [ssoRequired, setSsoRequired] = useState(false);
  const refreshGeneration = useRef(0);
  const identityChanges = useRef(0);
  const invalidSub = useRef<string | null>(null);
  const invalidRevalidation = useRef<Promise<void> | null>(null);

  // A /me request begun before an identity write cannot restore its former
  // actor after the cookie changes. Pause new reads until the write settles.
  const withIdentityChange = useCallback(async (change: () => Promise<void>) => {
    refreshGeneration.current += 1;
    identityChanges.current += 1;
    try { await change(); }
    finally {
      refreshGeneration.current += 1;
      identityChanges.current -= 1;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (identityChanges.current) return;
    const generation = ++refreshGeneration.current;
    const current = () => generation === refreshGeneration.current;
    try {
      const res = await fetch('/api/session/me', { credentials: 'include', cache: 'no-store' });
      if (res.status === 401) {
        // The middleware refused the anonymous request: a real IdP is
        // configured and the demo fallback is off. Surface the unauthenticated
        // state (session stays null → every gated surface hides) and let the
        // auto-redirect effect below route through Cognito.
        let sso = false, retired = false;
        try {
          const body = (await res.json()) as { ssoRequired?: boolean; code?: string };
          sso = !!body.ssoRequired; retired = body.code === 'SESSION_INVALID';
        } catch { /* body optional */ }
        if (!current()) return;
        if (retired) invalidSub.current ??= subRef.current || '__retired-session__';
        setSsoRequired(sso);
        setSession(null);
        subRef.current = '';
        setSessionStatus(retired || invalidSub.current ? 'invalid' : 'signed-out');
        return;
      }
      if (!res.ok) throw new Error(`${res.status}`);
      const raw = (await res.json()) as Partial<Session>;
      if (!current()) return;
      // Dev middleware may clear an aged retired cookie and offer its demo
      // fallback. That is not the invalid account signing in again. Keep the
      // explicit gate until a current real identity arrives through login.
      if (invalidSub.current && raw.sub === 'demo-user' && invalidSub.current !== 'demo-user') {
        setSession(null); setSessionStatus('invalid'); return;
      }
      invalidSub.current = null;
      invalidRevalidation.current = null;
      setSsoRequired(false);
      setSessionStatus('ready');
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
      if (!current()) return;
      // Session lookup failed (middleware down, etc.). Fail closed: an identity
      // with no grants, so the UI hides gated surfaces instead of going blank
      // OR silently showing admin.
      setSession(UNAVAILABLE_SESSION);
      subRef.current = '';
      setSessionStatus('unavailable');
    } finally {
      if (current()) setIsLoading(false);
    }
  }, []);

  const [ssoEnabled, setSsoEnabled] = useState(false);

  useEffect(() => {
    const onInvalidSession = () => {
      // A response to a request begun before an explicit identity write may
      // not retire the replacement account. Those writes hard-navigate.
      if (identityChanges.current || invalidRevalidation.current) return;
      refreshGeneration.current += 1;
      invalidSub.current ??= subRef.current || '__retired-session__';
      subRef.current = '';
      setSession(null); setSessionStatus('invalid'); setIsLoading(false);
      realtimeTokenSource.clear();
      const pending = refresh();
      invalidRevalidation.current = pending;
      void pending.finally(() => { if (invalidRevalidation.current === pending) invalidRevalidation.current = null; });
    };
    window.addEventListener(SESSION_INVALID_EVENT, onInvalidSession);
    void refresh();
    // Ask the BFF whether enterprise SSO is configured.
    fetch('/api/auth/config', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then((j: { ssoEnabled?: boolean } | null) => setSsoEnabled(!!j?.ssoEnabled))
      .catch(() => setSsoEnabled(false));
    return () => { refreshGeneration.current += 1; window.removeEventListener(SESSION_INVALID_EVENT, onInvalidSession); };
  }, [refresh]);

  const signInWithSso = useCallback(() => {
    refreshGeneration.current += 1;
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

  const logout = useCallback(() => withIdentityChange(async () => {
    let ssoLogoutUrl: string | undefined;
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      if (res.ok) ssoLogoutUrl = ((await res.json()) as { ssoLogoutUrl?: string }).ssoLogoutUrl;
    } catch { /* cookie may already be gone — still hard-redirect below */ }
    // Forget the chooser decision so the next login re-drives through /workspaces.
    clearContextChosen();
    // Scrub tenant/user-scoped caches so a different identity signing in on this
    // (possibly shared) browser inherits none of the previous session's data.
    clearTenantScopedCaches();
    // Hard redirect: through the Cognito hosted logout when SSO is on (clears
    // the IdP session too), else to the root so the app remounts signed-out.
    window.location.href = ssoLogoutUrl ?? '/';
  }), [withIdentityChange]);

  // Identity changes go through the BFF (which re-mints the signed cookie) and
  // then HARD-REDIRECT, so the entire app remounts from the new session —
  // the AWS assume-role model. This "re-drives the layout" instead of patching
  // React state in place, which is what made switching feel flaky. A failed
  // POST (e.g. 403 on an ungranted role) throws before the redirect, so the
  // caller's error handling still shows the message.

  const setRole = useCallback((role: string) => withIdentityChange(async () => {
    await post('/api/session/role', { role });
    // Reload the current page under the new role.
    window.location.assign(window.location.pathname + window.location.search);
  }), [withIdentityChange]);

  // Both switchers use the same server-checked boundary and cache reset.
  // A tenant-only selection keeps the eligible role chosen by the server;
  // the full workspace chooser can additionally select an explicitly held role.
  const enterContext = useCallback(async (tenant: Tenant, role?: string, to?: string) => {
    let tenantChanged = false;
    const actor = subRef.current;
    try {
      await withIdentityChange(async () => {
        await post('/api/session/tenant', { tenant });
        tenantChanged = true;
        if (role) await post('/api/session/role', { role });
        // Crossing the tenant boundary: drop the previous workspace's cached
        // data before re-driving from its freshly re-minted cookie.
        clearTenantScopedCaches();
        if (actor) markContextChosen(actor);
        // The shared tenant home owns the destination; explicit deep links
        // must stay inside that tenant's route family.
        window.location.assign(to && to.startsWith(`${tenantHome(tenant).split('/').slice(0, 2).join('/')}/`) ? to : tenantHome(tenant));
      });
    } catch (error) {
      if (tenantChanged) {
        // The first POST already replaced the cookie. A refused role must not
        // leave the old tenant's session or cached data painted underneath it.
        // Refresh only after the identity-write fence has settled; /me owns
        // the resulting tenant/role, and its normal failure path denies access.
        clearTenantScopedCaches();
        if (actor) markContextChosen(actor);
        subRef.current = '';
        setSession(null); setSessionStatus('loading'); setIsLoading(true);
        await refresh();
      }
      // A refreshed fallback role is not success for the requested role.
      throw error;
    }
  }, [withIdentityChange, refresh]);

  const login = useCallback((userId: string) => withIdentityChange(async () => {
    await post('/api/session/login', { userId });
    // A different identity must make its own chooser decision.
    clearContextChosen();
    // Same threat as logout: this swaps identity outright, so the incoming user
    // must not inherit the previous one's tenant/user-scoped caches.
    clearTenantScopedCaches();
    window.location.assign('/');
  }), [withIdentityChange]);

  const masquerade = useCallback((userId: string) => withIdentityChange(async () => {
    await post('/api/session/masquerade', { userId });
    // Root re-drives to the masqueraded identity's workspace (chooser is skipped
    // while masquerading).
    window.location.assign('/');
  }), [withIdentityChange]);

  const stopMasquerade = useCallback(() => withIdentityChange(async () => {
    await post('/api/session/masquerade/stop', {});
    window.location.assign('/');
  }), [withIdentityChange]);

  // Revoke this user's OTHER sessions. Deliberately does NOT navigate: the
  // server re-issues the current cookie, so this tab stays signed in. The POST
  // throws the server's error (e.g. 409 while masquerading) for the caller to
  // surface.
  const revokeOtherSessions = useCallback(async () => {
    await withIdentityChange(() => post('/api/session/revoke-others', {}));
  }, [withIdentityChange]);

  const listUsers = useCallback(async (): Promise<DirectoryUser[]> => {
    const res = await fetch('/api/session/users', { credentials: 'include' });
    if (!res.ok) return [];
    return (await res.json()) as DirectoryUser[];
  }, []);

  const ctxValue = useMemo(
    () => ({ session, isLoading, sessionStatus, ssoEnabled, ssoRequired, setRole, enterContext, login, masquerade, stopMasquerade, signInWithSso, logout, revokeOtherSessions, listUsers, refresh }),
    [session, isLoading, sessionStatus, ssoEnabled, ssoRequired, setRole, enterContext, login, masquerade, stopMasquerade, signInWithSso, logout, revokeOtherSessions, listUsers, refresh],
  );

  // Unauthenticated + a real IdP required: replace the app with a sign-in
  // gate. This renders only after the one-shot auto-redirect above has been
  // spent (the user came back from Cognito still without a session).
  const showSsoGate = !isLoading && ssoRequired && session === null;
  // Replace the private route tree before a RequireTenant fallback can
  // redirect a retired account to Home. The chooser remains the dev login
  // door; arriving there is an explicit action, never an automatic demotion.
  const showRecoveryGate = !isLoading && sessionStatus === 'invalid' && window.location.pathname !== '/workspaces';

  return (
    <SessionContext.Provider value={ctxValue}>
      {showSsoGate ? <SsoGate ssoEnabled={ssoEnabled} onSignIn={signInWithSso} /> : showRecoveryGate
        ? <SessionRecoveryGate onRetry={refresh} onSignIn={ssoEnabled ? signInWithSso : () => window.location.assign('/workspaces')} />
        : children}
    </SessionContext.Provider>
  );
}

function SessionRecoveryGate({ onRetry, onSignIn }: { onRetry: () => Promise<void>; onSignIn: () => void }) {
  const [busy, setBusy] = useState(false);
  return <Inline justify="center" className="min-h-screen items-center bg-bg p-6" data-testid="session-recovery-gate">
    <Card padding="lg" className="w-full max-w-[440px]" role="status" aria-live="polite">
      <Stack gap="md">
        <Inline gap="sm" align="center"><LockIcon size={18} /><T size="sm" weight="semibold">Workspace access</T></Inline>
        <Stack gap="xs">
          <h1><T as="span" size="lg" weight="semibold">Sign in again</T></h1>
          <T size="sm" tone="secondary" wrap>Your session is no longer current. Sign in to return to your workspace.</T>
        </Stack>
        <Inline gap="sm">
          <Button size="sm" variant="primary" disabled={busy} onClick={onSignIn}>Sign in</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => {
            setBusy(true); void onRetry().finally(() => setBusy(false));
          }}>{busy ? 'Checking…' : 'Try again'}</Button>
        </Inline>
      </Stack>
    </Card>
  </Inline>;
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
        <SectionLabel className="text-[13px] tracking-[0.14em] text-primary mb-4">Work</SectionLabel>
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
