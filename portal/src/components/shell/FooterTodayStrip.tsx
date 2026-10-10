import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { ActivityIcon, Button, ChartIcon, Checkbox, ChecklistIcon, ChevronIcon, CloseIcon, EyeIcon, EyeOffIcon, HistoryIcon, IconButton, InfoIcon, InlinePopover, RepeatIcon, SlidersIcon, Stack, T, Tooltip } from '@connorhoehnslalom/ui-components/shared';
import { PauseIcon, PlayIcon } from '@connorhoehnslalom/ui-components/video';
import { useSession } from '../../lib/auth';
import { tenantHome } from '../../lib/tenantHome';
import { readTodayPreferences, TODAY_CATEGORIES, TODAY_SAMPLES, todayPreferencesKey, todayRotationAllowed, type TodayPreferences } from './footerTodayModel';
import './footerTodayStrip.css';

const SAMPLE_ICONS = { review: ChecklistIcon, agenda: HistoryIcon, goals: ChartIcon, automation: RepeatIcon, budget: InfoIcon };
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query), update = () => setMatches(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}
function load(key: string | null) {
  try { return readTodayPreferences(key ? localStorage.getItem(key) : null); }
  catch { return readTodayPreferences(null); }
}

/** A local demo, never a live notification or agent/budget counter. */
export function FooterTodayStrip({ activeCall = false }: { activeCall?: boolean }) {
  const { session, sessionStatus } = useSession();
  const storageKey = sessionStatus === 'ready' ? todayPreferencesKey(session?.sub, session?.tenant) : null;
  // A changed signed actor/workspace cannot render the previous one's preferences.
  return <TodayStrip key={storageKey ?? 'unidentified'} storageKey={storageKey} tenant={session?.tenant ?? ''} activeCall={activeCall} />;
}

