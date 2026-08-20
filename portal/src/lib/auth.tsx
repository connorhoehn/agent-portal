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
  setRole: (role: string) => Promise<void>;
  setTenant: (tenant: Tenant) => Promise<void>;
  login: (userId: string) => Promise<void>;
  masquerade: (userId: string) => Promise<void>;
  stopMasquerade: () => Promise<void>;
  listUsers: () => Promise<DirectoryUser[]>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const FALLBACK_SESSION: Session = {
  sub: 'demo-user',
  name: 'Demo User',
  role: 'member',
  tenant: 'orgiq',
  grants: { orgiq: ['member', 'org-leader', 'hr-admin', 'admin'], newsroom: ['reporter', 'editor', 'admin'] },
  availableRoles: ['member', 'org-leader', 'hr-admin', 'admin'],
  availableTenants: ['orgiq', 'newsroom'],
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
      // Backward-compatible with pre-tenancy /me responses.
      setSession({
        ...FALLBACK_SESSION,
        ...raw,
        tenant: (raw.tenant as Tenant) ?? 'orgiq',
        name: raw.name ?? raw.sub ?? 'demo-user',
        masquerading: raw.masquerading ?? null,
      });
    } catch {
      // If session lookup fails (middleware down, etc.) treat as the default
      // member identity so the UI degrades gracefully instead of going blank.
      setSession(FALLBACK_SESSION);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setRole = useCallback(async (role: string) => {
    await post('/api/session/role', { role });
    await refresh();
  }, [refresh]);

  const setTenant = useCallback(async (tenant: Tenant) => {
    await post('/api/session/tenant', { tenant });
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
    () => ({ session, isLoading, setRole, setTenant, login, masquerade, stopMasquerade, listUsers, refresh }),
    [session, isLoading, setRole, setTenant, login, masquerade, stopMasquerade, listUsers, refresh],
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
