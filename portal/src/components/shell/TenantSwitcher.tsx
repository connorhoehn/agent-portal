import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSession, type Tenant } from '../../lib/auth';
import { NEWSROOM_ENABLED } from '../../lib/features';

const TENANT_ROOTS: Record<Tenant, string> = {
  orgiq: '/iq/work',
  newsroom: '/newsroom/home',
};

const TENANT_LABELS: Record<Tenant, string> = {
  orgiq: 'OrgIQ',
  newsroom: 'Newsroom',
};

export function TenantSwitcher() {
  const { session, setTenant } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current: Tenant = session?.tenant ?? 'orgiq';

  // Tenants come from the session's grants — a user with no newsroom grant
  // never sees the newsroom tab. The feature flag additionally hides newsroom
  // for everyone while it's off.
  const tenants: Tenant[] = (session?.availableTenants ?? ['orgiq'])
    .filter(t => NEWSROOM_ENABLED || t !== 'newsroom');

  // If newsroom is disabled but a persisted session is still parked on it,
  // migrate back to orgiq so the nav isn't empty and the user isn't stranded.
  useEffect(() => {
    if (!NEWSROOM_ENABLED && session?.tenant === 'newsroom') {
      void setTenant('orgiq').then(() => void navigate(TENANT_ROOTS.orgiq)).catch(() => undefined);
    }
  }, [session?.tenant, setTenant, navigate]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  // A one-tenant switcher is noise — hide it entirely.
  if (tenants.length < 2) return null;

  async function handleSelect(target: Tenant) {
    if (target === current || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setTenant(target);
      void navigate(TENANT_ROOTS[target]);
    } catch (e) {
      // 403 = no grant in the target tenant. Surface it instead of switching.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {error && (
        <span role="alert" style={{ fontSize: 11, color: 'var(--color-danger, #dc2626)', whiteSpace: 'nowrap' }}>
          {error}
        </span>
      )}
      <div
        role="group"
        aria-label="Tenant"
        style={{
          display: 'inline-flex',
          border: '1px solid var(--color-border)',
          borderRadius: 4,
          overflow: 'hidden',
          height: 28,
        }}
      >
        {tenants.map((t, idx) => {
          const isActive = t === current;
          return (
            <button
              key={t}
              type="button"
              disabled={busy}
              onClick={() => void handleSelect(t)}
              aria-pressed={isActive}
              style={{
                height: '100%',
                padding: '0 12px',
                fontSize: 11.5,
                fontWeight: isActive ? 600 : 400,
                background: isActive ? 'var(--color-primary)' : 'transparent',
                color: isActive ? 'white' : 'var(--color-text-secondary)',
                border: 'none',
                borderLeft: idx > 0 ? '1px solid var(--color-border)' : 'none',
                cursor: busy ? 'not-allowed' : isActive ? 'default' : 'pointer',
                opacity: busy && !isActive ? 0.5 : 1,
                transition: 'background 0.15s, color 0.15s',
                whiteSpace: 'nowrap',
              }}
            >
              {TENANT_LABELS[t] ?? t}
            </button>
          );
        })}
      </div>
    </div>
  );
}
