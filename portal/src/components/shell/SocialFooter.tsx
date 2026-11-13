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
import { Button, IconButton, Inline, Stack, Tooltip } from '@connorhoehn/ui-components/shared';
import { TodayStripSlot } from './FooterTodayStrip';
import { SettingsGearIcon } from '@connorhoehn/ui-components';
import { useSidePaneHost } from '@connorhoehn/ui-components';
import { HuddleBar, type HuddleBarMedia, type HuddleBarPhase } from '@connorhoehn/ui-components/video';
import { useComposerFocus } from '@connorhoehn/ui-components/social/rich-composer';
import { useSession } from '../../lib/auth';
import { useGatewayFrames } from '../../lib/gatewayFrames';
import { callCounts, callDrawn, useCallBlockPlacement, useCallHost, useCallMediaPanel } from '../../lib/conversationCall';
import { CallPageSharing } from './CallPageSharing';
import { EmbeddedSocialEntry } from './EmbeddedSocial';
import { HuddleReactionBar, useHuddleChat, useHuddleChatToggle, useHuddleReact } from './HuddleChat';
import { useMeetingBarItems } from './CallMeeting';
import { NovaBarControls, NovaNotice } from './MeetingAssistantBar';
import { MeetingTurnRunner } from './MeetingTurnRunner';
import { ShellCallMedia } from './ShellCallHost';
import { callScopeKey, hasJoinedCall, idleHuddleControls } from './callShellModel';
import { VoiceFooterSlot } from './VoiceFooterPane';
import { lineStarts } from './footerLines';
import { usePhoneFooter } from './phoneFooter';
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
  const chat = useHuddleChatToggle({ behavior: 'focus' });
  const pageOwnsCall = useHuddleChat()?.paneOwned ?? false;
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
  const barShown = inComposer || placement === 'stage' || placement === 'page' || placement === 'block';
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
    {...(over || barShown || pageOwnsCall ? {} : { onToggleMedia, mediaOpen, mediaToggleLabel: `${people} — ${mediaOpen ? 'hide' : 'show'} call video` })}
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
    className="shell-collaboration-bar shrink-0 grow basis-[14rem] border-l border-border"
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
  // Phone width: Huddle and Join are icon-only (`compact`, the label stays their name and tooltip).
  const compact = usePhoneFooter();
  const focus = useComposerFocus();
  const pane = useSidePaneHost();
  const { session } = useSession();
  const composerMounted = focus.present;
  const lobby = host?.lobby ?? null;
  // The tenant's own places, or nothing at all without a grant or a huddle page (callShellModel.idleHuddleControls).
  const idle = idleHuddleControls({ tenant: session?.tenant, hasLobby: !!lobby, hasSocialGrant: (session?.grants.social?.length ?? 0) > 0 });
  if (!idle.show) return null;
  const startReason = !lobby ? idle.startReason ?? undefined
    : lobby.startBlockedReason ?? (host?.startBound ? undefined : 'This page cannot start a huddle');
  const messageReason = !lobby ? idle.messageReason ?? undefined
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
    compact={compact}
    // At phone width it asks for no more than its icons, so it stays on the row when there is room and otherwise
    // wraps onto a second row of its own (it is the row's last slot).
    className="shell-collaboration-bar shrink-0 grow basis-[14rem] max-sm:basis-[7.5rem] border-l border-border"
    data-testid="shell-footer-context"
  />;
  return <HuddleBar
    name={lobby?.title ?? 'Huddle actions'}
    showContext={false}
    phase="idle"
    {...(startReason ? { startDisabledReason: startReason } : {})}
    {...(host?.startBound ? { onStart: host.startBound } : { onStart: noop })}
    startLabel="Huddle"
    compact={compact}
    onToggleChat={() => { pane.reveal(); focus.request({ mode: 'chat', target: { kind: 'discussion' } }); }}
    chatLabel="Message"
    {...(messageReason ? { chatDisabledReason: messageReason } : {})}
    extras={<DeviceSettings onClick={() => host?.checkDevices()} disabled={!host} />}
    className="shell-collaboration-bar shrink-0 grow basis-[14rem] max-sm:grow-0 max-sm:basis-[7.5rem] border-l border-border"
    data-testid="shell-footer-context"
  />;
}

