import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { ActivityTicker, Button, ChartIcon, ChecklistIcon, ChevronIcon, HistoryIcon, InfoIcon, RepeatIcon } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import { useFetch } from '../../hooks/useFetch';
import { tenantHome } from '../../lib/tenantHome';
import { todayCategories, todayItemsFromWire, todayPreferencesKey } from './footerTodayModel';
const ICONS = { review: ChecklistIcon, agenda: HistoryIcon, goals: ChartIcon, automation: RepeatIcon, budget: InfoIcon };
/** Today, from the BFF (GET /api/today): the same rows the pages read. Hidden while there is nothing to say. */
export function FooterTodayStrip({ activeCall = false }: { activeCall?: boolean }) {
  const { session, sessionStatus } = useSession(), navigate = useNavigate();
  const ready = sessionStatus === 'ready' && !!session?.tenant;
  // Keyed by identity and workspace, so a switch never shows the previous seat's figures.
  const { data } = useFetch<unknown>(ready ? `/api/today?tenant=${encodeURIComponent(session!.tenant)}&as=${encodeURIComponent(session!.sub)}` : null, 60_000);
  const items = useMemo(() => todayItemsFromWire(data).map(item => { const Icon = ICONS[item.category]; return { ...item, icon: <Icon size={14} /> }; }), [data]);
  const categories = useMemo(() => todayCategories(items), [items]);
  const preferencesKey = ready ? todayPreferencesKey(session?.sub, session?.tenant) : null;
  if (items.length === 0) return null;
  return <ActivityTicker items={items} categories={categories} activeCall={activeCall} preferencesKey={preferencesKey} data-testid="footer-today"
    preferencesHint={preferencesKey ? 'Saved for your identity in this workspace on this browser.' : 'Preferences are not saved until your identity is ready.'}
    renderActions={(_, close) => <Button variant="ghost" size="sm" disabled={!session?.tenant} onClick={() => { close(); if (session?.tenant) navigate(tenantHome(session.tenant)); }}>Open workspace<ChevronIcon dir="right" size={14} /></Button>} />;
}
