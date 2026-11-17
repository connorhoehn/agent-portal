// The call assistant in the shell (docs/meeting-assistant-design.md, decisions 8 and 13):
//   AssistantBarControls  Invite Milo, the "Milo is listening" mark, Pause/Resume and Dismiss — the HuddleBar's `extras`. The mark says
//                    what Milo is doing ("Milo is looking that up for Una"), whether it can hear the call, and its voice on a chip.
//   AssistantBudgetAsk    the questions asked above the footer row as deck prompts: an over-budget refusal, and "Dismiss Milo for everyone"
//   AssistantConsentNotice       the transcription notice for someone who has not acknowledged, above the footer row
//   useAssistantRosterEntry  the "Milo (Assistant, listening)" line for the call's people lists
// Everything renders nothing unless the server advertises the feature (session.meetingAssistant) and a call is live.

import { Badge, Button, CheckIcon, Chip, CloseIcon, DocumentIcon, DropdownMenu, InlinePopover, Inline, PauseCircleIcon, PlayCircleIcon, PlusCircleIcon, T, Tooltip } from '@connorhoehn/ui-components/shared';
import { RecordingConsentNotice, SpeakerIcon, type RosterExtraEntry } from '@connorhoehn/ui-components/video';
import { ComposerPromptDeck, type ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useMemo, useRef, useState } from 'react';
import { useAssistantVoice } from '../../lib/assistantVoice';
import { soundPromptShown } from '../../lib/assistantVoiceModel';
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import {
  assistantPresent, assistantStateWords, dismissQuestion, extendWords, inviteAgainLabel, leftWords, markWords, myWaitingActions, rejoinRefusedWords, standingFacts, timeLeftWords, noticeText, noticeVisible, rosterEntry, voiceWords,
  ASSISTANT_LABEL, ASSISTANT_NAME, DISMISS_LABEL, INVITE_HINT,
} from '../../lib/meetingAssistantModel';
import { proposalCountWords, waitingCount } from '../../lib/meetingProposals';
import { useHuddleChat, useHuddleChatToggle } from './HuddleChat';
import { useComposerFocus } from '@connorhoehn/ui-components/social/rich-composer';
import { setLiveTranscript, useLiveTranscriptOn } from '../../lib/liveTranscript';
import { LIVE_HIDE_LABEL, LIVE_SHOW_DESCRIPTION, LIVE_SHOW_LABEL } from '../../lib/liveTranscriptModel';
import { useLiveCallId } from '../../lib/liveCallId';
import { useProposalQueue } from './AssistantProposalAsk';
import { setProposalDeckHidden } from '../../lib/proposalDeckState';
import { hideAssistantNotice, noticeKey, useAssistantNoticeHidden } from '../../lib/assistantNoticeHidden';
import { useCallHost } from '../../lib/conversationCall';
import { useInterviewRoomSeat } from './InterviewRoomFooter';

export { useLiveCallId };

/** "1 card waiting for you" / "1 proposal" / both, for the footer count; null when nothing waits on this person. */
export function waitingWords(cards: number, proposals: number): string | null {
  const parts = [cards > 0 ? `${cards} ${cards === 1 ? 'card' : 'cards'} waiting for your confirmation` : null, proposalCountWords(proposals)].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Brings a waiting card into view: the live transcript gives the pane back to the chat (it hides the thread but keeps it mounted),
 * the chat opens (it may be closed), then the card scrolls in and its Confirm takes the focus. A card inside a hidden ancestor is
 * not found, so the transcript never swallows the click.
 */
function jumpToCard(callId: string, actionId: string, openChat: (() => void) | null): void {
  const selector = `[data-testid="assistant-action-card"][data-action-id="${CSS.escape(actionId)}"]`;
  const visible = (el: HTMLElement) => !el.closest('[hidden]') && el.getClientRects().length > 0;
  const find = () => { const el = document.querySelector<HTMLElement>(selector); return el && visible(el) ? el : null; };
  const go = (tries: number) => {
    const card = find();
    if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.querySelector<HTMLElement>('[data-testid="assistant-action-confirm"]')?.focus({ preventScroll: true }); return; }
    if (tries > 0) setTimeout(() => go(tries - 1), 150);
  };
  const mounted = !!document.querySelector(selector);
  setLiveTranscript(callId, false);
  if (!mounted) openChat?.();
  go(10);
}

