// The voice navigator's footer pane (docs/voice-navigator-spec.md §5): the
// library's VoiceDock at `size="footer"` (HuddleBar's metrics: sm ring, xs
// labels, a quiet "Voice" / "End" control, mute, the confirm card). Its CC
// control (G26, ui-components 2.510.6 `transcriptOpen`) shows the library's
// VoiceTurnStrip inline in a row above the dock at the footer's scale, never a
// popover or a dialog; the strip's extras row holds the "Keep transcripts on
// this device" switch and the history control. Mounted in SocialFooter beside the huddle half,
// only when `features.voiceNavigator` is on and can('VoiceNavigate') says
// yes; with either off, `VoiceFooterSlot` returns null before any hook runs,
// so the footer is unchanged.
//
// The session lives in a VoiceController (lib/voice/controller.ts), one per
// shell, so it survives route changes; a tenant switch ends it (§2), a page
// change by hand is passed to the voice as silent context, Ctrl+Shift+Space
// toggles it and Escape cancels a confirm card (the dock's popover).
//
// The machine and people tools (lib/voice/actions.ts) reach only what the
// shell already mounts, never a second socket: the Computer Lab's provider
// (ComputeHost's useCompute: computers, create, openShell, the command
// stream), the shell's one presence announcement (EmbeddedSocial), and the
// gateway socket through useChat for a post, the same send-and-wait-for-
// receipt path the composer uses, and the shell's call host (useSocialCall,
// the Social pages' call buttons and the footer's Huddle) for call. A
// computer run's output streams into a read-only output tab in the compute dock
// (the library's openOutputTab, ui-components 2.510.2), beside the shell
// tabs, with an "Open shell" action. Work queue_work queues (G19) is followed
// by lib/voice/work.ts's VoiceJobTracker: one library job toast (useToast's
// toastJob, 2.510.3) per server job id, gone VOICE_TOAST_SECONDS after it ends,
// the entry mirrored into the notification center (lib/localNotifications.ts)
// and the outcome spoken while the session is live. An ambiguous `open` (two
// Alphas) shows the library's VoiceChoiceCard (2.510.4) through the dock's
// `pendingChoice`; the user picks by click or by saying the number. Every
// card carries the controller's `requestId` (2.510.5 remounts a card per
// request), and the dock opens either card on its prop alone.
//
// The session log (G20): the controller posts the session's structured events
// (lib/voice/sessionEvents.ts); with "Keep transcripts on this device" on
// (lib/voice/transcriptKeep.ts, default off) this pane saves the session's
// turns to IndexedDB under its id, never sending them; the dock's history
// control opens System › Logging on its Voice source (/iq/logging/voice/<id>,
// G37; an orgiq page on the dev server only) at the session last minted, else
// the latest.
//
// Inbound awareness (G23): the pane listens where the shell already does: the
// app-wide notification inbox (SharedNotificationsProvider) and the shell's
// gateway socket for direct-message frames. Each new item (never the backlog
// present when the pane mounted) goes to lib/voice/inbound.ts's memory, where
// `get message:<id>` reads it and `message { thread }` answers it, and to the
// controller, which tells a live session (a note, then one spoken line).
//
// Dropped sessions (G35): a page that goes away closes the session at
// pagehide, with the cause `beforeunload` when a navigation or reload led
// there and `pagehide` otherwise (a tab discarded, a mobile switch); a transport drop behind a hidden page is
// `visibilitychange`. Such a session's id stays in sessionStorage for 60 s
// (RESUME_MS) and the dock's Start control reads "Resume", which mints with
// `resumeOf`. Nothing in the voice path loads a full page: tools navigate
// through the router, and so does the library's job toast link (its
// `onNavigate`, ui-components 2.514.1, wired through VoiceJobTracker).
//
// No money in the footer (owner decision, 8 November): the dock shows the
// phase, the elapsed time and the controls, never a dollar figure, so no
// `budget` reaches VoiceDock; the hold and the daily cap still enforce in the
// controller and the middleware.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useChat, useGatewayOptional } from '@connorhoehn/realtime-modules/client';
import { openOutputTab, openShell, useComputeOptional } from '@connorhoehn/ui-components/compute';
import { Inline, useToastOptional } from '@connorhoehn/ui-components/shared';
import { VoiceDock, type VoiceConfirmResult, type VoicePending, type VoicePendingChoice } from '@connorhoehn/ui-components/voice';
import { useSession } from '../../lib/auth';
import { useCapabilities, type Action } from '../../lib/capabilities';
import { features } from '../../lib/features';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { useFetch } from '../../hooks/useFetch';
import { browserMedia } from '../../lib/voice/client';
import { keepTranscripts, setKeepTranscripts, subscribeKeepTranscripts, transcriptStore } from '../../lib/voice/transcriptKeep';
import { VOICE_LOG_PATH, sessionHref } from '../../pages/voice/voiceLogModel';
import { pageContextFor, pageContextNote, pageIdFor, pageTabsFor, subscribePageContext } from '../../lib/voice/pageContext';
import { voiceVerbosity } from '../../lib/voice/contextWindow';
import { VoiceController, type ResumeRecord, type ResumeStore } from '../../lib/voice/controller';
import { TENANT_SWITCH_EVENT } from '../../lib/voice/tenantSwitch';
import { InboundMemory, messageFromFrame, notificationItem } from '../../lib/voice/inbound';
import { useSharedNotificationsOptional } from './SharedNotifications';
import { VoiceJobTracker, jobNotification, type JobNotice } from '../../lib/voice/work';
import { addLocalNotification, getLocalNotifications } from '../../lib/localNotifications';
import { subscribeWorkEvents } from '../../hooks/useWorkEvents';
import { ResultMemory, type CallAccess, type CommandOutputView, type ComputeAccess, type DeliveryRecord, type PresenceAccess, type PresencePerson, type SocialAccess, type ToolContext, type VoiceComputer } from '../../lib/voice/tools';
import { useCallHost } from '../../lib/conversationCall';
import { useSocialCall } from '../../pages/social/useSocialCall';
import { SocialSendError, sendAndWaitForSocialChatAck, socialChatError, socialChatErrorCode, type SocialSendFailure } from '../../pages/social/socialChatDelivery';
import { useEmbeddedSocial } from './EmbeddedSocial';
import { PAGES, isPageVisible } from './portalCommands';
import { dockPending, dockTranscriptProps, isVoiceHotkey, voiceDockVisible, voiceLogHref } from './voiceDockModel';
import { tenantLobbyPresence } from './tenantPresence';

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

