// The shell's one footer row (docs/design/initiative-huddle-shell-plan.md,
// "Global footer"): Social entry, workspace presence and the Social-scoped
// activity bell on the left; while a huddle is on, the library's HuddleBar on
// the right (with no call, FooterIdle: the page's huddle context, Huddle and
// Message) — status dot, name, timer, people, bare mic/camera toggles, the
// shared page, the chat toggle and Leave — fed by the same call runtime.
// The device pickers live in the expanded media panel (the call dock), so the
// bar's toggles stay bare icons. Gaps: no status wording beyond the dot's
// label, and no panel toggle (queued in docs/ui-components-queue.md).
//
// It is a nonshrinking sibling AFTER the shell body, never an overlay. Its
// measured height is published as `--shell-collaboration-floor`, which the
// upward-opening panels (footerPanel.ts) and floating conversations subtract,
// so nothing opens over the row. The single media sink — ConversationCallDock's
// tiles — lives in ShellCallMedia. Where the page has a conversation composer
// for the call, that composer carries it (the full bar over the tiles, above
// the input) and this row is the compact status; elsewhere the bar's media
// toggle opens it as the participant grid in the right split pane and
// collapses it back into the footer's hidden thumbnail strip.
import { useId, useLayoutEffect, useRef } from 'react';
import { conversationCallDockProps } from '@connorhoehn/realtime-modules/client/video';
import { Button, IconButton, Inline, Stack, Tooltip } from '@connorhoehnslalom/ui-components/shared';
import { FooterTodayStrip } from './FooterTodayStrip';
import { SettingsGearIcon } from '@connorhoehnslalom/ui-components';
import { useSidePaneHost } from '@connorhoehnslalom/ui-components';
import { HuddleBar, type HuddleBarMedia, type HuddleBarPhase } from '@connorhoehnslalom/ui-components/video';
import { useComposerFocus } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { useSession } from '../../lib/auth';
import { useGatewayFrames } from '../../lib/gatewayFrames';
import { callCounts, callDrawn, useCallBlockPlacement, useCallHost, useCallMediaPanel } from '../../lib/conversationCall';
import { CallPageSharing } from './CallPageSharing';
import { EmbeddedSocialEntry } from './EmbeddedSocial';
import { HuddleReactionBar, useHuddleChatToggle, useHuddleReact } from './HuddleChat';
import { useMeetingBarItems } from './CallMeeting';
import { ShellCallMedia } from './ShellCallHost';
import { callScopeKey, hasJoinedCall } from './callShellModel';
import './socialFooter.css';

const noop = () => {};
const JOINED_PHASES = ['connecting', 'live', 'reconnecting'];
const BAR_PHASE: Record<string, HuddleBarPhase> = {
  live: 'live', calling: 'ringing', connecting: 'connecting', reconnecting: 'reconnecting', failed: 'ended', ended: 'ended',
};

/** The conversation dock's device state, as the bar's bare toggle: on/off, permission, level — no device list. */
const bareToggle = (control: { on: boolean; onToggle: () => void; permission?: HuddleBarMedia['permission']; level?: number; disabledReason?: string }): HuddleBarMedia => ({
  on: control.on, onToggle: control.onToggle,
  ...(control.permission ? { permission: control.permission } : {}),
  ...(control.level !== undefined ? { level: control.level } : {}),
  ...(control.disabledReason ? { disabledReason: control.disabledReason } : {}),
});

function DeviceSettings({ onClick, disabled = false }: { onClick(): void; disabled?: boolean }) {
  return <Tooltip content="Check microphone and camera" placement="top">
    <IconButton variant="ghost" size="sm" className="shell-footer-settings" aria-label="Device settings"
      icon={<SettingsGearIcon size={15} />} onClick={onClick} disabled={disabled} data-testid="shell-footer-check-devices" />
  </Tooltip>;
}

