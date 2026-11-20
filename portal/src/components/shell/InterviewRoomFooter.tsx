// The interview's own elements in the shell footer (docs/interviews-tenant-plan.md decision 21, row I2.4), on the
// same model as a work call: the room page (pages/interviews/InterviewRoomPage.tsx) registers what the footer
// needs here; SocialFooter hands `useInterviewRoomBarActions` to the call bar as its actions (time left, what the
// candidate turned off, the last answer's receipt, End interview for the lead) and draws `InterviewRoomAsks` in the
// footer's prompt deck beside Milo's asks (the candidate is waiting: Admit / Not yet; End interview: End it / Keep
// going). The footer is one row at every width: each action has a priority, and the bar moves the lowest into its
// More menu when the row is short (the order is BAR_PRIORITY below). Nothing renders unless the shell's call is the
// registered interview's, so no other tenant's footer changes.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button, Chip, Inline, T, Tooltip } from '@connorhoehn/ui-components/shared';
import type { HuddleBarAction } from '@connorhoehn/ui-components/video';
import { ComposerPromptDeck, useComposerPromptDeck, type ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { SUGGESTION_RECEIPTS, callTimeLabel, escSkipsSuggestion, joinedInterviewOf, roomHref, staffRoomNameFor, knockPromptId, miloAskReceipt, suggestionForPrompt, suggestionPromptId, timeLeftTone, type Admission, type ConsentChip, type MiloAsked, type MiloAskWhy, type SuggestionAnswerId, type SuggestionView } from '../../lib/interviewsRoom';
import { useCallHost } from '../../lib/conversationCall';
import { useFetch } from '../../hooks/useFetch';
import { INTERVIEWS_API } from '../../lib/interviews';
import { issueInvite, roomLinkControl, type InviteStatus } from '../../lib/interviewsUpcoming';
import { hasJoinedCall } from './callShellModel';
import { introduceMilo, miloSettingsPath, type MiloSettingsView } from '../../lib/interviewsMilo';

export interface InterviewRoomFooterState {
  interviewId: string;
  lobbyName: string;
  lead: boolean;
  /** The candidate's name, for the call's tiles (the call knows them only by the invite's id). */
  candidateName: string;
  minutes: number;
  /** What the candidate answered (C4) as a chip: not answered yet, or what is off; null shows nothing. */
  consent: ConsentChip | null;
  /** Why the lead may not invite Milo by the candidate's answers (lib/interviewsRoom.ts `miloInviteBlock`); null: Invite as in a work call. */
  miloBlock: { label: string; tooltip: string } | null;
  /** C3's answer for the lead; null: nobody waiting (or the route is not there). */
  admission: Admission | null;
  end(): Promise<{ error?: string }>;
  answerKnock(admit: boolean): Promise<{ error?: string }>;
  /** D7: Milo's suggestion waiting for the lead; null for everyone else and when none is waiting. */
  suggestion: SuggestionView | null;
  /** The quiet line when the budget paused suggestions (the lead's only; null otherwise). */
  pausedLine: string | null;
  /** `said` (Have Milo ask): aloud, or in the call chat only (row I3.5). */
  answerSuggestion(suggestionId: string, answer: SuggestionAnswerId): Promise<{ error?: string; said?: MiloAsked; why?: MiloAskWhy }>;
}

// One registration at a time: the room page that is mounted.
let current: InterviewRoomFooterState | null = null;
let endAsked = false;
// The last answered prompt's receipt ("You will ask it", "Admitted"): a chip in the bar, never a row above it.
let receipt: string | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => current;
const askedSnapshot = () => endAsked;
const setEndAsked = (v: boolean) => { if (endAsked !== v) { endAsked = v; emit(); } };
const receiptSnapshot = () => receipt;
const setReceipt = (v: string | null) => { if (receipt !== v) { receipt = v; emit(); } };

/**
 * Which of the call bar's items stay on the row longest (higher stays; the library's own sit at chat 60, share 50,
 * media 40, meeting 30). When the row is short they move into the bar's More menu from the lowest up: device
 * settings, the candidate link, Introduce Milo, the quiet chips, the receipt, time left, then Message, and last the
 * connection error, End interview, Open the room and Rejoin. Microphone, camera and Leave never move.
 */
export const BAR_PRIORITY = {
  rejoin: 90, openRoom: 85, end: 80, error: 75, timeLeft: 55, receipt: 45, consent: 35, paused: 25, intro: 20, link: 15, devices: 5,
} as const;

/** The room page's registration: kept while it is mounted, cleared when it unmounts. */
export function useRegisterInterviewRoomFooter(state: InterviewRoomFooterState | null): void {
  useEffect(() => {
    current = state;
    emit();
  }, [state]);
  useEffect(() => () => { current = null; endAsked = false; receipt = null; emit(); }, []);
}

/** The registration, only while the shell's call is that interview's. */
function useRoomFor(lobbyName: string | null | undefined): InterviewRoomFooterState | null {
  const room = useSyncExternalStore(subscribe, snapshot, snapshot);
  return room && lobbyName && room.lobbyName === lobbyName ? room : null;
}

function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(t);
  }, [stepMs]);
  return now;
}