/** queue_work kinds whose jobs the Work stream announces (the sweep jobs and the dispatcher's work jobs). */
const WORK_EVENT_KINDS: ReadonlySet<string> = new Set(['sweep', 'bot-run', 'job', 'dispatch', 'finding-promote']);

/** Social actions whose grant comes from the plane outside the Social tenant (routes/social-plane.ts PLANE_ACTIONS). */
const PLANE_ACTIONS: ReadonlySet<Action> = new Set<Action>(['PostMessage', 'StartCall']);

/** System › Logging (G37) is registered under the dev server only (App.tsx features.voiceLog), as is this control; it is an orgiq page, so other tenants' footers leave it out. */
const VOICE_LOG_AVAILABLE = features.voiceLog;
/** How often a kept transcript is saved while the words stream in. */
const KEEP_SAVE_MS = 1000;

/** sessionStorage key of the dropped session a Start resumes (G35): per tab, survives the tab's reload. */
const RESUME_KEY = 'voiceResume';
const resumeStore: ResumeStore = {
  load: () => {
    const raw = window.sessionStorage.getItem(RESUME_KEY);
    return raw ? JSON.parse(raw) as ResumeRecord : null;
  },
  save: (r) => { window.sessionStorage.setItem(RESUME_KEY, JSON.stringify(r)); },
  clear: () => { window.sessionStorage.removeItem(RESUME_KEY); },
};

