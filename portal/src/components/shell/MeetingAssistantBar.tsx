// The call assistant in the shell (docs/meeting-assistant-design.md, decisions 8 and 13):
//   NovaBarControls  Invite Nova, the "Nova is listening" mark, Pause/Resume and Dismiss — the HuddleBar's `extras`. The mark says
//                    what Nova is doing ("Nova is looking that up for Una"), whether it can hear the call, and its voice on a chip.
//   NovaBudgetAsk    the questions asked above the footer row as deck prompts: an over-budget refusal, and "Dismiss Nova for everyone"
//   NovaNotice       the transcription notice for someone who has not acknowledged, above the footer row
//   useNovaRosterEntry  the "Nova (Assistant, listening)" line for the call's people lists
// Everything renders nothing unless the server advertises the feature (session.meetingAssistant) and a call is live.

import { Badge, Button, CheckIcon, Chip, CloseIcon, DropdownMenu, InlinePopover, Inline, PauseCircleIcon, PlayCircleIcon, PlusCircleIcon, T, Tooltip } from '@connorhoehn/ui-components/shared';
import { RecordingConsentNotice, SpeakerIcon, type RosterExtraEntry } from '@connorhoehn/ui-components/video';
import { ComposerPromptDeck, type ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useMemo, useRef, useState } from 'react';
import { useNovaVoice } from '../../lib/novaVoice';
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import {
  assistantPresent, assistantStateWords, leftWords, markWords, myWaitingActions, standingFacts, timeLeftWords, noticeText, noticeVisible, rosterEntry, voiceWords,
  ASSISTANT_LABEL, ASSISTANT_NAME, DISMISS_LABEL, DISMISS_QUESTION,
} from '../../lib/meetingAssistantModel';
import { proposalCountWords, waitingCount } from '../../lib/meetingProposals';
import { useHuddleChatToggle } from './HuddleChat';
import { useLiveCallId } from '../../lib/liveCallId';
import { useProposalQueue } from './NovaProposalAsk';
import { setProposalDeckHidden } from '../../lib/proposalDeckState';
import { hideNovaNotice, useNovaNoticeHidden } from '../../lib/novaNoticeHidden';

export { useLiveCallId };

/** "1 card waiting for you" / "1 proposal" / both, for the footer count; null when nothing waits on this person. */
export function waitingWords(cards: number, proposals: number): string | null {
  const parts = [cards > 0 ? `${cards} ${cards === 1 ? 'card' : 'cards'} waiting for your confirmation` : null, proposalCountWords(proposals)].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Brings a waiting card into view: the chat opens (it may be closed), then the card scrolls in and its Confirm takes the focus. */
function jumpToCard(actionId: string, openChat: (() => void) | null): void {
  const find = () => document.querySelector<HTMLElement>(`[data-testid="assistant-action-card"][data-action-id="${CSS.escape(actionId)}"]`);
  const go = (tries: number) => {
    const card = find();
    if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.querySelector<HTMLElement>('[data-testid="assistant-action-confirm"]')?.focus({ preventScroll: true }); return; }
    if (tries > 0) setTimeout(() => go(tries - 1), 150);
  };
  if (!find()) openChat?.();
  go(10);
}