/**
 * Whose interview call this is to the viewer, for Milo's bar controls (row I3.5): `lead` keeps them exactly as a work call shows
 * them; `panel` gets none of the lead's (the server refuses everyone but the lead, milo-policy.ts LEAD_ONLY); null: not an
 * interview call, so nothing changes.
 */
export function useInterviewRoomSeat(lobbyName: string | null | undefined): 'lead' | 'panel' | null {
  const room = useRoomFor(lobbyName);
  return room ? (room.lead ? 'lead' : 'panel') : null;
}

/**
 * The shell call host's directory while an interview room is mounted: the candidate's tile reads their name instead of the
 * invite's id. With no room registered the directory comes back as it is (the same reference), so no other call changes.
 */
export function useInterviewRoomNameFor<F extends (userId: string) => { displayName: string; avatarUrl?: string } | null | undefined>(base: F): F {
  const room = useSyncExternalStore(subscribe, snapshot, snapshot);
  const candidateName = room?.candidateName ?? null;
  return useMemo(() => (candidateName === null ? base : staffRoomNameFor(base, candidateName) as F), [base, candidateName]);
}

/** Why Milo may not be invited into this interview call by the candidate's answers; null for any other call (nothing changes there). */
export function useInterviewRoomMiloBlock(lobbyName: string | null | undefined): { label: string; tooltip: string } | null {
  return useRoomFor(lobbyName)?.miloBlock ?? null;
}

// The links the lead made in this tab, by interview: a link is answered once, so leaving the room and coming back keeps it.
const madeLinks = new Map<string, string>();

/** The lead's "Make candidate link" / "Copy candidate link", while the candidate is not in yet (rows I2.1 and I3.x); null: nothing to offer. */
function useCandidateLinkAction(interviewId: string | null, candidateName: string): HuddleBarAction | null {
  const { data, refresh } = useFetch<{ invite: InviteStatus }>(interviewId ? `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/invite` : null);
  const [made, setMade] = useState<string | null>(null);
  const link = interviewId ? made ?? madeLinks.get(interviewId) ?? null : null;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const control = interviewId ? roomLinkControl(data?.invite ?? null, link !== null) : null;
  if (!interviewId || !control) return null;
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNote({ text: 'Copied', error: false }); }
    catch { setNote({ text: 'Copy failed: select the link from the tooltip', error: true }); }
  };
  const make = async () => {
    setBusy(true); setNote(null);
    const out = await issueInvite(interviewId);
    setBusy(false);
    if (!out.ok) { setNote({ text: out.error, error: true }); return; }
    madeLinks.set(interviewId, out.link);
    setMade(out.link);
    refresh();
    await copy(out.link);
  };
  const copying = control.kind === 'copy' && link !== null;
  if (!copying && control.kind !== 'make') return null;
  return {
    id: 'candidate-link', priority: BAR_PRIORITY.link,
    node: <Inline gap="xs" align="center" wrap={false} data-testid="interview-candidate-link">
      {copying
        ? <Tooltip content={`${link} (shown only in this tab; a new link stops it working)`} placement="top">
          <Button size="sm" variant="secondary" aria-label={`Copy ${candidateName}'s link`} onClick={() => void copy(link)} data-testid="interview-candidate-link-copy">Copy candidate link</Button>
        </Tooltip>
        : control.kind === 'make' && <Tooltip content={control.hint} placement="top">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void make()} data-testid="interview-candidate-link-make">{busy ? 'Making…' : control.label}</Button>
        </Tooltip>}
      {note && <T size="xs" tone={note.error ? 'danger' : 'secondary'} role={note.error ? 'alert' : 'status'} className="whitespace-nowrap" data-testid="interview-candidate-link-note">{note.text}</T>}
    </Inline>,
    menu: copying
      ? { label: 'Copy candidate link', ...(note ? { description: note.text } : {}), onSelect: () => void copy(link) }
      : { label: busy ? 'Making…' : control.kind === 'make' ? control.label : 'Candidate link', description: note?.text ?? (control.kind === 'make' ? control.hint : undefined), disabled: busy, onSelect: () => void make() },
  };
}

