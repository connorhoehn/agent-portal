import { useEffect, useState } from 'react';
import { TenantSwitcher as TenantSwitcherControl } from '@connorhoehnslalom/ui-components/shared';
import { useSession, type Tenant } from '../../lib/auth';
import { tenantEnabled } from '../../lib/features';
import { useSharedNotifications } from './SharedNotifications';
import { useCallHost } from '../../lib/conversationCall';
import { useGatewayFrames } from '../../lib/gatewayFrames';
import { roleGrants } from '../../lib/capabilityGrants';

const LABELS: Record<Tenant, string> = { orgiq: 'Work', assessment: 'Assessment', social: 'Social', pipelines: 'Pipelines', access: 'Access' };

/** The shell's tenant switcher: the library draws it; this adapter supplies the
 * viewer's switchable tenants, their unread counts, live state and the switch. */
export function TenantSwitcher({ label, healthy }: { label: string; healthy: boolean }) {
  const { session, sessionStatus, enterContext } = useSession();
  const inbox = useSharedNotifications();
  const { connectionState } = useGatewayFrames();
  const host = useCallHost();
  const activeCall = !!host?.call.call?.callId || !['idle', 'ended', 'failed'].includes(host?.call.phase ?? 'idle');
  const [motion] = useState(() => { try { return localStorage.getItem('shell.ambient-motion') !== 'off'; } catch { return true; } });
  useEffect(() => {
    document.documentElement.dataset.shellMotion = motion ? 'on' : 'off';
    try { localStorage.setItem('shell.ambient-motion', motion ? 'on' : 'off'); } catch { /* optional preference */ }
  }, [motion]);
  const destinations = (Object.keys(LABELS) as Tenant[])
    .filter(t => t !== session?.tenant && tenantEnabled(t) && sessionStatus === 'ready' && (session?.switchable[t]?.length ?? 0) > 0)
    .map(tenant => ({
      id: tenant, label: LABELS[tenant], initials: LABELS[tenant].slice(0, 2),
      unread: roleGrants(session?.grants, tenant).length ? inbox.notifications.filter(n => !n.read && n.payload?.tenant === tenant).length : 0,
    }));
  return <TenantSwitcherControl label={label} healthy={healthy} motion={motion} destinations={destinations}
    onSelect={id => enterContext(id as Tenant)} live={connectionState === 'connected'}
    blockedReason={activeCall ? 'Finish your huddle before switching workspaces.' : undefined}
    emptyMessage={sessionStatus === 'loading' ? 'Loading workspaces…' : sessionStatus === 'ready' ? 'No other tenants are available for your account.' : 'Workspaces are unavailable. Check your session and try again.'}
    resetKey={`${session?.sub ?? ''}|${session?.tenant ?? ''}`} errorFallback="Could not switch workspace. Try again."
    avatarColor="var(--color-brand-soft)" avatarForeground="var(--color-brand-ink)" />;
}