export function AssistantBarControls() {
  const callId = useLiveCallId();
  const assistant = useMeetingAssistant(callId);
  // An interview call (row I3.5): the lead keeps every control a work call shows; a panel member gets none of the lead's (the
  // server refuses them anyway, LEAD_ONLY) and keeps the mark, Acknowledge and Mute for me. Any other call: unchanged.
  const panelSeat = useInterviewRoomSeat(useCallHost()?.lobby?.lobbyName) === 'panel';
  const { view, busy } = assistant;
  const controls = panelSeat ? { ...assistant.controls, invite: false, pause: false, resume: false, dismiss: false, extend: false, inviteAgain: false } : assistant.controls;
  const canSetVoice = assistant.canSetVoice && !panelSeat;
  const noticeClosed = useAssistantNoticeHidden(noticeKey(callId, view.period));
  const voice = useAssistantVoice(callId, assistant.view);
  const errorRef = useRef<HTMLButtonElement | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  // Only proposals that wait on this person count; a bystander's optional prompt is in the deck but not in the badge.
  const owed = waitingCount(useProposalQueue().queue);
  const chat = useHuddleChatToggle({ behavior: 'focus' });
  const huddle = useHuddleChat();
  const focus = useComposerFocus();
  const transcriptOn = useLiveTranscriptOn(callId);
  // Nothing is drawn until the first state read answers: no "Invite Milo" while Milo may already be here.
  if (controls.hidden || view.phase === 'loading') return null;
  const cards = myWaitingActions(view);
  const waiting = waitingWords(cards.length, owed);
  const state = assistantStateWords(view);
  const markBase = markWords(view, noticeClosed);
  const words = markBase === `${ASSISTANT_NAME} is listening` && voice.speaking ? `${ASSISTANT_NAME} is speaking` : markBase;
  const voiceMenu = assistantPresent(view);
  const voiceChip = voiceWords(view, voice.muted);
  const facts = standingFacts(view);
  const left = timeLeftWords(view);
  const extend = extendWords(view, assistant.youInvited);
  // Before any reply: as soon as the voice is on and the browser still waits for a click (unless this person muted Milo).
  const soundPrompt = soundPromptShown({ present: !!words && !controls.left, voiceOn: view.voice, muted: voice.muted, needsGesture: voice.needsGesture });
  // Someone who cannot invite, with no Milo in the call, gets no bar at all (not an empty ruled slot).
  if (!controls.invite && !(state && controls.left) && !(words && !controls.left) && !soundPrompt && !assistant.error && !waiting) return null;
  const why = controls.left ? `${leftWords(view)}.` : null;
  // A standing reason Milo can never come back to this call (its record was deleted, the call's listening time is used up) goes in the tooltip.
  const refused = controls.left ? rejoinRefusedWords(view) : null;
  return <Inline gap="xs" align="center" wrap={false} className="shrink-0 border-l border-border pl-2" data-testid="assistant-bar">
    {controls.invite && <Tooltip content={INVITE_HINT} placement="top">
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void assistant.invite()} data-testid="assistant-invite">Invite {ASSISTANT_NAME}</Button>
    </Tooltip>}
    {/* One compact control keeps the dense bar on a line: the state in words is the trigger; acknowledge, pause or resume, extend and dismiss are its menu. */}
    {/* After Milo left, ONE control keeps the footer on its line: for people who may invite it back, "Invite Milo again" with why it left
        (who dismissed it, its time limit, a lost connection) as its tooltip; otherwise one quiet chip saying why, and why it cannot come back. */}
    {controls.inviteAgain && why ? <Tooltip content={why} placement="top" data-testid="assistant-left-why">
      <Button variant="secondary" size="sm" className="whitespace-nowrap" disabled={busy} onClick={() => void assistant.invite()} data-testid="assistant-invite-again"
        data-why={why} data-left-by={view.leftBy === 'system' ? 'system' : view.leftBy ? 'person' : ''} data-leaving={String(view.leaving)}>{inviteAgainLabel(view, busy)}</Button>
    </Tooltip> : state && controls.left && why && <Tooltip content={refused ? `${why} ${refused}` : why} placement="top" data-testid="assistant-left-why">
      <Chip size="xs" tone="neutral" className="whitespace-nowrap" aria-label={refused ? `${why} ${refused}` : why} data-testid="assistant-left" data-left-by={view.leftBy === 'system' ? 'system' : view.leftBy ? 'person' : ''} data-rejoin={view.rejoin ?? ''}>{why}</Chip>
    </Tooltip>}
    {words && !controls.left && <DropdownMenu align="end" triggerVariant="secondary" triggerClassName="px-2" triggerLabel={`${words}${left ? `, ${left}` : ''}${view.voice ? `, ${ASSISTANT_NAME}'s voice is on${voice.muted ? ', muted for you' : ''}` : ''}. Acknowledge, pause, extend or dismiss ${ASSISTANT_NAME}`} triggerTestId="assistant-status-mark"
      triggerAttributes={{ 'data-phase': view.phase, 'data-hearing': view.hearing, 'data-working': String(view.openRequests.length), 'data-voice': String(view.voice), 'data-voice-muted': String(voice.muted), 'data-voice-speaking': String(voice.speaking), 'data-voice-frames': String(voice.framesPlayed), 'data-voice-ignored': String(voice.framesIgnored), 'data-voice-last-seq': String(voice.lastSeq), 'data-must-ack': String(controls.acknowledge), ...(left ? { 'data-time-left': left } : {}) }} disabled={busy} data-testid="assistant-menu"
      trigger={<T size="xs" weight="medium" className="whitespace-nowrap">{words}{left ? ` · ${left}` : ''}</T>}
      sections={[...(facts.length ? [{ label: `${ASSISTANT_NAME} in this call`, items: [], caption: facts.join('. ') + '.', 'data-testid': 'assistant-facts' }] : []), { items: [
        ...(controls.acknowledge ? [{ label: 'Acknowledge', description: `${ASSISTANT_NAME} cannot hear you until you do`, icon: <CheckIcon size={14} />, onSelect: () => void assistant.acknowledge() }] : []),
        ...(controls.pause ? [{ label: `Pause ${ASSISTANT_NAME}`, icon: <PauseCircleIcon size={14} />, onSelect: () => void assistant.pause() }] : []),
        ...(controls.resume ? [{ label: `Resume ${ASSISTANT_NAME}`, icon: <PlayCircleIcon size={14} />, onSelect: () => void assistant.resume() }] : []),
        ...(voiceMenu && canSetVoice ? [{ label: view.voice ? `Turn ${ASSISTANT_NAME}'s voice off` : `Turn ${ASSISTANT_NAME}'s voice on`, description: view.voice ? `${ASSISTANT_NAME}'s voice is on in this call` : `${ASSISTANT_NAME} answers aloud when asked`, icon: <SpeakerIcon size={14} />, onSelect: () => void assistant.setVoice(!view.voice) }] : []),
        ...(voiceMenu ? [{ label: voice.muted ? `Unmute ${ASSISTANT_NAME} for me` : `Mute ${ASSISTANT_NAME} for me`, description: 'Only for you, in this call', icon: <SpeakerIcon size={14} />, onSelect: () => voice.setMuted(!voice.muted) }] : []),
        // What one extend buys and whose budget holds it; not offered at the call's hard maximum (controls.extend).
        ...(controls.extend ? [{ label: 'Extend time', ...(extend ? { description: extend } : left ? { description: left } : {}), icon: <PlusCircleIcon size={14} />, onSelect: () => void assistant.extend() }] : []),
        // The live transcript: the call's pane opens (as Message opens it) on what Milo is hearing; again, back to the chat.
        ...(callId && (view.phase === 'listening' || view.phase === 'paused') ? [{ label: transcriptOn ? LIVE_HIDE_LABEL : LIVE_SHOW_LABEL, ...(transcriptOn ? {} : { description: LIVE_SHOW_DESCRIPTION }),
          icon: <DocumentIcon size={14} />, onSelect: () => {
            setLiveTranscript(callId, !transcriptOn);
            if (!transcriptOn && huddle?.openPane({ focus: false })) focus.request({ mode: 'chat', target: { kind: 'huddle' } });
          } }] : []),
        ...(controls.dismiss ? [{ label: DISMISS_LABEL, icon: <CloseIcon size={14} />, danger: true, onSelect: () => assistant.askDismiss() }] : []),
      ] }]} />}
    {/* Milo's voice, seen without opening the menu: on for the call, or muted by this person. */}
    {voiceChip && !controls.left && <Chip size="xs" tone={voice.muted ? 'neutral' : 'info'} icon={<SpeakerIcon size={12} />} data-testid="assistant-voice-chip">{voiceChip}</Chip>}
    {/* What waits on this person: change cards to confirm (they expire) and proposals to answer. The cards come first: the badge
        jumps to the soonest-expiring one; with none, it reopens the proposal deck that Esc hid. A count badge, with the words as its
        name and tooltip, keeps the footer on one line at 1280 with three people in the call. */}
    {waiting && callId && <Tooltip content={waiting} placement="top">
      <Button variant="ghost" size="sm" className="px-1" aria-label={waiting} data-cards={cards.length} data-proposals={owed}
        onClick={() => { if (cards[0]) jumpToCard(callId, cards[0].actionId, chat?.toggle ?? null); else setProposalDeckHidden(callId, false); }} data-testid="assistant-proposal-count">
        <Badge variant="count" value={cards.length + owed} color="accent" aria-label={waiting} />
      </Button>
    </Tooltip>}
    {soundPrompt && <Button variant="ghost" size="sm" onClick={() => void voice.enableSound()} data-testid="assistant-enable-sound">Click to hear {ASSISTANT_NAME}</Button>}
    {/* The refusal sentence is read in full in a popover; the row keeps one short line. */}
    {assistant.error && <>
      <Button ref={errorRef} variant="ghost" size="sm" className="max-w-[12rem] truncate text-danger" onClick={() => setErrorOpen((v) => !v)} aria-expanded={errorOpen} title={assistant.error} data-testid="assistant-error">{assistant.error}</Button>
      <InlinePopover trigger={errorRef} open={errorOpen} onClose={() => setErrorOpen(false)} placement="top-end" className="max-w-sm p-3" aria-label={`Why ${ASSISTANT_NAME} could not do that`} data-testid="assistant-error-full">
        <T size="sm" tone="danger" wrap role="alert" data-testid="assistant-error-text">{assistant.error}</T>
      </InlinePopover>
    </>}
  </Inline>;
}

