import { useNavigate } from 'react-router';
import { ActivityTicker, Button, ChartIcon, ChecklistIcon, ChevronIcon, HistoryIcon, InfoIcon, RepeatIcon } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import { tenantHome } from '../../lib/tenantHome';
import { TODAY_CATEGORIES, TODAY_SAMPLES, todayPreferencesKey } from './footerTodayModel';
const ICONS = { review: ChecklistIcon, agenda: HistoryIcon, goals: ChartIcon, automation: RepeatIcon, budget: InfoIcon };
const items = TODAY_SAMPLES.map(item => { const Icon = ICONS[item.category]; return { ...item, icon: <Icon size={14} /> }; });
const categories = TODAY_CATEGORIES.map(id => ({ id, label: TODAY_SAMPLES.find(item => item.category === id)!.label }));
/** Local sample content, never an authorization, notification or live budget feed. */
export function FooterTodayStrip({ activeCall = false }: { activeCall?: boolean }) {
  const { session, sessionStatus } = useSession(), navigate = useNavigate();
  const preferencesKey = sessionStatus === 'ready' ? todayPreferencesKey(session?.sub, session?.tenant) : null;
  return <ActivityTicker items={items} categories={categories} sample activeCall={activeCall} preferencesKey={preferencesKey} data-testid="footer-today"
    preferencesHint={preferencesKey ? 'Saved for your identity in this workspace on this browser.' : 'Preferences are not saved until your identity is ready.'}
    renderActions={(_, close) => <Button variant="ghost" size="sm" disabled={!session?.tenant} onClick={() => { close(); if (session?.tenant) navigate(tenantHome(session.tenant)); }}>Open workspace<ChevronIcon dir="right" size={14} /></Button>} />;
}