/**
 * Marks each slot of a wrapping row that starts a line (`data-line-start`).
 * A slot's left rule separates it from the slot before it on the same line;
 * at a narrow width whole slots wrap, and a rule at the start of the second
 * or third line separated nothing (walk, 9 November, 390 px). Which slot
 * starts a line is a layout fact, so it is read after layout, not guessed
 * from a breakpoint. The first visible slot counts as a line start, and hidden
 * slots are skipped (footerLines.ts `lineStarts`).
 */
export function markLineStarts(row: HTMLElement): void {
  const children = Array.from(row.children) as HTMLElement[];
  const starts = lineStarts(children.map((child) => ({ visible: child.getClientRects().length > 0, top: child.offsetTop, bottom: child.offsetTop + child.offsetHeight })));
  children.forEach((child, i) => {
    if (starts[i]) child.setAttribute('data-line-start', '');
    else child.removeAttribute('data-line-start');
  });
}

export function SocialFooter() {
  const footer = useRef<HTMLElement>(null);
  const row = useRef<HTMLElement>(null);
  const host = useCallHost();
  const drawn = !!host?.lobby && callDrawn(host.call.phase, true);
  const media = useCallMediaPanel();
  const mediaId = useId();
  useLayoutEffect(() => {
    const element = footer.current;
    if (!element) return;
    // Floating conversations reserve the actual footer — the row plus an
    // expanded video panel — so Leave remains reachable while they open.
    const measure = () => {
      document.documentElement.style.setProperty('--shell-collaboration-floor',
        `${Math.max(0, Math.ceil(window.innerHeight - element.getBoundingClientRect().top))}px`);
      if (row.current) markLineStarts(row.current);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); if (row.current) observer.observe(row.current);
    // A slot that mounts, unmounts or changes size can move the line breaks without the row
    // itself resizing (the voice slot arriving on a one-line row): watch the slots too.
    const watchSlots = () => { for (const child of Array.from(row.current?.children ?? [])) observer.observe(child); measure(); };
    const slots = new MutationObserver(watchSlots);
    if (row.current) slots.observe(row.current, { childList: true });
    window.addEventListener('resize', measure); watchSlots();
    return () => {
      observer.disconnect(); slots.disconnect(); window.removeEventListener('resize', measure);
      document.documentElement.style.removeProperty('--shell-collaboration-floor');
    };
  }, []);
  return <Stack as="footer" ref={footer} gap="none" aria-label="Social and huddle" className="shell-social-footer shrink-0 border-t border-border bg-surface"
    data-testid="shell-footer">
    <ShellCallMedia id={mediaId} />
    <NovaNotice />
    <MeetingTurnRunner />
    {/* The HuddleBar is a size container, so it has no intrinsic width: `basis-[14rem]` is what makes the row wrap it onto its own line. Wide: one row. Narrow: whole slots wrap onto a second line (none shrinks over its neighbour); the measured floor follows the row's height. */}
    {/* A slot that starts a wrapped line drops its left rule (markLineStarts). */}
    <Inline ref={row} gap="sm" align="center" justify="between" className="min-h-11 min-w-0 px-4 py-1 [&>[data-line-start]]:border-l-0 [&>[data-line-start]]:pl-0" data-testid="shell-footer-row">
      <EmbeddedSocialEntry />
      <TodayStripSlot placement="footer" activeCall={drawn} />
      {/* The voice navigator (docs/voice-navigator-spec.md §5): renders nothing unless features.voiceNavigator and can('VoiceNavigate'). */}
      <VoiceFooterSlot />
      {/* Nova's mark and controls sit beside the call bar, not inside it: the bar's own extras slot has no room at 1280 and a wrapped second line would make the bar taller. */}
      {drawn && <NovaBarControls />}
      {drawn
        ? <FooterCall mediaOpen={!!media?.open} onToggleMedia={() => media?.toggle()} />
        : <FooterIdle />}
    </Inline>
  </Stack>;
}