/** The server's over-budget refusal, asked as a deck prompt above the footer row (no dialog): the refusal sentence, then Go ahead or Cancel. */
export function AssistantBudgetAsk() {
  const callId = useLiveCallId();
  const assistant = useMeetingAssistant(callId);
  const { ask, answerAsk, confirmingDismiss, answerDismiss } = assistant;
  const prompts = useMemo<ComposerPrompt[]>(() => ask ? [{
    id: `assistant-budget:${callId}:${ask.action}:${ask.detail}`, scope: `assistant-budget:${callId}`, kind: 'choice', eyebrow: ASSISTANT_NAME, title: ask.title,
    question: ask.detail,
    options: [{ id: 'go', label: 'Go ahead', emphasis: 'primary' }, { id: 'cancel', label: 'Cancel' }],
    onAnswer: async (a) => { await answerAsk('optionId' in a && a.optionId === 'go'); },
  }] : [], [ask, callId, answerAsk]);
  // Dismissing is for everyone, so it is asked once, naming that effect. Esc or Cancel keeps Milo.
  const dismissPrompts = useMemo<ComposerPrompt[]>(() => confirmingDismiss ? [{
    id: `assistant-dismiss:${callId}`, scope: `assistant-dismiss:${callId}`, kind: 'choice', eyebrow: ASSISTANT_NAME, title: `${DISMISS_LABEL}?`,
    question: dismissQuestion(assistant.view),
    options: [{ id: 'dismiss', label: DISMISS_LABEL, emphasis: 'danger' }, { id: 'keep', label: `Keep ${ASSISTANT_NAME}` }],
    onAnswer: async (a) => { await answerDismiss('optionId' in a && a.optionId === 'dismiss'); },
    onDismiss: () => { void answerDismiss(false); },
  }] : [], [confirmingDismiss, callId, answerDismiss, assistant.view]);
  return <>
    {ask && <ComposerPromptDeck prompts={prompts} scope={`assistant-budget:${callId}`} className="mx-4 my-1" data-testid="assistant-budget-ask" />}
    {confirmingDismiss && <ComposerPromptDeck prompts={dismissPrompts} scope={`assistant-dismiss:${callId}`} className="mx-4 my-1" data-testid="assistant-dismiss-ask" />}
  </>;
}