/** How long a post waits for its conversation's join before giving up. */
const CHANNEL_JOIN_MS = 8000;

type ChatReplyTo = { messageId: string; author: string; text: string; timestamp?: string };
type ChatPageRef = { kind: 'initiative' | 'work-item'; id: string };
type ChatSender = (text: string, deliveryId: string, replyTo?: ChatReplyTo, pageReference?: ChatPageRef) => Promise<void>;
type Waiter = { resolve(sender: ChatSender): void; reject(err: Error): void };

/**
 * The conversation a voice post goes to: useChat(channel) on the shell's
 * socket, ready once the gateway says `joined` (SocialConversation's own
 * rule), and the composer's confirmed send. Stays mounted until the voice
 * posts somewhere else, so a confirm and its retry share one join.
 */
function VoiceChatChannel({ channel, userId, displayName, onReady, onFailed }: {
  channel: string; userId: string; displayName: string;
  onReady(channel: string, sender: ChatSender | null): void;
  onFailed(channel: string, message: string, code: SocialSendFailure): void;
}) {
  const gateway = useGatewayOptional();
  const chat = useChat(channel);
  const epoch = gateway?.sessionEpoch;
  const [joined, setJoined] = useState<number | undefined | null>(null);
  const latest = useRef({ chat, gateway });
  latest.current = { chat, gateway };
  const abort = useRef(new AbortController());
  useEffect(() => { const a = abort.current; return () => a.abort(); }, []);
  const listen = gateway?.onMessage;
  useEffect(() => listen?.((frame) => {
    const f = frame as Record<string, unknown>;
    const failure = socialChatError(f, channel);
    if (failure) onFailed(channel, failure, socialChatErrorCode(f));
    if (f['type'] === 'chat' && f['channel'] === channel && f['action'] === 'joined') setJoined(epoch);
  }), [listen, channel, epoch, onFailed]);
  useEffect(() => { setJoined(null); }, [channel, epoch]);
  const ready = joined !== null && joined === epoch;
  useEffect(() => {
    if (!ready) return undefined;
    onReady(channel, async (text, deliveryId, replyTo, pageReference) => {
      const { gateway: g } = latest.current;
      if (!g?.onMessage || g.connectionState !== 'connected') throw new SocialSendError('Social is not connected right now.', 'not-connected');
      await sendAndWaitForSocialChatAck({
        channel, deliveryId, userId, listen: g.onMessage as (h: (f: Record<string, unknown>) => void) => () => void, signal: abort.current.signal,
        // A thread reply (G23) is the composer's quote-reply: `metadata.replyTo`.
        send: () => latest.current.chat.sendMessage(text, { displayName, clientDeliveryId: deliveryId, ...(replyTo ? { replyTo } : {}), ...(pageReference ? { pageReference } : {}) }),
      });
    });
    return () => onReady(channel, null);
  }, [ready, channel, userId, displayName, onReady]);
  return null;
}

