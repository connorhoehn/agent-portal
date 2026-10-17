import '../../src/app.css';
import { StrictMode, useEffect, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { GatewayContext, type GatewayContextValue } from '@connorhoehn/realtime-modules/client';
import { Inline, Stack, SubNavLayout } from '@connorhoehnslalom/ui-components/shared';
import { SessionProvider, useSession } from '../../src/lib/auth';
import { TenantSwitcher } from '../../src/components/shell/TenantSwitcher';
import { MasqueradeMenu } from '../../src/components/shell/MasqueradeMenu';
import { SharedNotificationsProvider } from '../../src/components/shell/SharedNotifications';
import { AmbientVisitorTargets } from '../../src/components/ambient/AmbientVisitor';

const subscribers = new Set<(frame: unknown) => void>();
const gateway = { connectionState: 'disconnected', sessionEpoch: 0, rest: null,
  send: () => { throw new Error('The tenant fixture forbids gateway writes.'); },
  onMessage: (handler: (frame: unknown) => void) => { subscribers.add(handler); return () => subscribers.delete(handler); },
} as unknown as GatewayContextValue;
function emit(frame: unknown) { for (const handler of subscribers) handler(frame); }
const callListeners = new Set<() => void>();
let phase: 'idle' | 'live' | 'failed' = 'idle';
export function useCallHost() {
  const current = useSyncExternalStore(listener => { callListeners.add(listener); return () => { callListeners.delete(listener); }; }, () => phase);
  return { call: { phase: current, call: current === 'idle' ? null : { callId: 'owned-inert-call' } } };
}
function setCall(next: typeof phase) { phase = next; for (const listener of callListeners) listener(); }
function Surface() {
  const { session, refresh } = useSession();
  const surface = useRef<HTMLDivElement>(null);
  const label = ({ orgiq: 'Work', assessment: 'Assessment', social: 'Social', pipelines: 'Pipelines' } as Record<string, string>)[session?.tenant ?? 'orgiq'];
  useEffect(() => { document.documentElement.dataset.tenant = session?.tenant ?? 'orgiq'; }, [session?.tenant]);
  return <Stack ref={surface} gap="none" className="h-screen" data-tenant={session?.tenant ?? 'orgiq'}>
    <AmbientVisitorTargets scope={surface} selector={'[data-visitor-surface], [data-shell-nav] > div > aside:first-child nav > section:has(> button[aria-expanded="true"])'} />
    <Inline as="header" data-visitor-surface="header" className="shell-header px-4 border-b border-border shrink-0" align="center" justify="between">
      <TenantSwitcher label={label} healthy /> <MasqueradeMenu />
    </Inline>
    <Stack gap="none" className="flex-1 min-h-0" data-shell-nav><SubNavLayout title={label} railWidth={200} collapsed={false} storageKey="inert-tenant-fixture"
      items={[{ path: '/fixture-plan', label: 'Initiatives', group: 'Plan' }, { path: '/fixture-build', label: 'Agents', group: 'Build' }, { path: '/fixture-engage', label: 'Communication', group: 'Engage' }]}>
      <Stack gap="md" className="p-6"><h1>Tenant header fixture</h1><output data-testid="fixture-actor">{session?.sub}</output>
        <button onClick={() => emit({ type: 'notification:bulk-update', service: 'notification', payload: { notifications: [
          { id: 'inert-assessment-1', type: 'mention', title: 'Assessment mention', timestamp: '2026-10-10T12:00:00Z', read: false, payload: { tenant: 'assessment' } },
          { id: 'inert-assessment-2', type: 'mention', title: 'Assessment reply', timestamp: '2026-10-10T12:01:00Z', read: false, payload: { tenant: 'assessment' } },
          { id: 'inert-social', type: 'mention', title: 'Read Social mention', timestamp: '2026-10-10T12:02:00Z', read: true, payload: { tenant: 'social' } },
          { id: 'inert-ungranted', type: 'mention', title: 'Ungrantable tenant fixture', timestamp: '2026-10-10T12:03:00Z', read: false, payload: { tenant: 'pipelines' } },
        ] } })}>Receive inert native inbox frames</button>
        <button onClick={() => emit({ type: 'notification:read', service: 'notification', payload: { id: 'inert-assessment-1' } })}>Receive inert read acknowledgement</button>
        <button onClick={() => setCall('live')}>Show an inert live call</button><button onClick={() => setCall('failed')}>Fail inert media while call remains owned</button>
        <button onClick={() => void refresh()}>Refresh fixture session</button>
      </Stack>
    </SubNavLayout></Stack>
    <Inline as="footer" data-visitor-surface="footer" className="h-11 border-t border-border px-4" align="center">Arbitrary footer surface</Inline>
  </Stack>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><SessionProvider><GatewayContext.Provider value={gateway}><SharedNotificationsProvider><Surface /></SharedNotificationsProvider></GatewayContext.Provider></SessionProvider></BrowserRouter></StrictMode>);
