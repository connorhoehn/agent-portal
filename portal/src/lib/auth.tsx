import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Role = 'member' | 'org-leader' | 'hr-admin' | 'reporter' | 'editor';
export type SessionRole = Role | 'admin';
export type Tenant = 'orgiq' | 'newsroom';

/** tenant id → roles held there (from user_tenant_roles via the session cookie). */
export type Grants = Record<string, string[]>;

export interface Session {
  sub: string;
  name: string;
  role: SessionRole;
  tenant: Tenant;
  grants: Grants;
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
  setRole: (role: string) => Promise<void>;
  setTenant: (tenant: Tenant) => Promise<void>;
  /** Switch account (tenant) AND role in one step — used by the context chooser. */
  enterContext: (tenant: Tenant, role: string) => Promise<void>;
  login: (userId: string) => Promise<void>;
  masquerade: (userId: string) => Promise<void>;
  stopMasquerade: () => Promise<void>;
  /** Redirect to the Cognito Hosted UI, returning to the current path after. */
  signInWithSso: () => void;
  /** Clear the session; bounce through Cognito logout when SSO is on. */
  logout: () => Promise<void>;
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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/session/me', { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status}`);
      const raw = (await res.json()) as Partial<Session>;
      // Take grants and switch lists only from the server — never inherit them
      // from a client-side default, so a malformed /me can't fabricate access.
      setSession({
        sub: raw.sub ?? 'unknown',
        name: raw.name ?? raw.sub ?? 'unknown',
        role: (raw.role as SessionRole) ?? 'member',
        tenant: (raw.tenant as Tenant) ?? 'orgiq',
        grants: raw.grants ?? {},
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

  const logout = useCallback(async () => {
    let ssoLogoutUrl: string | undefined;
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      if (res.ok) ssoLogoutUrl = ((await res.json()) as { ssoLogoutUrl?: string }).ssoLogoutUrl;
    } catch { /* fall through to a local refresh */ }
    if (ssoLogoutUrl) { window.location.href = ssoLogoutUrl; return; }
    await refresh();
  }, [refresh]);

  const setRole = useCallback(async (role: string) => {
    await post('/api/session/role', { role });
    await refresh();
  }, [refresh]);

  const setTenant = useCallback(async (tenant: Tenant) => {
    await post('/api/session/tenant', { tenant });
    await refresh();
  }, [refresh]);

  // Set the account (tenant) and the role together, refreshing once. The role
  // must be held in the target tenant — the chooser only ever offers held ones.
  const enterContext = useCallback(async (tenant: Tenant, role: string) => {
    await post('/api/session/tenant', { tenant });
    await post('/api/session/role', { role });
    await refresh();
  }, [refresh]);

  const login = useCallback(async (userId: string) => {
    await post('/api/session/login', { userId });
    await refresh();
  }, [refresh]);

  const masquerade = useCallback(async (userId: string) => {
    await post('/api/session/masquerade', { userId });
    await refresh();
  }, [refresh]);

  const stopMasquerade = useCallback(async () => {
    await post('/api/session/masquerade/stop', {});
    await refresh();
  }, [refresh]);

  const listUsers = useCallback(async (): Promise<DirectoryUser[]> => {
    const res = await fetch('/api/session/users', { credentials: 'include' });
    if (!res.ok) return [];
    return (await res.json()) as DirectoryUser[];
  }, []);

  const ctxValue = useMemo(
    () => ({ session, isLoading, ssoEnabled, setRole, setTenant, enterContext, login, masquerade, stopMasquerade, signInWithSso, logout, listUsers, refresh }),
    [session, isLoading, ssoEnabled, setRole, setTenant, enterContext, login, masquerade, stopMasquerade, signInWithSso, logout, listUsers, refresh],
  );

  return (
    <SessionContext.Provider value={ctxValue}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

export function RequireRole({ roles, children, fallback = null }: {
  roles: SessionRole[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { session, isLoading } = useSession();
  if (isLoading) return null;
  // The cross-tenant 'admin' role always passes role gates.
  if (!session || (session.role !== 'admin' && !roles.includes(session.role))) return <>{fallback}</>;
  return <>{children}</>;
}