function VoiceFooterPane() {
  const { session } = useSession();
  const { can } = useCapabilities();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const compute = useComputeOptional();
  const social = useEmbeddedSocial();
  const gateway = useGatewayOptional();
  const tenant = session?.tenant ?? 'orgiq';
  // Outside the Social tenant, Social actions come from the plane's grants, not the session's tenant (socialPlane.ts).
  // Read with or without a Social grant: without one it answers every action false and names the catalog item
  // that grants posting (`requestItemId`), which a refused post offers (G10).
  const onPlane = tenant !== 'social';
  const planeCaps = useFetch<{ actions: Record<string, boolean>; requestItemId?: string }>(onPlane ? '/api/social/plane/capabilities' : null, 60_000, { share: true });
  // Delivery ids per (channel, text), for this person only.
  const deliveries = useMemo(() => new Map<string, DeliveryRecord>(), [session?.sub]);
  // The action ledger (tools.ts `once`): a retried act never acts twice while this dock lives.
  const ledger = useMemo(() => new Map<string, DeliveryRecord>(), [session?.sub]);
  // The rows this tenant's reads returned, for open and get by position; a new tenant or another person starts empty
  // (G14: a row one persona's read returned is never opened for another in the same tab).
  const results = useMemo(() => new ResultMemory(), [tenant, session?.sub]);
  // G23: what reached this person during the dock's life, for get message:<id> and a thread reply.
  const inbox = useMemo(() => new InboundMemory(), [session?.sub]);

  // ── the post path: one conversation mounted at a time, a sender per joined channel ──
  // G46 (session vs_900938ca): a join the gateway refused (`not-a-member`) or that never answered drops the mount, so
  // the next post mounts it afresh and joins again; a mount kept after a failure never re-joined, and every later post
  // (even after the user joined the channel) waited out CHANNEL_JOIN_MS. `n` keys the remount.
  const [chatMount, setChatMount] = useState<{ channel: string; n: number } | null>(null);
  const chatChannelRef = useRef<string | null>(null);
  const mounts = useRef(0);
  const senders = useRef(new Map<string, ChatSender>());
  const waiters = useRef(new Map<string, Waiter[]>());
  const dropMount = useCallback((channel: string) => {
    if (chatChannelRef.current !== channel) return;
    chatChannelRef.current = null;
    senders.current.delete(channel);
    setChatMount(null);
  }, []);
  const onReady = useCallback((channel: string, sender: ChatSender | null) => {
    if (!sender) { senders.current.delete(channel); return; }
    senders.current.set(channel, sender);
    for (const w of waiters.current.get(channel) ?? []) w.resolve(sender);
    waiters.current.delete(channel);
  }, []);
  const onFailed = useCallback((channel: string, message: string, code: SocialSendFailure) => {
    // A joined conversation's error belongs to the send in flight (its own ack wait reports it), never to the join.
    if (senders.current.has(channel)) return;
    for (const w of waiters.current.get(channel) ?? []) w.reject(new SocialSendError(message, code));
    waiters.current.delete(channel);
    dropMount(channel);
  }, [dropMount]);
  const sendChat = useCallback(async ({ channel, text, deliveryId, replyTo, pageReference }: { channel: string; text: string; deliveryId: string; replyTo?: ChatReplyTo; pageReference?: ChatPageRef }) => {
    let sender = senders.current.get(channel);
    if (!sender) {
      if (chatChannelRef.current !== channel) { chatChannelRef.current = channel; mounts.current += 1; setChatMount({ channel, n: mounts.current }); }
      sender = await new Promise<ChatSender>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.current.set(channel, (waiters.current.get(channel) ?? []).filter((w) => w !== waiter));
          dropMount(channel);
          reject(new SocialSendError('The conversation did not open in time.', 'timeout'));
        }, CHANNEL_JOIN_MS);
        const list = waiters.current.get(channel) ?? [];
        const waiter: Waiter = { resolve: (s) => { clearTimeout(timer); resolve(s); }, reject: (e) => { clearTimeout(timer); reject(e); } };
        list.push(waiter);
        waiters.current.set(channel, list);
      });
    }
    await sender(text, deliveryId, replyTo, pageReference);
  }, [dropMount]);

  // ── computer run's captured output: a read-only tab in the compute dock (G9) ──
  // Read through a ref: the controller is built once per pane, and a new computer list must not rebuild it (that ends the session).
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const showOutput = useCallback((view: CommandOutputView): boolean => {
    const box = computeRef.current?.computers.find((c) => c.id === view.computerId);
    const lines: Array<{ id: string; message: string; level?: 'error' }> = view.lines.map((message, i) => ({ id: `l${i}`, message }));
    if (view.error) lines.push({ id: 'error', message: view.error, level: 'error' });
    const opened = openOutputTab({
      id: view.id, label: `${view.computer} output`, command: view.command, lines, running: view.running,
      ...(view.exitCode != null ? { exitCode: view.exitCode } : {}),
      ...(box ? { onOpenShell: () => { openShell({ id: box.id, label: box.label, sessionId: box.sessionId, ...(box.workspace ? { cwd: box.workspace } : {}) }); } } : {}),
    });
    return opened.ok;
  }, []);

  const computeAccess = useMemo<ComputeAccess | null>(() => (compute && tenant === 'orgiq' ? {
    canManage: compute.canManage,
    computers: () => compute.computers as readonly VoiceComputer[],
    create: (input) => compute.create(input),
    openShell: (box) => { const r = openShell(box); return r.ok ? r : { ok: false, reason: r.reason }; },
    runCommand: (sessionId, body, onEvent, signal) => compute.client.runCommand(sessionId, body, onEvent, signal),
    // computer stop: the lab's own remove (DELETE /api/devbox/boxes/:boxId), the dock having checked the box is the caller's.
    remove: (id) => compute.remove(id),
  } : null), [compute, tenant]);

  // call (start and join): the shell's one call host (ShellCallHost mounts this footer), through the Social pages' own starts.
  const host = useCallHost();
  const socialCall = useSocialCall();
  const callAccess: CallAccess | null = host ? {
    unavailable: socialCall.unavailable,
    active: () => {
      const phase = host.call.phase;
      return phase === 'idle' || phase === 'ended' || phase === 'failed' ? null : { title: host.lobby?.title ?? 'a call' };
    },
    callConversation: (conversation) => socialCall.callConversation(conversation),
    callPeople: (people) => socialCall.callPeople(people),
  } : null;

  const socialAccess = useMemo<SocialAccess | null>(() => (social?.available ? {
    api: tenant === 'social' ? '/api/social' : '/api/social/plane',
    unavailable: gateway?.connectionState === 'connected' ? null : 'Social is not connected right now. Try again in a moment.',
    send: sendChat,
    presence: social.presence,
    deliveries,
  } : null), [social?.available, social?.presence, tenant, gateway?.connectionState, sendChat, deliveries]);

  // activity `online`: exactly the faces the footer shows. With a Social grant that is the shell's one Social
  // announcement (EmbeddedSocial's presencePeople); without one, the tenant lobby TenantLobby announces on.
  const socialPeople = social?.available ? social.presencePeople : null;
  const presenceAccess = useMemo<PresenceAccess>(() => ({
    roster: (): PresencePerson[] => {
      const me = session?.sub;
      if (socialPeople) {
        return socialPeople.filter((p) => p.id !== me).map((p) => ({ userId: p.id, name: p.name, status: p.idle ? 'away' : 'online', ...(p.detail ? { message: p.detail } : {}) }));
      }
      return (tenantLobbyPresence.get()?.online ?? []).filter((p) => p.userId !== me).map((p) => ({ userId: p.userId, name: p.name, status: 'online' as const }));
    },
    // set_status (G10): the tenant lobby's own entry, when the shell announces on one (no Social grant needed).
    lobby: () => {
      const entry = tenantLobbyPresence.get();
      return entry ? { channel: entry.lobby, setStatus: (status) => entry.setStatus(status as 'online' | 'away' | 'busy' | 'offline'), updateMetadata: (meta) => entry.updateMetadata(meta) } : null;
    },
  }), [socialPeople, session?.sub]);

  // The tool context is read at call time, so a call sees the current router, grants and providers.
  const planeActions = planeCaps.data?.actions ?? {};
  const socialRequestItemId = onPlane && planeCaps.data?.actions && !planeCaps.data.actions['PostMessage'] ? planeCaps.data.requestItemId ?? null : null;
  const userId = session?.sub ?? null;
  const live = useRef({ tenant, role: session?.role ?? 'member', userId, ledger, can, navigate, compute: computeAccess, social: socialAccess, calls: callAccess, presence: presenceAccess, planeActions, socialRequestItemId, results, inbox });
  live.current = { tenant, role: session?.role ?? 'member', userId, ledger, can, navigate, compute: computeAccess, social: socialAccess, calls: callAccess, presence: presenceAccess, planeActions, socialRequestItemId, results, inbox };

  // ── queue_work (G19): one keyed toast per job, the notification center's entry, the spoken outcome ──
  const toaster = useToastOptional();
  const toasterRef = useRef(toaster);
  toasterRef.current = toaster;
  const controllerRef = useRef<VoiceController | null>(null);
  const tenantRef = useRef(tenant);
  tenantRef.current = tenant;
  const jobs = useMemo(() => new VoiceJobTracker({
    fetch: (url, init) => fetch(url, init),
    toast: {
      toastJob: (opts) => { toasterRef.current?.toastJob(opts); },
      dismissJobToast: (id) => { toasterRef.current?.dismissJobToast(id); },
    },
    notify: (n: JobNotice) => addLocalNotification(jobNotification(n, tenantRef.current, new Date())),
    speak: (line) => controllerRef.current?.noteJobOutcome(line),
    // G35: the toast's link goes through the router (the library's `onNavigate`), never a full page load.
    navigate: (href) => { void live.current.navigate(href); },
    toastSeconds: () => controllerRef.current?.toastSeconds() ?? 8,
    // The stream the page already holds: the Work pages' /api/work/events in orgiq (the sweep jobs and the
    // dispatcher's jobs both emit there), the run's own event stream in pipelines.
    wake: (job, onEvent) => {
      // Work's jobs emit on /api/work/events; the other kinds' reads are polled (their pages poll too).
      if (WORK_EVENT_KINDS.has(job.kind)) return subscribeWorkEvents(onEvent);
      if (job.kind !== 'pipeline') return () => {};
      if (typeof EventSource === 'undefined') return () => {};
      const es = new EventSource(`/api/pipelines/runs/${encodeURIComponent(job.jobId)}/events`);
      es.onmessage = () => onEvent();
      return () => es.close();
    },
  }), []);
  useEffect(() => () => jobs.dispose(), [jobs]);

  const controller = useMemo(() => new VoiceController({
    fetch: (url, init) => fetch(url, init),
    media: browserMedia(),
    toolContext: (): ToolContext => ({
      tenant: live.current.tenant,
      role: live.current.role,
      userId: live.current.userId,
      ledger: live.current.ledger,
      palette: { pages: PAGES, visible: isPageVisible },
      // Outside Social, posting and calling are the plane's grants (GET /api/social/plane/capabilities), not the session tenant's.
      can: (action: Action) => (PLANE_ACTIONS.has(action) && live.current.tenant !== 'social' ? !!live.current.planeActions[action] : live.current.can(action)),
      fetch: (url, init) => fetch(url, init),
      navigate: (path) => { void live.current.navigate(path); },
      now: () => new Date(),
      compute: live.current.compute,
      social: live.current.social,
      calls: live.current.calls,
      presence: live.current.presence,
      socialRequestItemId: live.current.socialRequestItemId,
      results: live.current.results,
      inbox: live.current.inbox,
      toast: {
        pending: (title, detail) => toastPending(title, detail),
        success: (id, title, detail) => { toastSuccess(id, title, detail); },
        error: (id, title, detail) => { toastError(id, title, detail); },
      },
      showOutput,
      jobs,
      // G21: the rows the page in view rendered for this persona (pageContext.ts), never a second read.
      page: () => pageContextFor(window.location.pathname),
      // G49: the tabs the page in view published, for open { scope: 'this-page', tab }.
      tabs: () => pageTabsFor(window.location.pathname),
    }),
    // The page context note the voice gets on start, on navigation and after every tool result (G21).
    pageContext: () => {
      const path = window.location.pathname;
      return pageContextNote({ tenant: live.current.tenant, pathname: path, pageId: pageIdFor(PAGES, live.current.tenant, path), page: pageContextFor(path), tabs: pageTabsFor(path) });
    },
    // G33: this device's spoken length (Logging's "Short answers" switch on its Voice source), read at each session start.
    verbosity: voiceVerbosity,
    // G35: a dropped session's id for 60 s, and whether the page is hidden when the connection fails.
    resume: resumeStore,
    hidden: () => document.visibilityState === 'hidden',
    tenant: () => live.current.tenant,
  }), [showOutput, jobs]);
  controllerRef.current = controller;
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);

  // A tenant switch ends the session (§2: the tools' tenant is the mint's).
  const mintedTenant = useRef(session?.tenant);
  useEffect(() => {
    if (session?.tenant === mintedTenant.current) return;
    mintedTenant.current = session?.tenant;
    void controller.stop('tenant-switch');
  }, [controller, session?.tenant]);

  // Moving by hand, or the page showing its rows: the voice learns where the user is and what is on screen, silently (G21).
  useEffect(() => { controller.notePage(); }, [controller, pathname]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribePageContext(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; controller.notePage(); }, 250);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [controller]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isVoiceHotkey(e)) return;
      e.preventDefault();
      void controller.toggle();
    };
    // A closed tab stops billing: the close is sent with keepalive and the middleware hangs up (§7). The close says
    // which event it was (G35), and the session stays resumable for 60 s should the page come back.
    // beforeunload alone ends nothing (a cancelled leave, a download): it only names the pagehide that follows.
    let unloading = false;
    const onBeforeUnload = () => { unloading = true; setTimeout(() => { unloading = false; }, 1000); };
    const onPageHide = () => { void controller.stop('dropped', unloading ? 'beforeunload' : 'pagehide'); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [controller]);

  // G23: new notifications and direct messages reach the voice. The entries present at mount are the backlog, never announced.
  const notifications = useSharedNotificationsOptional();
  const seenNotes = useRef<Set<string> | null>(null);
  const noteList = notifications?.notifications;
  useEffect(() => {
    const list = noteList ?? [];
    if (!seenNotes.current) { seenNotes.current = new Set(list.map((n) => n.id)); return; }
    for (const n of list) {
      if (seenNotes.current.has(n.id)) continue;
      seenNotes.current.add(n.id);
      // The portal's own entries (a voice-queued job that ended, G19) are spoken by the job tracker already.
      if (n.read || getLocalNotifications().some((l) => l.id === n.id)) continue;
      const item = notificationItem(n, Date.now());
      if (inbox.add(item)) controller.noteInbound(item);
    }
  }, [noteList, inbox, controller]);
  const rosterNames = useRef(new Map<string, string>());
  rosterNames.current = new Map((socialPeople ?? []).map((p) => [p.id, p.name] as [string, string]));
  const listenGateway = gateway?.onMessage;
  useEffect(() => listenGateway?.((frame) => {
    // The sender's name from the shell's own Social roster when it knows them (sweep 6), never only the frame's.
    const item = messageFromFrame(frame, live.current.userId, Date.now(), (id) => rosterNames.current.get(id) ?? null);
    if (item && inbox.add(item)) controller.noteInbound(item);
  }), [listenGateway, inbox, controller]);

  // G44: the tenant switch announces itself before it reloads, so the session closes as a tenant switch, not a drop.
  useEffect(() => {
    const onSwitch = () => { void controller.stop('tenant-switch', 'tenant-switch'); };
    window.addEventListener(TENANT_SWITCH_EVENT, onSwitch);
    return () => window.removeEventListener(TENANT_SWITCH_EVENT, onSwitch);
  }, [controller]);

  // The on-device transcript keep (G20): the session's turns, saved under its id while the switch is on; never sent.
  const keep = useSyncExternalStore(subscribeKeepTranscripts, keepTranscripts, () => false);
  const keptStore = useMemo(() => transcriptStore(), []);
  useEffect(() => {
    const id = snap.sessionId;
    if (!keep || !id || !keptStore) return undefined;
    const save = () => { const turns = controller.sessionTurns(); if (turns.length) void keptStore.put(id, turns).catch(() => undefined); };
    if (snap.phase === 'ended') { save(); return undefined; }
    const t = setTimeout(save, KEEP_SAVE_MS);
    return () => clearTimeout(t);
  }, [keep, keptStore, controller, snap.sessionId, snap.turns, snap.phase]);

  // G26: CC toggles the strip inline above the dock (the library's `transcriptOpen`), never a popover.
  const [stripOpen, setStripOpen] = useState(false);
  const openLog = useCallback(() => { void navigate(voiceLogHref(snap.sessionId, { list: VOICE_LOG_PATH, session: sessionHref })); }, [navigate, snap.sessionId]);
  // G40: the who-may-answer line is the card's own `hint` (2.514.1); decide's `fields` hand back { decision, note }.
  const pending: VoicePending | null = snap.pending ? dockPending<VoiceConfirmResult>(snap.pending, {
    confirm: (result) => controller.confirm('click', result),
    cancel: () => controller.cancel('click'),
  }) : null;
  // open's ambiguous name (catalogue v2): the library's choice card, picked by click or by the number the user said
  // (the controller hears it and sets `ordinal`; the card chooses that row once and calls back here).
  const pendingChoice: VoicePendingChoice | null = snap.choice ? {
    title: snap.choice.title,
    requestId: snap.choice.requestId,
    candidates: snap.choice.candidates.map((c) => ({ ...c })),
    ...(snap.choice.ordinal ? { ordinal: snap.choice.ordinal } : {}),
    onChoose: (index) => controller.choose(index),
    onCancel: () => controller.cancelChoice(),
  } : null;
  const turns = snap.turns;
  return <Inline gap="xs" align="center" wrap={false} className="min-w-0 max-w-[30rem] shrink border-l border-border pl-2" data-testid="shell-footer-voice">
    <VoiceDock
      size="footer"
      phase={snap.phase}
      level={snap.level}
      outputLevel={snap.outputLevel}
      elapsedSeconds={snap.elapsedSeconds}
      pending={pending}
      pendingChoice={pendingChoice}
      lastLine={snap.lastLine}
      // G35: within 60 s of a drop the Start control resumes that session (the server links the two rows).
      startLabel={snap.resumable ? 'Resume' : 'Voice'}
      onStart={() => { void controller.start(snap.resumable ? { resume: true } : {}); }}
      onStop={() => { void controller.stop('closed'); }}
      onMute={() => controller.toggleMute()}
      muted={snap.muted}
      pulse={snap.pulse}
      {...dockTranscriptProps({
        open: stripOpen, toggle: () => setStripOpen((open) => !open), turns,
        keep, setKeep: (on) => { void setKeepTranscripts(on, keptStore); },
        openLog: VOICE_LOG_AVAILABLE && tenant === 'orgiq' ? openLog : null,
      })}
      {...(snap.reason ? { unavailableReason: snap.reason } : {})}
      className="min-w-0 flex-1"
      data-testid="shell-voice-dock"
    />
    {chatMount && session && <VoiceChatChannel key={`${chatMount.channel}#${chatMount.n}`} channel={chatMount.channel} userId={session.sub}
      displayName={social?.me?.displayName ?? session.name ?? session.sub} onReady={onReady} onFailed={onFailed} />}
  </Inline>;
}
