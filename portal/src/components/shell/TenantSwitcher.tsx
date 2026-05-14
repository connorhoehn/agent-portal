import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSession, type Tenant } from '../../lib/auth';

const TENANT_ROOTS: Record<Tenant, string> = {
  orgiq: '/iq/agents',
  newsroom: '/newsroom/home',
};

const TENANT_LABELS: Record<Tenant, string> = {
  orgiq: 'OrgIQ',
  newsroom: 'Newsroom',
};

const TENANTS: Tenant[] = ['orgiq', 'newsroom'];

export function TenantSwitcher() {
  const { session, setTenant } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const current: Tenant = session?.tenant ?? 'orgiq';

  async function handleSelect(target: Tenant) {
    if (target === current || busy) return;
    setBusy(true);
    try {
      await setTenant(target);
      void navigate(TENANT_ROOTS[target]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        border: '1px solid var(--color-border)',
        borderRadius: 4,
        overflow: 'hidden',
        height: 28,
      }}
    >
      {TENANTS.map((t, idx) => {
        const isActive = t === current;
        return (
          <button
            key={t}
            disabled={busy}
            onClick={() => void handleSelect(t)}
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
            {TENANT_LABELS[t]}
          </button>
        );
      })}
    </div>
  );
}