export function NovaBarControls() {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const { controls, view, busy } = nova;
  const noticeClosed = useNovaNoticeHidden(callId);
  const voice = useNovaVoice(callId, nova.view);
  const errorRef = useRef<HTMLButtonElement | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  // Only proposals that wait on this person count; a bystander's optional prompt is in the deck but not in the badge.
  const owed = waitingCount(useProposalQueue().queue);
  const chat = useHuddleChatToggle({ behavior: 'focus' });
  // Nothing is drawn until the first state read answers: no "Invite Nova" while Nova may already be here.
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
  const soundPrompt = !!words && voice.needsGesture && (voice.framesPlayed > 0 || voice.framesIgnored > 0);
  // Someone who cannot invite, with no Nova in the call, gets no bar at all (not an empty ruled slot).
  if (!controls.invite && !(state && controls.left) && !(words && !controls.left) && !soundPrompt && !nova.error && !waiting) return null;
  const why = controls.left ? `${leftWords(view)}.` : null;
  return <Inline gap="xs" align="center" wrap={false} className="shrink-0 border-l border-border pl-2" data-testid="nova-bar">
    {controls.invite && <Tooltip content="Nova listens to this call and answers when asked by name" placement="top">
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void nova.invite()} data-testid="nova-invite">Invite Nova</Button>
    </Tooltip>}
    {/* One compact control keeps the dense bar on a line: the state in words is the trigger; acknowledge, pause or resume, extend and dismiss are its menu. */}
    {/* After Nova left: why (who dismissed it, its time limit, a lost connection), and that it cannot come back to this call. */}
    {state && controls.left && why && <Tooltip content={why} placement="top">
      <Chip size="xs" tone="neutral" className="whitespace-nowrap" aria-label={why} data-testid="nova-left" data-left-by={view.leftBy === 'system' ? 'system' : view.leftBy ? 'person' : ''}>{why}</Chip>
    </Tooltip>}
    {words && !controls.left && <DropdownMenu align="end" triggerVariant="secondary" triggerClassName="px-2" triggerLabel={`${words}${left ? `, ${left}` : ''}${view.voice ? `, Nova's voice is on${voice.muted ? ', muted for you' : ''}` : ''}. Acknowledge, pause, extend or dismiss Nova`} triggerTestId="nova-mark"
      triggerAttributes={{ 'data-phase': view.phase, 'data-hearing': view.hearing, 'data-working': String(view.openRequests.length), 'data-voice': String(view.voice), 'data-voice-muted': String(voice.muted), 'data-voice-speaking': String(voice.speaking), 'data-voice-frames': String(voice.framesPlayed), 'data-voice-ignored': String(voice.framesIgnored), 'data-voice-last-seq': String(voice.lastSeq), 'data-must-ack': String(controls.acknowledge), ...(left ? { 'data-time-left': left } : {}) }} disabled={busy} data-testid="nova-menu"
      trigger={<T size="xs" weight="medium" className="whitespace-nowrap">{words}{left ? ` · ${left}` : ''}</T>}
      sections={[...(facts.length ? [{ label: `${ASSISTANT_NAME} in this call`, items: [], caption: facts.join('. ') + '.', 'data-testid': 'nova-facts' }] : []), { items: [
        ...(controls.acknowledge ? [{ label: 'Acknowledge', description: 'Nova cannot hear you until you do', icon: <CheckIcon size={14} />, onSelect: () => void nova.acknowledge() }] : []),
        ...(controls.pause ? [{ label: 'Pause Nova', icon: <PauseCircleIcon size={14} />, onSelect: () => void nova.pause() }] : []),
        ...(controls.resume ? [{ label: 'Resume Nova', icon: <PlayCircleIcon size={14} />, onSelect: () => void nova.resume() }] : []),
        ...(voiceMenu && nova.canSetVoice ? [{ label: view.voice ? "Turn Nova's voice off" : "Turn Nova's voice on", description: view.voice ? "Nova's voice is on in this call" : 'Nova answers aloud when asked', icon: <SpeakerIcon size={14} />, onSelect: () => void nova.setVoice(!view.voice) }] : []),
        ...(voiceMenu ? [{ label: voice.muted ? 'Unmute Nova for me' : 'Mute Nova for me', description: 'Only for you, in this call', icon: <SpeakerIcon size={14} />, onSelect: () => voice.setMuted(!voice.muted) }] : []),
        ...(controls.extend ? [{ label: 'Extend time', ...(left ? { description: left } : {}), icon: <PlusCircleIcon size={14} />, onSelect: () => void nova.extend() }] : []),
        ...(controls.dismiss ? [{ label: DISMISS_LABEL, icon: <CloseIcon size={14} />, danger: true, onSelect: () => nova.askDismiss() }] : []),
      ] }]} />}
    {/* Nova's voice, seen without opening the menu: on for the call, or muted by this person. */}
    {voiceChip && !controls.left && <Chip size="xs" tone={voice.muted ? 'neutral' : 'info'} icon={<SpeakerIcon size={12} />} data-testid="nova-voice-chip">{voiceChip}</Chip>}
    {/* What waits on this person: change cards to confirm (they expire) and proposals to answer. The cards come first: the badge
        jumps to the soonest-expiring one; with none, it reopens the proposal deck that Esc hid. A count badge, with the words as its
        name and tooltip, keeps the footer on one line at 1280 with three people in the call. */}
    {waiting && callId && <Tooltip content={waiting} placement="top">
      <Button variant="ghost" size="sm" className="px-1" aria-label={waiting} data-cards={cards.length} data-proposals={owed}
        onClick={() => { if (cards[0]) jumpToCard(cards[0].actionId, chat?.toggle ?? null); else setProposalDeckHidden(callId, false); }} data-testid="nova-proposal-count">
        <Badge variant="count" value={cards.length + owed} color="accent" aria-label={waiting} />
      </Button>
    </Tooltip>}
    {soundPrompt && <Button variant="ghost" size="sm" onClick={() => void voice.enableSound()} data-testid="nova-enable-sound">Click to hear Nova</Button>}
    {/* The refusal sentence is read in full in a popover; the row keeps one short line. */}
    {nova.error && <>
      <Button ref={errorRef} variant="ghost" size="sm" className="max-w-[12rem] truncate text-danger" onClick={() => setErrorOpen((v) => !v)} aria-expanded={errorOpen} title={nova.error} data-testid="nova-error">{nova.error}</Button>
      <InlinePopover trigger={errorRef} open={errorOpen} onClose={() => setErrorOpen(false)} placement="top-end" className="max-w-sm p-3" aria-label="Why Nova could not do that" data-testid="nova-error-full">
        <T size="sm" tone="danger" wrap role="alert" data-testid="nova-error-text">{nova.error}</T>
      </InlinePopover>
    </>}
  </Inline>;
}