/** The notice, on the library's RecordingConsentNotice with its own wording and two actions. Its close mark only hides it here; nothing is acknowledged or dismissed by it. */
export function AssistantConsentNotice() {
  const callId = useLiveCallId();
  const assistant = useMeetingAssistant(callId);
  const key = noticeKey(callId, assistant.view.period);
  const hidden = useAssistantNoticeHidden(key);
  if (hidden || !noticeVisible(assistant.enabled, assistant.view)) return null;
  const text = noticeText(assistant.view);
  return <RecordingConsentNotice open kind="transcription" placement="inline" className="mx-4 my-1" data-testid="assistant-consent-notice"
    title={text.title} description={text.body}
    acknowledgeLabel="I understand" onAcknowledge={assistant.busy ? () => {} : () => void assistant.acknowledge()}
    secondaryLabel={DISMISS_LABEL} onSecondary={assistant.busy ? () => {} : () => assistant.askDismiss()}
    onDismiss={() => { if (key) hideAssistantNotice(key); }} />;
}

/** Milo as a non-media entry for the call's people lists; null when it is not in this call. */
export function useAssistantRosterEntry(callId: string | null): string | null {
  const assistant = useMeetingAssistant(callId);
  return assistant.enabled && assistantPresent(assistant.view) ? rosterEntry(assistant.view) : null;
}

/** Milo as the library roster's non-media entry (`RosterPanel extraEntries`); empty when it is not in this call. */
export function useAssistantRosterEntries(): RosterExtraEntry[] {
  const callId = useLiveCallId();
  const assistant = useMeetingAssistant(callId);
  return assistant.enabled && assistantPresent(assistant.view)
    ? [{ id: 'meeting-assistant', name: ASSISTANT_NAME, label: ASSISTANT_LABEL, status: assistant.view.phase === 'paused' ? 'paused' : 'listening' }] : [];
}
