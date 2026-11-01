import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ActivityTicker, Button, Inline, T, ChartIcon, ChecklistIcon, ChevronIcon, HistoryIcon, InfoIcon, RepeatIcon } from '@connorhoehnslalom/ui-components/shared';
import { callDrawn, useCallHost } from '../../lib/conversationCall';
import { useSession } from '../../lib/auth';
import { useFetch } from '../../hooks/useFetch';
import { tenantHome } from '../../lib/tenantHome';
import { todayCategories, todayItemsFromWire, todayPreferencesKey } from './footerTodayModel';
type Placement = 'header' | 'footer';
const PLACEMENT_KEY = 'work.today-placement.v1';
const TodayPlacement = createContext<{ placement: Placement; setPlacement: (value: Placement) => void; focusMoved: boolean; clearFocus: () => void; moving: boolean; setMoving: (value: boolean) => void } | null>(null);
export function TodayPlacementProvider({ children }: { children: ReactNode }) {
  const [placement, change] = useState<Placement>(() => { try { return localStorage.getItem(PLACEMENT_KEY) === 'header' ? 'header' : 'footer'; } catch { return 'footer'; } });
  const [moving, setMoving] = useState(false);
  const [focusMoved, setFocusMoved] = useState(false);
  const setPlacement = (next: Placement) => { change(next); setMoving(false); setFocusMoved(true); try { localStorage.setItem(PLACEMENT_KEY, next); } catch { /* Device storage is optional. */ } };
  return <TodayPlacement.Provider value={{ placement, setPlacement, moving, setMoving, focusMoved, clearFocus: () => setFocusMoved(false) }}>{children}</TodayPlacement.Provider>;
}
/** Both locations remain available while dragging; only one reads and renders the feed. */
export function TodayStripSlot({ placement, activeCall = false }: { placement: Placement; activeCall?: boolean }) {
  const dock = useContext(TodayPlacement);
  if (!dock || (dock.placement !== placement && !dock.moving)) return null;
  return <Inline gap="none" align="center" wrap={false}
    className={`min-w-0 max-w-[420px] flex-1 max-[780px]:hidden ${dock.moving ? 'rounded-md outline-2 outline-dashed outline-primary bg-primary/5' : ''}`}
    data-today-drop-zone={placement} aria-label={`Today strip ${placement} location`}
    onDragOver={event => { if (dock.moving && event.dataTransfer.types.includes('text/x-activity-ticker')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
    onDrop={event => { if (dock.moving && event.dataTransfer.getData('text/x-activity-ticker') === 'today') { event.preventDefault(); dock.setPlacement(placement); } }}>
    {dock.placement === placement ? <FooterTodayStrip activeCall={activeCall} />
      : <T size="xs" tone="secondary" className="px-3 py-2">Drop Today in {placement}</T>}
  </Inline>;
}
const ICONS = { review: ChecklistIcon, agenda: HistoryIcon, goals: ChartIcon, automation: RepeatIcon, budget: InfoIcon };
/** Today, from the BFF (GET /api/today): the same rows the pages read. Hidden while there is nothing to say. */
export function FooterTodayStrip({ activeCall = false }: { activeCall?: boolean }) {
  const dock = useContext(TodayPlacement);
  const host = useCallHost();
  const callActive = activeCall || !!host?.lobby && callDrawn(host.call.phase, true);
  const { session, sessionStatus } = useSession(), navigate = useNavigate();
  const ready = sessionStatus === 'ready' && !!session?.tenant;
  // Keyed by identity and workspace, so a switch never shows the previous seat's figures.
  const { data } = useFetch<unknown>(ready ? `/api/today?tenant=${encodeURIComponent(session!.tenant)}&as=${encodeURIComponent(session!.sub)}` : null, 60_000);
  const items = useMemo(() => todayItemsFromWire(data).map(item => { const Icon = ICONS[item.category]; return { ...item, icon: <Icon size={14} /> }; }), [data]);
  const categories = useMemo(() => todayCategories(items), [items]);
  const preferencesKey = ready ? todayPreferencesKey(session?.sub, session?.tenant) : null;
  useEffect(() => {
    if (!dock?.focusMoved || !items.length) return;
    document.querySelector<HTMLElement>('[data-testid="footer-today-move"]')?.focus();
    dock.clearFocus();
  }, [dock, items.length]);
  if (items.length === 0) return null;
  return <ActivityTicker placement={dock?.placement} onPlacementChange={dock?.setPlacement} onMoveStart={() => dock?.setMoving(true)} onMoveEnd={() => dock?.setMoving(false)} items={items} categories={categories} activeCall={callActive} preferencesKey={preferencesKey} data-testid="footer-today"
    preferencesHint={preferencesKey ? 'Saved for your identity in this workspace on this browser.' : 'Preferences are not saved until your identity is ready.'}
    renderActions={(_, close) => <Button variant="ghost" size="sm" disabled={!session?.tenant} onClick={() => { close(); if (session?.tenant) navigate(tenantHome(session.tenant)); }}>Open workspace<ChevronIcon dir="right" size={14} /></Button>} />;
}