/** The server's over-budget refusal, asked as a deck prompt above the footer row (no dialog): the refusal sentence, then Go ahead or Cancel. */
export function NovaBudgetAsk() {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const { ask, answerAsk, confirmingDismiss, answerDismiss } = nova;
  const prompts = useMemo<ComposerPrompt[]>(() => ask ? [{
    id: `nova-budget:${callId}:${ask.action}:${ask.detail}`, scope: `nova-budget:${callId}`, kind: 'choice', eyebrow: 'Nova', title: ask.title,
    question: ask.detail,
    options: [{ id: 'go', label: 'Go ahead', emphasis: 'primary' }, { id: 'cancel', label: 'Cancel' }],
    onAnswer: async (a) => { await answerAsk('optionId' in a && a.optionId === 'go'); },
  }] : [], [ask, callId, answerAsk]);
  // Dismissing is for everyone and final for the call, so it is asked once, naming that effect. Esc or Cancel keeps Nova.
  const dismissPrompts = useMemo<ComposerPrompt[]>(() => confirmingDismiss ? [{
    id: `nova-dismiss:${callId}`, scope: `nova-dismiss:${callId}`, kind: 'choice', eyebrow: 'Nova', title: `${DISMISS_LABEL}?`,
    question: DISMISS_QUESTION,
    options: [{ id: 'dismiss', label: DISMISS_LABEL, emphasis: 'danger' }, { id: 'keep', label: `Keep ${ASSISTANT_NAME}` }],
    onAnswer: async (a) => { await answerDismiss('optionId' in a && a.optionId === 'dismiss'); },
    onDismiss: () => { void answerDismiss(false); },
  }] : [], [confirmingDismiss, callId, answerDismiss]);
  return <>
    {ask && <ComposerPromptDeck prompts={prompts} scope={`nova-budget:${callId}`} className="mx-4 my-1" data-testid="nova-budget-ask" />}
    {confirmingDismiss && <ComposerPromptDeck prompts={dismissPrompts} scope={`nova-dismiss:${callId}`} className="mx-4 my-1" data-testid="nova-dismiss-ask" />}
  </>;
}

/** The notice, on the library's RecordingConsentNotice with its own wording and two actions. Its close mark only hides it here; nothing is acknowledged or dismissed by it. */
export function NovaNotice() {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const hidden = useNovaNoticeHidden(callId);
  if (hidden || !noticeVisible(nova.enabled, nova.view)) return null;
  const text = noticeText(nova.view);
  return <RecordingConsentNotice open kind="transcription" placement="inline" className="mx-4 my-1" data-testid="nova-notice"
    title={text.title} description={text.body}
    acknowledgeLabel="I understand" onAcknowledge={nova.busy ? () => {} : () => void nova.acknowledge()}
    secondaryLabel={DISMISS_LABEL} onSecondary={nova.busy ? () => {} : () => nova.askDismiss()}
    onDismiss={() => { if (callId) hideNovaNotice(callId); }} />;
}

/** Nova as a non-media entry for the call's people lists; null when it is not in this call. */
export function useNovaRosterEntry(callId: string | null): string | null {
  const nova = useMeetingAssistant(callId);
  return nova.enabled && assistantPresent(nova.view) ? rosterEntry(nova.view) : null;
}

/** Nova as the library roster's non-media entry (`RosterPanel extraEntries`); empty when it is not in this call. */
export function useNovaRosterEntries(): RosterExtraEntry[] {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  return nova.enabled && assistantPresent(nova.view)
    ? [{ id: 'assistant-nova', name: ASSISTANT_NAME, label: ASSISTANT_LABEL, status: nova.view.phase === 'paused' ? 'paused' : 'listening' }] : [];
}