/** The interview whose call this viewer has joined, or null (the desk's and the upcoming table's "Back to the call"). */
export function useJoinedInterviewCall(): string | null {
  const host = useCallHost();
  return joinedInterviewOf(host?.lobby?.lobbyName, !!host && hasJoinedCall(host.call.call, host.call.phase));
}

/**
 * Among the docked call's actions, beside Leave: the way back to the room while the viewer is in an interview's call on any
 * other page. It only navigates; the call is already joined. Null on the room itself and in any other call.
 */
export function useInterviewRoomReturnAction(lobbyName: string | null | undefined, joined: boolean): HuddleBarAction | null {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const id = joinedInterviewOf(lobbyName, joined);
  if (!id || pathname === roomHref(id)) return null;
  const open = () => void navigate(roomHref(id));
  return {
    id: 'interview-open-room', priority: BAR_PRIORITY.openRoom,
    node: <Button size="sm" variant="secondary" onClick={open} data-testid="interview-open-room">Open the room</Button>,
    menu: { label: 'Open the room', onSelect: open },
  };
}

/**
 * The lead's "Introduce Milo": Milo says its fixed introduction once an interview, on the approved speaking path (the server
 * refuses a second one). The lead may also just say it ("Milo, introduce yourself").
 */
function useMiloIntroAction(interviewId: string | null): HuddleBarAction | null {
  const { data, refresh } = useFetch<MiloSettingsView>(interviewId ? miloSettingsPath(interviewId) : null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  if (!interviewId || !data) return null;
  const done = data.introduced;
  const press = async () => {
    setBusy(true); setNote(null);
    const out = await introduceMilo(interviewId);
    setBusy(false);
    setNote(out.ok ? { text: out.line, error: false } : { text: out.error, error: true });
    refresh();
  };
  const label = done ? 'Milo introduced' : 'Introduce Milo';
  return {
    id: 'milo-intro', priority: BAR_PRIORITY.intro,
    // What Milo said (or why it could not) is the button's tooltip and the menu row's second line: a sentence beside the button made the row grow.
    node: <Tooltip content={note?.text ?? 'Milo says its introduction aloud, once an interview'} placement="top">
      <Button size="sm" variant="secondary" disabled={busy || done} onClick={() => void press()} data-testid="interview-milo-intro" data-note={note?.text ?? ''} data-note-error={note ? String(note.error) : ''}>{label}</Button>
    </Tooltip>,
    menu: { label, ...(note ? { description: note.text } : {}), disabled: busy || done, onSelect: () => void press() },
  };
}

/** The call bar's actions for the room: time left, the consent chip, the last answer's receipt, the lead's link, Introduce Milo and End interview. */
export function useInterviewRoomBarActions(lobbyName: string | null | undefined, callStartedAt: number | string | null | undefined): HuddleBarAction[] {
  const room = useRoomFor(lobbyName);
  const now = useNow(15_000);
  const asked = useSyncExternalStore(subscribe, askedSnapshot, askedSnapshot);
  const answered = useSyncExternalStore(subscribe, receiptSnapshot, receiptSnapshot);
  const link = useCandidateLinkAction(room?.lead && room.admission?.state !== 'admitted' ? room.interviewId : null, room?.candidateName ?? '');
  const intro = useMiloIntroAction(room?.lead ? room.interviewId : null);
  if (!room) return [];
  const left = callTimeLabel(callStartedAt, room.minutes, now);
  const said = answered ? `Answered · ${answered}` : null;
  return [
    ...(left ? [{ id: 'interview-time-left', priority: BAR_PRIORITY.timeLeft, fact: left,
      node: <Chip size="sm" tone={timeLeftTone(left) === 'warning' ? 'warning' : 'neutral'} data-testid="interview-time-left">{left}</Chip> }] : []),
    ...(room.pausedLine ? [{ id: 'interview-suggestions-paused', priority: BAR_PRIORITY.paused, fact: room.pausedLine,
      node: <Tooltip content={room.pausedLine} placement="top">
        <Chip size="sm" tone="neutral" aria-label={room.pausedLine} data-testid="interview-suggestions-paused">Suggestions paused</Chip>
      </Tooltip> }] : []),
    ...(room.consent ? [{ id: 'interview-consent', priority: BAR_PRIORITY.consent, fact: room.consent.tooltip,
      node: <Tooltip content={room.consent.tooltip} placement="top">
        <Chip size="sm" tone={room.consent.tone} aria-label={room.consent.tooltip} data-testid="interview-consent">{room.consent.label}</Chip>
      </Tooltip> }] : []),
    // What the lead last answered, where the row above the bar used to say it (the owner, 20 November: the footer is one row).
    ...(said ? [{ id: 'interview-receipt', priority: BAR_PRIORITY.receipt, fact: said,
      node: <Tooltip content={said} placement="top">
        <Chip size="sm" tone="neutral" aria-label={said} data-testid="interview-room-receipt">{said}</Chip>
      </Tooltip> }] : []),
    ...(link ? [link] : []),
    ...(intro ? [intro] : []),
    ...(room.lead ? [{ id: 'interview-end', priority: BAR_PRIORITY.end,
      node: <Button size="sm" variant="secondary" onClick={() => setEndAsked(true)} disabled={asked} data-testid="interview-end">End interview</Button>,
      menu: { label: 'End interview', disabled: asked, onSelect: () => setEndAsked(true) } }] : []),
  ];
}

/** The footer's prompt deck for the room: the waiting candidate, and the End interview confirm. */
export function InterviewRoomAsks({ lobbyName }: { lobbyName: string | null | undefined }) {
  const room = useRoomFor(lobbyName);
  const asked = useSyncExternalStore(subscribe, askedSnapshot, askedSnapshot);
  const scope = room ? `interview-room:${room.interviewId}` : null;
  const knock = room?.lead && room.admission?.state === 'waiting' ? room.admission : null;
  const prompts = useMemo<ComposerPrompt[]>(() => {
    if (!room || !scope) return [];
    const base = { scope, keypad: 'deck' as const, focusOnArrive: false };
    const list: ComposerPrompt[] = [];
    if (asked && room.lead) list.push({
      ...base, id: `${scope}:end`, kind: 'choice', eyebrow: 'Interview', title: 'End the interview',
      question: 'End the interview for everyone? The call closes and the panel can write their scorecards.',
      options: [{ id: 'end', label: 'End interview', emphasis: 'primary' }, { id: 'keep', label: 'Keep going' }],
      onAnswer: async (a) => {
        if (!('optionId' in a) || a.optionId !== 'end') { setEndAsked(false); return { receipt: 'Kept going' }; }
        const out = await room.end();
        if (out.error) return { error: out.error };
        setEndAsked(false);
        return { receipt: 'Ended' };
      },
    });
    if (knock) list.push({
      ...base, id: knockPromptId(room.interviewId, knock), kind: 'choice', eyebrow: 'Interview', title: `${room.candidateName} is waiting`,
      question: 'Let them in?',
      options: [{ id: 'admit', label: 'Admit', emphasis: 'primary' }, { id: 'not-yet', label: 'Not yet' }],
      onAnswer: async (a) => {
        const admit = 'optionId' in a && a.optionId === 'admit';
        const out = await room.answerKnock(admit);
        if (out.error) return { error: out.error };
        return { receipt: admit ? 'Admitted' : 'Not yet' };
      },
    });
    const sg = suggestionForPrompt(room.lead, room.suggestion);
    if (sg) list.push({
      ...base, id: suggestionPromptId(room.interviewId, sg.id), kind: 'choice', eyebrow: 'Milo suggests', title: sg.competency.name,
      question: sg.text,
      // "Based on" is one line (the prompt presentation clamps it); the whole quote is its tooltip, one hover or focus away.
      ...(sg.basedOn ? { fields: [{ label: 'Based on', value: <Tooltip content={sg.basedOn} placement="top">
        <T size="xs" tone="secondary" truncate title={sg.basedOn} data-testid="interview-suggestion-based-on">{sg.basedOn}</T>
      </Tooltip>, tone: 'neutral' as const }] } : {}),
      options: [{ id: 'ask', label: 'I’ll ask it', emphasis: 'primary' }, { id: 'milo-ask', label: 'Have Milo ask' }, { id: 'skip', label: 'Skip' }],
      onAnswer: async (a) => {
        const answer: SuggestionAnswerId = 'optionId' in a && (a.optionId === 'milo-ask' || a.optionId === 'skip') ? a.optionId : 'ask';
        const out = await room.answerSuggestion(sg.id, answer);
        if (out.error) return { error: out.error };
        return { receipt: answer === 'milo-ask' ? miloAskReceipt(out.said, out.why) : SUGGESTION_RECEIPTS[answer] };
      },
    });
    return list;
  }, [room, scope, asked, knock, room?.suggestion]);
  const deck = useComposerPromptDeck(prompts, { scope });
  // A new knock asks again even after Esc hid the deck.
  const knockId = room && knock ? knockPromptId(room.interviewId, knock) : null;
  useEffect(() => { if (knockId && deck.collapsed) deck.setCollapsed(false); }, [knockId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc on a suggestion is a Skip (escSkipsSuggestion): the server lets it go and the next one comes back by itself.
  const suggestionId = room?.lead ? room.suggestion?.id ?? null : null;
  const skippedByEsc = useRef<string | null>(null);
  // Only on the Esc itself (the deck collapsing), so a suggestion that arrives later is never skipped unseen; the deck opens again
  // once it is sent, so nothing else waits behind a hidden deck.
  useEffect(() => {
    const skip = escSkipsSuggestion(deck.collapsed, suggestionId, skippedByEsc.current);
    if (!skip || !room) return;
    skippedByEsc.current = skip;
    void room.answerSuggestion(skip, 'skip').finally(() => deck.setCollapsed(false));
  }, [deck.collapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (suggestionId && deck.collapsed) deck.setCollapsed(false); }, [suggestionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc on the End question is "Keep going".
  useEffect(() => { if (deck.collapsed && asked) { setEndAsked(false); deck.setCollapsed(false); } }, [deck, asked]);
  // An answered prompt leaves the list (a suggestion answered is gone from the room). Its receipt ("Milo asked it aloud",
  // "Admitted") is a chip in the call bar (useInterviewRoomBarActions), not the deck's answered row: with no question
  // waiting, nothing is drawn above the footer's row.
  const lastReceipt = room && !deck.active ? deck.receipt : null;
  useEffect(() => { setReceipt(lastReceipt); }, [lastReceipt]);
  if (!room || !deck.active || deck.collapsed) return null;
  // The compact form (plain buttons, no key-hint row, facts on one line each): the room's pad and its output keep their height at 1280.
  return <ComposerPromptDeck deck={deck} presentation="prompt" className="mx-4 my-1" data-testid="interview-room-ask" />;
}