function TodayStrip({ storageKey, tenant, activeCall }: { storageKey: string | null; tenant: string; activeCall: boolean }) {
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState<TodayPreferences>(() => load(storageKey));
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [panel, setPanel] = useState<'detail' | 'settings' | null>(null);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), toolbar = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const hint = useId();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const compact = useMediaQuery('(max-width: 1100px)') || activeCall;
  const samples = TODAY_SAMPLES.filter(sample => prefs.categories.includes(sample.category));
  const current = samples[index % Math.max(samples.length, 1)];
  const engaged = hovered || focused || panel !== null;
  const Icon = current ? SAMPLE_ICONS[current.category] : ActivityIcon;
  useEffect(() => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify(prefs)); } catch { /* Private mode keeps local controls usable. */ }
  }, [storageKey, prefs]);
  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const rotating = !prefs.hidden && todayRotationAllowed({ paused: prefs.paused, quiet: prefs.quiet, engaged, reducedMotion, pageVisible, activeCall, count: samples.length });
  useEffect(() => {
    if (!rotating) return;
    const timer = setInterval(() => setIndex(value => value + 1), prefs.speed === 'fast' ? 6000 : 12000);
    return () => clearInterval(timer);
  }, [rotating, prefs.speed]);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  useLayoutEffect(() => {
    if (!engaged || prefs.hidden) { setAnchor(null); return; }
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) setAnchor({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 220)), bottom: window.innerHeight - rect.top });
    };
    position(); window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [engaged, prefs.hidden, compact]);
  function enter() { clearTimeout(leaveTimer.current); setHovered(true); }
  function leave() { clearTimeout(leaveTimer.current); leaveTimer.current = setTimeout(() => setHovered(false), 150); }
  function blur(next: EventTarget | null) {
    setFocused(next instanceof Node && (!!root.current?.contains(next) || !!toolbar.current?.contains(next)));
  }
  function update(next: Partial<TodayPreferences>) { setPrefs(value => ({ ...value, ...next })); }
  function hide() { update({ hidden: true }); setPanel(null); setHovered(false); setFocused(false); }

  return <div ref={root} className="footer-today" data-compact={compact || undefined} data-call={activeCall || undefined} data-hidden={prefs.hidden || undefined} data-testid="footer-today"
    onMouseEnter={enter} onMouseLeave={leave} onFocusCapture={() => setFocused(true)} onBlurCapture={event => blur(event.relatedTarget)}>
    {prefs.hidden ? <Tooltip content="Restore sample Today strip"><IconButton aria-label="Restore sample Today strip" size="sm" icon={<EyeIcon size={14} />} onClick={() => update({ hidden: false })} /></Tooltip>
      : <Button ref={trigger} variant="ghost" size="sm" className="footer-today-summary" data-dimmed={prefs.dimmed || undefined}
        aria-label={current ? `Demo today: ${current.label}. ${current.summary}` : 'Demo today: no sample categories selected'}
        aria-describedby={hint} aria-haspopup="dialog" aria-expanded={panel === 'detail'}
        onClick={() => setPanel(value => value === 'detail' ? null : 'detail')}
        onKeyDown={event => { if (event.key === 'ArrowUp') { event.preventDefault(); toolbar.current?.querySelector<HTMLButtonElement>('button')?.focus(); } }}>
        <Icon size={14} /><span className="footer-today-demo">Demo</span>
        <span className="footer-today-copy">{current ? <><strong>{current.label}</strong><span className="footer-today-description"> · {current.summary}</span></> : 'Today · No categories selected'}</span>
      </Button>}
    <span id={hint} className="sr-only">Sample content. Arrow Up opens the controls. Automatic rotation pauses while focused.</span>
    {anchor && !prefs.hidden && createPortal(<div ref={toolbar} role="toolbar" aria-label="Sample Today controls" className="footer-today-toolbar"
      style={{ left: anchor.left, bottom: anchor.bottom }} onMouseEnter={enter} onMouseLeave={leave}
      onFocusCapture={() => setFocused(true)} onBlurCapture={event => blur(event.relatedTarget)}>
      <Tooltip content="Hide this sample strip"><IconButton aria-label="Hide sample Today strip" size="sm" icon={<EyeOffIcon size={14} />} onClick={hide} /></Tooltip>
      <Tooltip content={prefs.dimmed ? 'Restore brightness' : 'Dim this sample strip'}><IconButton aria-label="Dim sample Today strip" aria-pressed={prefs.dimmed} size="sm" icon={<EyeIcon size={14} />} onClick={() => update({ dimmed: !prefs.dimmed })} /></Tooltip>
      <Tooltip content={prefs.speed === 'slow' ? 'Slow · every 12 seconds' : 'Fast · every 6 seconds'}><IconButton aria-label={`Rotation speed: ${prefs.speed}`} size="sm" icon={<HistoryIcon size={14} />} onClick={() => update({ speed: prefs.speed === 'slow' ? 'fast' : 'slow' })} /></Tooltip>
      <Tooltip content={prefs.paused ? 'Resume sample rotation' : 'Pause sample rotation'}><IconButton size="sm" aria-label={prefs.paused ? 'Resume sample rotation' : 'Pause sample rotation'} aria-pressed={prefs.paused} icon={prefs.paused ? <PlayIcon size={14} /> : <PauseIcon size={14} />} onClick={() => update({ paused: !prefs.paused })} /></Tooltip>
      <Tooltip content="Next sample"><IconButton aria-label="Next sample" size="sm" disabled={samples.length < 2} icon={<ChevronIcon dir="right" size={14} />} onClick={() => setIndex(value => value + 1)} /></Tooltip>
      <Tooltip content="Sample Today settings"><IconButton aria-label="Sample Today settings" size="sm" aria-haspopup="dialog" aria-expanded={panel === 'settings'} icon={<SlidersIcon size={14} />} onClick={() => setPanel(value => value === 'settings' ? null : 'settings')} /></Tooltip>
    </div>, document.body)}
    <InlinePopover trigger={trigger} open={panel !== null} onClose={() => setPanel(null)} placement="bottom-start" aria-label={panel === 'settings' ? 'Sample Today settings' : 'Sample Today details'} className="footer-today-panel">
      <Stack gap="sm">
        <div className="footer-today-panel-heading"><T size="sm" weight="semibold">{panel === 'settings' ? 'Today preferences' : current?.label ?? 'Today'}</T>
          <IconButton aria-label="Close Today panel" size="sm" icon={<CloseIcon size={14} />} onClick={() => setPanel(null)} /></div>
        <T size="xs" tone="secondary">Demo · Sample content only. No live activity is connected.</T>
        {panel === 'settings' ? <>
          <T size="xs" weight="semibold">Categories</T>
          {TODAY_CATEGORIES.map(category => <label className="footer-today-option" key={category}><Checkbox checked={prefs.categories.includes(category)} onChange={checked => {
            update({ categories: TODAY_CATEGORIES.filter(value => value === category ? checked : prefs.categories.includes(value)) }); setIndex(0);
          }} />{TODAY_SAMPLES.find(sample => sample.category === category)!.label}</label>)}
          <label className="footer-today-option"><Checkbox checked={prefs.quiet} onChange={quiet => update({ quiet })} />Quiet rotation · manual only</label>
          <T size="xs" tone="secondary">{reducedMotion ? 'Reduced motion is on. Use Next sample to rotate manually.' : 'Rotation pauses on hover, focus, during a huddle, and while a panel is open.'}</T>
          <T size="xs" tone="secondary">{storageKey ? 'Saved for your identity in this workspace on this browser.' : 'Preferences are not saved until your identity is ready.'}</T>
        </> : <>
          <T size="sm">{current?.detail ?? 'Choose a category in Today settings to show samples.'}</T>
          <Button variant="ghost" size="sm" disabled={!tenant} onClick={() => { setPanel(null); navigate(tenantHome(tenant)); }}>Open workspace<ChevronIcon dir="right" size={14} /></Button>
        </>}
      </Stack>
    </InlinePopover>
  </div>;
}
