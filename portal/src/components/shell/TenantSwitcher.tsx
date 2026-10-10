import { useEffect, useId, useRef, useState } from 'react';
import { ActivityIcon, Avatar, Button, InfoIcon, Inline, InlineAlert, Stack, T, Tooltip } from '@connorhoehnslalom/ui-components/shared';
import { useSession, type Tenant } from '../../lib/auth';
import { tenantEnabled } from '../../lib/features';
import { useSharedNotifications } from './SharedNotifications';
import { useCallHost } from '../../lib/conversationCall';
import { useGatewayFrames } from '../../lib/gatewayFrames';
import './tenantSwitcher.css';
const LABELS: Record<Tenant, string> = { orgiq: 'Work', assessment: 'Assessment', social: 'Social', pipelines: 'Pipelines' };
export function TenantSwitcher({ label, healthy }: { label: string; healthy: boolean }) {
  const { session, sessionStatus, enterContext } = useSession();
  const inbox = useSharedNotifications();
  const { connectionState } = useGatewayFrames();
  const host = useCallHost();
  const activeCall = !!host?.call.call?.callId || !['idle', 'ended', 'failed'].includes(host?.call.phase ?? 'idle');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [motion] = useState(() => { try { return localStorage.getItem('shell.ambient-motion') !== 'off'; } catch { return true; } });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const close = () => { clearTimeout(timer.current); setOpen(false); setError(''); };
  useEffect(() => {
    document.documentElement.dataset.shellMotion = motion ? 'on' : 'off';
    try { localStorage.setItem('shell.ambient-motion', motion ? 'on' : 'off'); } catch { /* optional preference */ }
  }, [motion]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { close(); }, [session?.sub, session?.tenant]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { const restore = root.current?.contains(document.activeElement); close(); if (restore) trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const destinations = (Object.keys(LABELS) as Tenant[]).filter(t => t !== session?.tenant && tenantEnabled(t)
    && sessionStatus === 'ready' && (session?.switchable[t]?.length ?? 0) > 0);
  const switchTo = async (tenant: Tenant) => {
    if (busy || activeCall) return;
    setBusy(true); setError('');
    try { await enterContext(tenant); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not switch workspace. Try again.'); setBusy(false); }
  };
  return <div ref={root} className="tenant-switcher"
    onPointerEnter={e => { if (e.pointerType === 'mouse') { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 250); } }}
    onPointerLeave={() => { clearTimeout(timer.current); if (!root.current?.contains(document.activeElement)) timer.current = setTimeout(close, 300); }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) close(); }}
    onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); trigger.current?.focus(); }
      if (e.key === 'ArrowDown' && e.target === trigger.current) { e.preventDefault(); setOpen(true); requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[role="dialog"] button')?.focus()); } }}>
    <button ref={trigger} type="button" className="tenant-switcher-trigger" aria-label={`${label}: switch tenant`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { clearTimeout(timer.current); setOpen(true); }}>
      <span className="tenant-brand-planet" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25"><circle cx="12" cy="12" r="6.5" /><ellipse cx="12" cy="12" rx="11" ry="3.5" transform="rotate(-22 12 12)" /></svg>
        {healthy && <span className="tenant-brand-orbit" aria-hidden="true"><span /></span>}
      </span><span className="tenant-brand-label">{label}</span>
    </button>
    {open && <div id={id} role="dialog" aria-label="Switch tenant" className="tenant-switcher-panel"><Stack gap="sm">
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {activeCall && <p className="text-xs text-text-secondary">Finish your huddle before switching workspaces.</p>}
          <Stack gap="none" className="tenant-destinations">{destinations.map(tenant => {
            const unread = session?.grants[tenant]?.length ? inbox.notifications.filter(n => !n.read && n.payload?.tenant === tenant).length : 0;
            const live = connectionState === 'connected';
            const activity = unread > 0
              ? `${unread} unread ${unread === 1 ? 'notice' : 'notices'} in this inbox.${live ? '' : ' Live updates are currently unavailable.'}`
              : live ? 'No unread notices in this inbox.' : 'Live notification updates are currently unavailable.';
            return <Inline key={tenant} role="group" gap="none" align="center" wrap={false} className="tenant-destination"
              aria-label={unread > 0 ? `${LABELS[tenant]}, ${unread} unread notifications` : LABELS[tenant]}>
              <Button variant="ghost" size="sm" className="tenant-destination-action" aria-label={LABELS[tenant]}
                disabled={busy || activeCall} onClick={() => void switchTo(tenant)}>
                <span aria-hidden="true" data-tenant={tenant}><Avatar name={LABELS[tenant]} initials={LABELS[tenant].slice(0, 2)} size={24}
                  color="var(--color-brand-soft)" foreground="var(--color-brand-ink)" showTitle={false} /></span>
                <T size="sm" weight="semibold">{LABELS[tenant]}</T>
              </Button>
              <Tooltip content={activity} placement="right">
                <span tabIndex={0} role="img" aria-label={`${LABELS[tenant]}: ${activity}`} className={`tenant-activity ${unread > 0 ? 'tenant-activity-unread' : ''}`}
                  data-status={unread > 0 ? 'unread' : live ? 'empty' : 'unavailable'}>
                  {unread > 0 ? <><ActivityIcon size={14} aria-hidden="true" /><span className="tenant-unread" aria-hidden="true">{unread}</span></> : <InfoIcon size={14} aria-hidden="true" />}
                </span>
              </Tooltip>
            </Inline>;
          })}</Stack>
          {destinations.length === 0 && <p className="text-sm text-text-secondary">{sessionStatus === 'loading' ? 'Loading workspaces…' : sessionStatus === 'ready' ? 'No other tenants are available for your account.' : 'Workspaces are unavailable. Check your session and try again.'}</p>}
    </Stack></div>}
  </div>;
}
