// The voice navigator's footer pane (docs/voice-navigator-spec.md §5): the
// library's VoiceDock (ring, phase pill, last line, budget meter, mute,
// hang-up, the confirm card) and, on demand, VoiceTurnStrip in a popover
// that opens above the row. Mounted in SocialFooter beside the huddle half,
// only when `features.voiceNavigator` is on and can('VoiceNavigate') says
// yes; with either off, `VoiceFooterSlot` returns null before any hook runs,
// so the footer is unchanged.
//
// The session lives in a VoiceController (lib/voice/controller.ts), one per
// shell, so it survives route changes; a tenant switch ends it (§2), a page
// change by hand is passed to the voice as silent context, Ctrl+Shift+Space
// toggles it and Escape cancels a confirm card (the dock's popover).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { CaptionsIcon } from '@connorhoehn/ui-components';
import { IconButton, Inline, InlinePopover, Tooltip } from '@connorhoehn/ui-components/shared';
import { VoiceDock, VoiceTurnStrip, type VoicePending, type VoiceTurn } from '@connorhoehn/ui-components/voice';
import { useSession } from '../../lib/auth';
import { useCapabilities, type Action } from '../../lib/capabilities';
import { features } from '../../lib/features';
import { browserMedia } from '../../lib/voice/client';
import { VoiceController } from '../../lib/voice/controller';
import { PAGES, isPageVisible } from './portalCommands';
import { isVoiceHotkey, pageContextNote, voiceDockVisible } from './voiceDockModel';

/** The footer's voice slot: nothing at all unless the flag is on. */
export function VoiceFooterSlot({ enabled = features.voiceNavigator }: { enabled?: boolean }) {
  if (!enabled) return null;
  return <VoiceGate />;
}

function VoiceGate() {
  const { session } = useSession();
  const { can, ready } = useCapabilities();
  if (!voiceDockVisible({ flag: true, signedIn: !!session, ready, allowed: can('VoiceNavigate') })) return null;
  return <VoiceFooterPane />;
}

function VoiceFooterPane() {
  const { session } = useSession();
  const { can } = useCapabilities();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The tool context is read at call time, so a call sees the current router and grants.
  const live = useRef({ tenant: session?.tenant ?? 'orgiq', role: session?.role ?? 'member', can, navigate });
  live.current = { tenant: session?.tenant ?? 'orgiq', role: session?.role ?? 'member', can, navigate };

  const controller = useMemo(() => new VoiceController({
    fetch: (url, init) => fetch(url, init),
    media: browserMedia(),
    toolContext: () => ({
      tenant: live.current.tenant,
      role: live.current.role,
      palette: { pages: PAGES, visible: isPageVisible },
      can: (action: Action) => live.current.can(action),
      fetch: (url, init) => fetch(url, init),
      navigate: (path) => { void live.current.navigate(path); },
      now: () => new Date(),
    }),
  }), []);
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);

  // A tenant switch ends the session (§2: the tools' tenant is the mint's).
  const mintedTenant = useRef(session?.tenant);
  useEffect(() => {
    if (session?.tenant === mintedTenant.current) return;
    mintedTenant.current = session?.tenant;
    void controller.stop('tenant-switch');
  }, [controller, session?.tenant]);

  // Moving by hand: the voice learns where the user is, silently.
  useEffect(() => { controller.noteContext(pageContextNote(pathname)); }, [controller, pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isVoiceHotkey(e)) return;
      e.preventDefault();
      void controller.toggle();
    };
    // A closed tab stops billing: the close is sent with keepalive and the middleware hangs up (§7).
    const onUnload = () => { void controller.stop('dropped'); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', onUnload);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pagehide', onUnload); };
  }, [controller]);

  const [stripOpen, setStripOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const pending: VoicePending | null = snap.pending ? {
    title: snap.pending.title,
    ...(snap.pending.detail ? { detail: snap.pending.detail } : {}),
    onConfirm: () => controller.confirm('click'),
    onCancel: () => controller.cancel('click'),
  } : null;
  const turns = snap.turns as VoiceTurn[];

  return <Inline ref={anchor} gap="xs" align="center" wrap={false} className="min-w-0 max-w-[30rem] shrink border-l border-border pl-2" data-testid="shell-footer-voice">
    <VoiceDock
      phase={snap.phase}
      level={snap.level}
      outputLevel={snap.outputLevel}
      elapsedSeconds={snap.elapsedSeconds}
      budget={snap.budget}
      pending={pending}
      lastLine={snap.lastLine}
      onStart={() => { void controller.start(); }}
      onStop={() => { void controller.stop('closed'); }}
      onMute={() => controller.toggleMute()}
      muted={snap.muted}
      {...(snap.reason ? { unavailableReason: snap.reason } : {})}
      className="min-w-0 flex-1"
      data-testid="shell-voice-dock"
    />
    <Tooltip content={stripOpen ? 'Hide what was said' : 'What was said and what ran'} placement="top">
      <IconButton variant="ghost" size="sm" aria-label="Voice transcript" aria-pressed={stripOpen}
        icon={<CaptionsIcon size={15} />} disabled={turns.length === 0}
        onClick={() => setStripOpen((open) => !open)} data-testid="shell-voice-transcript-toggle" />
    </Tooltip>
    <InlinePopover trigger={anchor} open={stripOpen && turns.length > 0} onClose={() => setStripOpen(false)}
      placement="bottom-end" aria-label="Voice transcript" kind="voice-transcript" data-testid="shell-voice-transcript">
      <VoiceTurnStrip turns={turns} maxVisible={6} onClear={() => { controller.clearTurns(); setStripOpen(false); }} />
    </InlinePopover>
  </Inline>;
}
