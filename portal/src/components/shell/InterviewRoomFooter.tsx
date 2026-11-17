// The interview's own elements in the shell footer (docs/interviews-tenant-plan.md decision 21, row I2.4), on the
// same model as a work call: the room page (pages/interviews/InterviewRoomPage.tsx) registers what the footer
// needs here; SocialFooter draws `InterviewRoomBarItems` in the call bar's extras (time left, what the candidate
// turned off, End interview for the lead) and `InterviewRoomAsks` in the footer's prompt deck beside Milo's
// asks (the candidate is waiting: Admit / Not yet; End interview: End it / Keep going). The quiet facts are chips
// with the full sentence as a tooltip, so the row stays one line at 1280. Nothing renders unless
// the shell's call is the registered interview's, so no other tenant's footer changes.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Button, Chip, Inline, T, Tooltip } from '@connorhoehn/ui-components/shared';
import { ComposerPromptDeck, useComposerPromptDeck, type ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { SUGGESTION_RECEIPTS, callTimeLabel, staffRoomNameFor, knockPromptId, miloAskReceipt, suggestionPromptId, timeLeftTone, type Admission, type ConsentChip, type MiloSaid, type SuggestionAnswerId, type SuggestionView } from '../../lib/interviewsRoom';

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
  answerSuggestion(suggestionId: string, answer: SuggestionAnswerId): Promise<{ error?: string; said?: MiloSaid }>;
}

// One registration at a time: the room page that is mounted.
let current: InterviewRoomFooterState | null = null;
let endAsked = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => current;
const askedSnapshot = () => endAsked;
const setEndAsked = (v: boolean) => { if (endAsked !== v) { endAsked = v; emit(); } };

/** The room page's registration: kept while it is mounted, cleared when it unmounts. */
export function useRegisterInterviewRoomFooter(state: InterviewRoomFooterState | null): void {
  useEffect(() => {
    current = state;
    emit();
  }, [state]);
  useEffect(() => () => { current = null; endAsked = false; emit(); }, []);
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

/** In the call bar's extras: time left, the consent chip, and the lead's End interview. */
export function InterviewRoomBarItems({ lobbyName, callStartedAt }: { lobbyName: string | null | undefined; callStartedAt: number | string | null | undefined }) {
  const room = useRoomFor(lobbyName);
  const now = useNow(15_000);
  const asked = useSyncExternalStore(subscribe, askedSnapshot, askedSnapshot);
  if (!room) return null;
  const left = callTimeLabel(callStartedAt, room.minutes, now);
  return <Inline gap="sm" align="center" wrap={false} data-testid="interview-room-bar">
    {left && <Chip size="sm" tone={timeLeftTone(left) === 'warning' ? 'warning' : 'neutral'} data-testid="interview-time-left">{left}</Chip>}
    {room.pausedLine && <Tooltip content={room.pausedLine} placement="top">
      <Chip size="sm" tone="neutral" aria-label={room.pausedLine} data-testid="interview-suggestions-paused">Suggestions paused</Chip>
    </Tooltip>}
    {room.consent && <Tooltip content={room.consent.tooltip} placement="top">
      <Chip size="sm" tone={room.consent.tone} aria-label={room.consent.tooltip} data-testid="interview-consent">{room.consent.label}</Chip>
    </Tooltip>}
    {room.lead && <Button size="sm" variant="secondary" onClick={() => setEndAsked(true)} disabled={asked} data-testid="interview-end">End interview</Button>}
  </Inline>;
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
      ...base, id: knockPromptId(room.interviewId, knock), kind: 'choice', eyebrow: 'Interview', title: 'The candidate is waiting',
      question: 'The candidate is waiting.',
      options: [{ id: 'admit', label: 'Admit', emphasis: 'primary' }, { id: 'not-yet', label: 'Not yet' }],
      onAnswer: async (a) => {
        const admit = 'optionId' in a && a.optionId === 'admit';
        const out = await room.answerKnock(admit);
        if (out.error) return { error: out.error };
        return { receipt: admit ? 'Admitted' : 'Not yet' };
      },
    });
    const sg = room.lead ? room.suggestion : null;
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
        return { receipt: answer === 'milo-ask' ? miloAskReceipt(out.said) : SUGGESTION_RECEIPTS[answer] };
      },
    });
    return list;
  }, [room, scope, asked, knock, room?.suggestion]);
  const deck = useComposerPromptDeck(prompts, { scope });
  // A new knock asks again even after Esc hid the deck.
  const knockId = room && knock ? knockPromptId(room.interviewId, knock) : null;
  useEffect(() => { if (knockId && deck.collapsed) deck.setCollapsed(false); }, [knockId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc hides a suggestion without answering; the next one comes back.
  const suggestionId = room?.lead ? room.suggestion?.id ?? null : null;
  useEffect(() => { if (suggestionId && deck.collapsed) deck.setCollapsed(false); }, [suggestionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc on the End question is "Keep going".
  useEffect(() => { if (deck.collapsed && asked) { setEndAsked(false); deck.setCollapsed(false); } }, [deck, asked]);
  if (!room || !deck.active || deck.collapsed) return null;
  // The compact form (plain buttons, no key-hint row, facts on one line each): the room's pad and its output keep their height at 1280.
  return <ComposerPromptDeck deck={deck} presentation="prompt" className="mx-4 my-1" data-testid="interview-room-ask" />;
}
