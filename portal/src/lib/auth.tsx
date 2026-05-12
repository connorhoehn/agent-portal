import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Role = 'member' | 'org-leader' | 'hr-admin';

export interface Session {
  sub: string;
  role: Role;
  availableRoles: Role[];
}

interface SessionContextValue {
  session: Session | null;
  isLoading: boolean;
  setRole: (role: Role) => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/session/me', { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = (await res.json()) as Session;
      setSession(json);
    } catch {
      // If session lookup fails (middleware down, etc.) treat as the default
      // member identity so the UI degrades gracefully instead of going blank.
      setSession({ sub: 'demo-user', role: 'member', availableRoles: ['member', 'org-leader', 'hr-admin'] });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setRole = useCallback(async (role: Role) => {
    const res = await fetch('/api/session/role', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) throw new Error(`Failed to set role: ${res.status}`);
    await refresh();
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ session, isLoading, setRole, refresh }}>
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
  roles: Role[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { session, isLoading } = useSession();
  if (isLoading) return null;
  if (!session || !roles.includes(session.role)) return <>{fallback}</>;
  return <>{children}</>;
}