/** The huddle half of the row; renders nothing without a drawn call (Start call stays on its page). */
function FooterCall({ mediaOpen, onToggleMedia }: { mediaOpen: boolean; onToggleMedia(): void }) {
  const host = useCallHost();
  const { session } = useSession();
  const frames = useGatewayFrames();
  const chat = useHuddleChatToggle();
  // On a call that carries a meeting (lib/meetingRooms.ts): Raise, React,
  // People and Rooms as the bar's meeting items; React then replaces the
  // footer's own reaction row (same send, same channel). While the stage is
  // expanded its MeetingToolbar carries them, so the footer stays the status.
  const meetingItems = useMeetingBarItems(useHuddleReact());
  // A conversation composer on this page carries the full call bar and the
  // tiles; the footer stays the compact status and offers no second video panel.
  const placement = useCallBlockPlacement();
  const observedJoin = useRef<{ callId: string; at: number } | null>(null);
  const inComposer = placement === 'composer';
  // While the full call bar is on screen (above a composer, or the page's call
  // block) it owns mic, camera and Leave/Cancel: the footer is the status only,
  // so nothing is drawn twice (the user: "two cancel buttons and duplicated controls").
  const barShown = inComposer || placement === 'page' || placement === 'block';
  if (!host?.lobby || !callDrawn(host.call.phase, true)) return null;
  const call = host.call;
  const title = /huddle$/i.test(host.lobby.title) ? host.lobby.title : `${host.lobby.title} huddle`;
  const counts = callCounts(call.call);
  // The installed dock mapping supplies the same device controls the dock
  // draws (toggle, permission, level) — no second device model here.
  const controls = conversationCallDockProps(call, { title: host.lobby.title, onOpenPeople: noop, onOpenSettings: noop, tile: () => undefined });
  const joined = hasJoinedCall(call.call, call.phase);
  if (joined && call.call && observedJoin.current?.callId !== call.call.callId)
    observedJoin.current = { callId: call.call.callId, at: Date.now() };
  const over = call.phase === 'ended' || call.phase === 'failed';
  const failureMessage = call.phase === 'failed' ? call.error?.message ?? call.media.error ?? 'The call could not connect.' : null;
  const leaveLabel = call.phase === 'calling' ? 'Cancel' : over ? 'Dismiss' : 'Leave';
  const people = `${counts.joined} in the huddle${counts.ringing ? `, ${counts.ringing} ringing` : ''}`;
  return <HuddleBar
    name={title}
    phase={BAR_PHASE[call.phase] ?? 'connecting'}
    startedAt={joined ? call.call?.startedAt ?? observedJoin.current?.at ?? null : null}
    participantCount={counts.joined}
    ringingCount={counts.ringing}
    {...(controls && !over && !barShown ? { mic: bareToggle(controls.mic), camera: bareToggle(controls.camera) } : {})}
    shareSlot={joined ? <CallPageSharing
      callId={call.call?.callId ?? null}
      tenant={host.tenant}
      actorId={host.self?.userId ?? null}
      callerId={call.call?.host ?? null}
      identityKey={callScopeKey(session)}
      gateway={frames.gateway}
      connectionState={frames.connectionState}
      screenShare={controls?.screenShare}
    /> : undefined}
    {...(joined && chat ? { onToggleChat: chat.toggle, chatOpen: chat.open, chatLabel: 'Message' } : {})}
    {...(over || inComposer ? {} : { onToggleMedia, mediaOpen, mediaToggleLabel: `${people} — ${mediaOpen ? 'hide' : 'show'} call video` })}
    {...(call.phase === 'failed' ? { statusLabel: 'Connection failed' }
      : call.phase === 'calling' ? { statusLabel: `Calling ${host.lobby.title}…` } : {})}
    extras={<>
      {failureMessage && <span role="alert" title={failureMessage} className="max-w-[180px] truncate text-xs text-danger" data-testid="shell-call-error">{failureMessage}</span>}
      {joined && !over && !meetingItems && <HuddleReactionBar />}
      
      {call.phase === 'failed' && <Button variant="secondary" size="sm" onClick={() => void call.rejoin()} data-testid="shell-footer-rejoin">Rejoin</Button>}
      {!barShown && <DeviceSettings onClick={host.checkDevices} />}
    </>}
    {...(meetingItems && joined && !over && !barShown ? { meetingItems } : {})}
    {...(barShown && !over ? {} : { onLeave: () => void call.leave(), leaveLabel })}
    className="shell-collaboration-bar min-w-0 flex-1 border-l border-border"
    data-testid="shell-call-dock"
  />;
}

/**
 * The footer's pre-call half: the page's social context (what it registered
 * with the call host), the page's own Start (the host runs the same start its
 * call button runs — no second call path) and Message. Nothing else. A page
 * without a call omits the context label; unavailable actions retain their reasons.
 */
function FooterIdle() {
  const host = useCallHost();
  const focus = useComposerFocus();
  const pane = useSidePaneHost();
  const composerMounted = focus.present;
  const lobby = host?.lobby ?? null;
  const startReason = !lobby ? 'This page has no huddle — open an initiative, team, run, document, conversation or person'
    : lobby.startBlockedReason ?? (host?.startBound ? undefined : 'This page cannot start a huddle');
  const messageReason = !lobby ? 'No huddle here to message'
    : composerMounted || pane.registered ? undefined : 'Start the huddle to message it, or open a page with a conversation';
  // A huddle already live on this page (the host watches the lobby, realtime-modules 0.136): who is in it, and Join.
  const live = lobby && host?.call.phase === 'idle' ? host.call.call : null;
  const inLive = (live?.participants ?? []).filter(p => !p.isLocal && (p.state === 'in-call' || p.state === 'reconnecting'));
  if (live && inLive.length > 0) return <HuddleBar
    name={lobby!.title}
    showContext={false}
    phase="joinable"
    liveParticipants={inLive.map(p => ({ id: p.userId, displayName: p.displayName, ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}) }))}
    participantCount={inLive.length}
    onJoin={() => { void host!.call.rejoin(); }}
    onToggleChat={() => { pane.reveal(); focus.request({ mode: 'chat', target: { kind: 'discussion' } }); }}
    chatLabel="Message"
    {...(messageReason ? { chatDisabledReason: messageReason } : {})}
    extras={<DeviceSettings onClick={() => host?.checkDevices()} disabled={!host} />}
    className="shell-collaboration-bar min-w-0 flex-1 border-l border-border"
    data-testid="shell-footer-context"
  />;
  return <HuddleBar
    name={lobby?.title ?? 'Huddle actions'}
    showContext={false}
    phase="idle"
    {...(startReason ? { startDisabledReason: startReason } : {})}
    {...(host?.startBound ? { onStart: host.startBound } : { onStart: noop })}
    startLabel="Huddle"
    onToggleChat={() => { pane.reveal(); focus.request({ mode: 'chat', target: { kind: 'discussion' } }); }}
    chatLabel="Message"
    {...(messageReason ? { chatDisabledReason: messageReason } : {})}
    extras={<DeviceSettings onClick={() => host?.checkDevices()} disabled={!host} />}
    className="shell-collaboration-bar min-w-0 flex-1 border-l border-border"
    data-testid="shell-footer-context"
  />;
}

export function SocialFooter() {
  const footer = useRef<HTMLElement>(null);
  const host = useCallHost();
  const drawn = !!host?.lobby && callDrawn(host.call.phase, true);
  const media = useCallMediaPanel();
  const mediaId = useId();
  useLayoutEffect(() => {
    const element = footer.current;
    if (!element) return;
    // Floating conversations reserve the actual footer — the row plus an
    // expanded video panel — so Leave remains reachable while they open.
    const measure = () => document.documentElement.style.setProperty('--shell-collaboration-floor',
      `${Math.max(0, Math.ceil(window.innerHeight - element.getBoundingClientRect().top))}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(element); window.addEventListener('resize', measure); measure();
    return () => {
      observer.disconnect(); window.removeEventListener('resize', measure);
      document.documentElement.style.removeProperty('--shell-collaboration-floor');
    };
  }, []);
  return <Stack as="footer" ref={footer} gap="none" aria-label="Social and huddle" className="shell-social-footer shrink-0 border-t border-border bg-surface"
    data-testid="shell-footer">
    <ShellCallMedia id={mediaId} />
    <Inline gap="md" align="center" justify="between" wrap={false} className="min-h-11 min-w-0 overflow-x-auto px-4 py-1" data-testid="shell-footer-row">
      <EmbeddedSocialEntry />
      <FooterTodayStrip activeCall={drawn} />
      {drawn
        ? <FooterCall mediaOpen={!!media?.open} onToggleMedia={() => media?.toggle()} />
        : <FooterIdle />}
    </Inline>
  </Stack>;
}
