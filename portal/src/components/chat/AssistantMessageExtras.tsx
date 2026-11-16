// What sits under a Milo message in the call chat (docs/meeting-assistant-design.md, decisions 5 and 6).
// Every Milo message reads as one voice: the thread marks it (`isAssistantChatMessage` as ChatPanel's `isAssistantMessage`), so its
// row wears Milo's mark and the accent author ink. The thread draws Milo's message through these slots:
//   assistant-notice  a short state notice (paused, resumed, left...) is a system line (`renderSystemMessage`): one compact row under
//                     Milo's mark in a tinted pill. A long one (the join notice) is a quiet notice block instead (`renderMessageBody`):
//                     its first sentence, the rest behind "More".
//   assistant-minutes the minutes notice as a card: "Minutes" and "Ready", the summary's first lines, the counts as one line, and a
//                     button that opens the meeting.
//   assistant-reply   the tinted bubble, with "Asked by <name>" under it (`renderMessageReferences`)
//   assistant-action  a card that stands in for the bubble's text: Confirm and Decline for the asker only; everyone else reads
//                     "Waiting for <name>". A decision updates the same message (the server edits it), so the card changes in place.
//   assistant-proposal  a read-only card (docs/meeting-consent-design.md); answers are given in the deck above the footer row. Names and
//                     reasons come from the proposals route, so a reader who may not see the proposal sees the statement and its state.
//
// One anatomy for the action, proposal and minutes cards: a header row (what it is, its status pill), a one-line headline clamped to
// two, ONE plain-words line saying what will happen, the people as avatars with their answer in each name and one line saying who it
// needs, a footer row (buttons left, quiet meta right), and secondary material behind a disclosure that starts closed. State decides
// the size: waiting on the viewer is the full card in Milo's accent; waiting on others the full card on the plain surface; finished
// collapses to one row with a success mark; declined, expired, not a decision or failed to one muted row with the reason. A row opens
// to the full card. Every surface is opaque, so the dialogue's dot field never shows through. Library components only.

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Avatar, Button, Card, Disclosure, Inline, InlineAlert, Link, Stack, StatusPill, T, Tooltip } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { usePeopleDirectory } from '../../hooks/usePageCalls';
import { meetingHref } from '../../pages/meetings/meetingsModel';
import { answerProposal, raiseProposalAgain, useMeetingAssistant } from '../../lib/meetingAssistant';
import { ASSISTANT_NAME, expiresWords } from '../../lib/meetingAssistantModel';
import {
  blockedLine, expiryLine, eyebrowOf, heardText, isAnswerable, needsLine, optionalFor, outcomeLine, personChips, personLabel, proposalLayout, recordsLine, resultHref,
  stateLine, waitingOnYou, type PersonChip, type ProposalState, type ProposalView,
} from '../../lib/meetingProposals';
import { bumpProposalPrompt, setProposalDeckHidden } from '../../lib/proposalDeckState';
import { useLiveCallId } from '../../lib/liveCallId';
import {
  actionCardView, actionDoesLine, actionHeader, actionLayout, actionNeedsLine, actionRowText, actionTitle, askedByLine, decideAssistantAction, isLongNotice,
  minutesCountLine, readAssistantMessage, splitNotice, type ActionDecision, type AssistantAction, type AssistantProposalCard, type CardLayout, type MinutesCounts,
} from '../../lib/assistantMessages';

type PillTone = 'info' | 'success' | 'warning' | 'error' | 'neutral' | 'pending';
type DataAttrs = Record<`data-${string}`, string | undefined>;

// ---- the shared anatomy ---------------------------------------------------------------------------------------------------------

/** The card's surface: Milo's accent (opaque) when it waits on the viewer, the plain surface otherwise. Tight, even padding. */
function surface(layout: CardLayout): { tone: 'assistant' | 'default'; className: string } {
  return layout === 'you'
    ? { tone: 'assistant', className: 'mt-1 max-w-md bg-accent-callout px-3 py-2.5' }
    : { tone: 'default', className: layout === 'others' ? 'mt-1 max-w-md px-3 py-2.5' : 'mt-1 max-w-md px-3 py-1.5' };
}

interface FullCardProps {
  layout: CardLayout;
  testId: string;
  attrs: DataAttrs;
  /** The header's left side: "Action · asked by Dana", "Milo heard a decision", "Minutes". */
  header: ReactNode;
  headerTestId: string;
  pill: ReactNode;
  title: string;
  titleTestId: string;
  /** What will happen, in plain words. */
  does?: { text: string; testId: string } | null;
  /** The avatars, then the one line saying who it needs. */
  people?: ReactNode;
  needs?: ReactNode;
  /** The secondary material, closed by default. */
  more?: { label: string; testId: string; body: ReactNode } | null;
  actions?: ReactNode;
  meta?: ReactNode;
  after?: ReactNode;
  /** Shown on a card opened from its row: folds it back. */
  onCollapse?: () => void;
  collapseTestId?: string;
}

function FullCard({ layout, testId, attrs, header, headerTestId, pill, title, titleTestId, does, people, needs, more, actions, meta, after, onCollapse, collapseTestId }: FullCardProps) {
  const look = surface(layout === 'you' ? 'you' : 'others');
  return (
    <Card tone={look.tone} padding="none" className={look.className} data-testid={testId} data-layout={layout} data-collapsed="false" {...attrs}>
      <Stack gap="xs">
        <Inline gap="sm" align="center" justify="between" wrap={false}>
          <T size="xs" weight="medium" tone="secondary" truncate data-testid={headerTestId}>{header}</T>
          {pill}
        </Inline>
        <T size="sm" weight="semibold" clamp={2} data-testid={titleTestId}>{title}</T>
        {does && <T size="xs" tone="secondary" wrap data-testid={does.testId}>{does.text}</T>}
        {(people || needs) && (
          <Inline gap="sm" align="center" wrap>
            {people}
            {needs}
          </Inline>
        )}
        {more && (
          <Disclosure summary={more.label} density="compact" variant="plain" data-testid={more.testId}>
            {more.body}
          </Disclosure>
        )}
        {(actions || meta || onCollapse) && (
          <Inline gap="sm" align="center" justify="between" wrap>
            <Inline gap="xs" align="center" wrap>{actions}</Inline>
            <Inline gap="sm" align="center" wrap={false}>
              {meta}
              {onCollapse && <Button variant="ghost" size="sm" onClick={onCollapse} aria-expanded data-testid={collapseTestId}>Hide</Button>}
            </Inline>
          </Inline>
        )}
        {after}
      </Stack>
    </Card>
  );
}

/** The one row a finished or closed card collapses to: its mark (the status pill), what happened, a link or Undo, and Show. */
function CardRow({ layout, testId, attrs, pill, text, textTestId, trailing, onExpand, expandTestId }: {
  layout: 'done' | 'muted'; testId: string; attrs: DataAttrs; pill: ReactNode; text: string; textTestId: string; trailing?: ReactNode; onExpand: () => void; expandTestId: string;
}) {
  const look = surface(layout);
  return (
    <Card tone={look.tone} padding="none" className={look.className} data-testid={testId} data-layout={layout} data-collapsed="true" {...attrs}>
      <Inline gap="sm" align="center" justify="between" wrap={false}>
        <Inline gap="sm" align="center" wrap={false} className="min-w-0">
          <Inline gap="none" align="center" wrap={false} className="shrink-0">{pill}</Inline>
          <T size="xs" tone={layout === 'done' ? 'secondary' : 'tertiary'} truncate title={text} data-testid={textTestId}>{text}</T>
        </Inline>
        <Inline gap="xs" align="center" wrap={false}>
          {trailing}
          <Button variant="ghost" size="sm" onClick={onExpand} aria-expanded={false} aria-label="Show the whole card" data-testid={expandTestId}>Show</Button>
        </Inline>
      </Inline>
    </Card>
  );
}

/** The people on a card as faces: each avatar's name says their answer ("Vera Green · consented · runs it"), shown on hover and read aloud. */
function PeopleAvatars({ chips }: { chips: readonly PersonChip[] }) {
  const person = usePeopleDirectory(chips.length > 0);
  const ring: Record<PersonChip['state'], string> = { consented: 'ring-2 ring-success', objected: 'ring-2 ring-danger', waiting: 'opacity-70' };
  return (
    <Inline gap="xs" align="center" wrap data-testid="assistant-proposal-people">
      {chips.map((chip) => {
        const label = personLabel(chip);
        const src = person(chip.userId)?.avatarUrl;
        return (
          <Tooltip key={chip.userId} content={label}>
            <T as="span" data-testid="assistant-proposal-person">
              <Avatar name={chip.name} size={22} title={null} className={ring[chip.state]} {...(src ? { src } : {})} />
              <T as="span" className="sr-only">{label}</T>
            </T>
          </Tooltip>
        );
      })}
    </Inline>
  );
}

// ---- the action card ------------------------------------------------------------------------------------------------------------

export interface AssistantActionCardProps {
  action: AssistantAction;
  viewerId: string | null;
  callId: string | null;
  /** Injected for tests; the app posts to the BFF. */
  decide?: typeof decideAssistantAction;
}

/** The call's initiative's name, for "Creates a work item in <name>"; null until known, and not asked for when the line does not need it. */
function useCallInitiativeName(callId: string | null, wanted: boolean): string | null {
  const assistant = useMeetingAssistant(wanted ? callId : null);
  const id = wanted ? assistant.view.initiativeId : null;
  const named = useFetch<{ name?: string }>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : null);
  return named.data?.name?.trim() || null;
}

/** "expires in 7 min" while the card waits, from the call's state (which says when each waiting card expires), kept current each half minute. */
function useExpiresWords(callId: string | null, actionId: string, waiting: boolean): string | null {
  const assistant = useMeetingAssistant(waiting ? callId : null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [waiting]);
  return waiting ? expiresWords(assistant.view, actionId, now) : null;
}

export function AssistantActionCard({ action, viewerId, callId, decide = decideAssistantAction }: AssistantActionCardProps) {
  const [busy, setBusy] = useState<ActionDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const view = actionCardView(action, viewerId);
  const layout = actionLayout(action, viewerId);
  const waiting = action.status === 'waiting';
  const expires = useExpiresWords(callId, action.actionId, waiting);
  const initiativeName = useCallInitiativeName(callId, !!action.does && layout !== 'done' && layout !== 'muted');
  const choose = (decision: ActionDecision): void => {
    if (!callId || busy) return;
    setBusy(decision); setError(null);
    decide(callId, action.actionId, decision)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The decision could not be saved.'))
      .finally(() => setBusy(null));
  };
  const attrs: DataAttrs = { 'data-status': action.status, 'data-action-id': action.actionId };
  const pill = <StatusPill tone={view.tone} label={view.statusLabel} size="sm" data-testid="assistant-action-status" />;
  if ((layout === 'done' || layout === 'muted') && !open) {
    return <CardRow layout={layout} testId="assistant-action-card" attrs={attrs} pill={pill} text={actionRowText(action)} textTestId="assistant-action-row-text" onExpand={() => setOpen(true)} expandTestId="assistant-action-expand" />;
  }
  const does = actionDoesLine(action, initiativeName);
  const needs = actionNeedsLine(action, viewerId);
  const hasMore = action.detail.length > 0 || !!action.resultText;
  return (
    <FullCard
      layout={layout} testId="assistant-action-card" attrs={attrs}
      header={actionHeader(action)} headerTestId="assistant-action-eyebrow" pill={pill}
      title={actionTitle(action)} titleTestId="assistant-action-summary"
      does={does ? { text: does, testId: 'assistant-action-does' } : null}
      needs={needs ? <T size="xs" tone="tertiary" wrap data-testid={view.waitingNote ? 'assistant-action-waiting-note' : 'assistant-action-needs'}>{needs}</T> : null}
      more={hasMore ? {
        label: 'Details', testId: 'assistant-action-more',
        body: (
          <Stack gap="xs">
            {action.resultText && <T size="xs" tone="secondary" wrap data-testid="assistant-action-result">{action.resultText}</T>}
            {action.detail.length > 0 && (
              <Stack gap="none" data-testid="assistant-action-detail">
                <T size="xs" tone="tertiary" wrap>Exactly what {ASSISTANT_NAME} will send:</T>
                {action.detail.map((line, index) => <T key={index} size="xs" tone="tertiary" wrap>{line}</T>)}
              </Stack>
            )}
          </Stack>
        ),
      } : null}
      actions={view.canDecide ? (
        <>
          <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => choose('confirm')} data-testid="assistant-action-confirm">
            {busy === 'confirm' ? 'Confirming…' : 'Confirm'}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => choose('decline')} data-testid="assistant-action-decline">
            {busy === 'decline' ? 'Declining…' : 'Decline'}
          </Button>
        </>
      ) : null}
      meta={expires ? <T size="xs" tone="tertiary" data-testid="assistant-action-expires">{expires}</T> : null}
      after={error ? <InlineAlert tone="error" data-testid="assistant-action-error">{error}</InlineAlert> : null}
      {...(open ? { onCollapse: () => setOpen(false), collapseTestId: 'assistant-action-collapse' } : {})}
    />
  );
}

// ---- the proposal card ----------------------------------------------------------------------------------------------------------

const PROPOSAL_PILL: Record<ProposalState, [string, PillTone]> = {
  open: ['Waiting for consent', 'pending'], consented: ['Consented', 'info'], running: ['Running', 'info'], done: ['Done', 'success'],
  failed: ['Failed', 'error'], objected: ['Objected', 'warning'], dismissed: ['Not a decision', 'neutral'], expired: ['Expired', 'neutral'],
};

/** The initiative's name for "Record as a decision on <name>"; null until known. */
function useInitiativeName(id: string | null): string | null {
  const named = useFetch<{ name?: string }>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : null);
  return named.data?.name?.trim() || null;
}

export function AssistantProposalCardView({ card, statement, callId }: { card: AssistantProposalCard; statement: string; callId: string | null }) {
  const assistant = useMeetingAssistant(callId);
  const view = assistant.proposals.find((p) => p.id === card.proposalId) ?? null;
  // The message's state moves with every change; the route's view may lag a poll behind, so the pill follows the message.
  return <ProposalCard proposalId={card.proposalId} state={card.state} statement={statement} view={view} surface="assistant" />;
}

/**
 * One proposal, in the shared anatomy: who raised it ("Milo heard a decision" or "Asked by Dana") and its pill, the statement, what
 * will be written, the people as avatars with who it still needs, the quiet actions (Answer opens the deck in the call; withdrawing
 * your answer; Undo of your dismissal; Raise it again on a blocked or failed one) and when it expires; the lines Milo heard and how it
 * will be recorded sit behind "What Milo heard". Recorded or made, it is one row with the link; closed, one muted row with the reason.
 * The call chat's card and the meeting page's Proposals section draw this same card.
 */
export function ProposalCard({ proposalId, state, statement, view, surface: where = 'default' }: {
  proposalId: string; state: ProposalState; statement: string; view: ProposalView | null;
  /** `assistant` in the call chat, where it is one of Milo's messages (and Answer opens the call's deck); the meeting page lists it too. */
  surface?: 'default' | 'assistant';
}) {
  const navigate = useNavigate();
  const initiativeName = useInitiativeName(view?.outcome.kind === 'decision' ? view.outcome.initiativeId : null);
  const [pill, tone] = PROPOSAL_PILL[state];
  // A dismissed one reads for what happened to it: raised again, dropped by its asker, or not needed / not a decision.
  const label = state !== 'dismissed' || !view ? pill : view.run?.raisedAs ? 'Raised again' : view.source === 'asked' ? 'Dropped' : view.outcome.kind === 'tool' ? 'Not needed' : pill;
  const live = view ? { ...view, state } : null;
  const layout = proposalLayout(state, view);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callId = view?.callId ?? null;
  const liveCallId = useLiveCallId();
  const act = (run: (id: string) => Promise<string | null>) => {
    if (!callId || busy) return;
    setBusy(true); setError(null);
    void run(callId).then((why) => { setError(why); setBusy(false); });
  };
  const closing = live ? stateLine(live) : null;
  const href = live ? resultHref(live) : null;
  const attrs: DataAttrs = { 'data-proposal-id': proposalId, 'data-state': state };
  const pillNode = <StatusPill tone={tone} label={label} size="sm" data-testid="assistant-proposal-status" />;
  const resultLink = href ? (
    <Link href={href} aria-label={live?.outcome.kind === 'decision' ? 'Open the decision' : 'Open what was made'} data-testid="assistant-proposal-result-link"
      onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(href); } }}>
      Open
    </Link>
  ) : null;
  const undo = live?.you.canReopen ? (
    <Button variant="link" size="sm" disabled={busy} onClick={() => act((c) => { bumpProposalPrompt(c, live.id); return answerProposal(c, live.id, 'reopen'); })} data-testid="assistant-proposal-undo">Undo</Button>
  ) : null;
  const raise = live?.you.canRaiseAgain ? (
    <Button variant={layout === 'muted' ? 'link' : 'secondary'} size="sm" disabled={busy} onClick={() => act((c) => raiseProposalAgain(c, live.id))} data-testid="assistant-proposal-raise">Raise it again</Button>
  ) : null;
  const errorNode = error ? <T size="xs" tone="danger" wrap role="alert" data-testid="assistant-proposal-error">{error}</T> : null;

  if ((layout === 'done' || layout === 'muted') && !open) {
    const text = layout === 'done' ? closing ?? statement : closing ? `${statement} · ${closing}` : statement;
    return (
      <Stack gap="none">
        <CardRow layout={layout} testId="assistant-proposal-card" attrs={attrs} pill={pillNode} text={text} textTestId="assistant-proposal-closing"
          trailing={<>{resultLink}{undo}{raise}</>} onExpand={() => setOpen(true)} expandTestId="assistant-proposal-expand" />
        {errorNode}
      </Stack>
    );
  }

  const needs = live && state === 'open' ? needsLine(live) : null;
  const blocked = live ? blockedLine(live) : null;
  const records = live ? recordsLine(live) : null;
  const expiry = live ? expiryLine(live) : null;
  // Answer opens the deck in the call, where it is asked; it is offered only when the deck has a question for this person. Someone not
  // in the running call (it ended, or they left it) has no deck: Answer takes them to the meeting page, which asks the same question.
  const answer = live && where === 'assistant' && callId && (waitingOnYou(live) || optionalFor(live));
  const answerHere = !!callId && liveCallId === callId;
  const withdraw = live && callId && live.you.response !== null && isAnswerable(live);
  const hasMore = !!live && (live.heard.length > 0 || !!records);
  return (
    <FullCard
      layout={layout} testId="assistant-proposal-card" attrs={attrs}
      header={live ? eyebrowOf(live) : 'Proposal'} headerTestId="assistant-proposal-eyebrow" pill={pillNode}
      title={statement} titleTestId="assistant-proposal-statement"
      does={live ? { text: outcomeLine(live.outcome, initiativeName), testId: 'assistant-proposal-outcome' } : null}
      people={live ? <PeopleAvatars chips={personChips(live)} /> : null}
      needs={(needs || blocked || (closing && layout !== 'done' && layout !== 'muted')) ? (
        <Stack gap="none">
          {needs && <T size="xs" tone="secondary" wrap data-testid="assistant-proposal-needs">{needs}</T>}
          {!needs && closing && <T size="xs" tone={state === 'failed' ? 'danger' : 'secondary'} wrap data-testid="assistant-proposal-closing">{closing}</T>}
          {blocked && <T size="xs" tone="tertiary" wrap data-testid="assistant-proposal-blocked">{blocked}</T>}
        </Stack>
      ) : null}
      more={hasMore && live ? {
        label: live.heard.length > 0 ? `What ${ASSISTANT_NAME} heard` : 'How it will be recorded', testId: 'assistant-proposal-more',
        body: (
          <Stack gap="xs">
            {live.heard.length > 0 && (
              <Stack gap="none" data-testid="assistant-proposal-heard">
                {live.heard.map((line, i) => <T key={i} size="xs" tone="tertiary" wrap>{heardText(line)}</T>)}
              </Stack>
            )}
            {records && <T size="xs" tone="secondary" wrap data-testid="assistant-proposal-records">{records}</T>}
          </Stack>
        ),
      } : null}
      actions={live && (answer || withdraw || undo || raise || resultLink) ? (
        <>
          {answer && answerHere && (
            <Button variant={waitingOnYou(live) ? 'primary' : 'secondary'} size="sm" onClick={() => setProposalDeckHidden(callId, false)} data-testid="assistant-proposal-answer">Answer</Button>
          )}
          {answer && !answerHere && (
            <Link href={meetingHref(callId)} data-testid="assistant-proposal-answer-meeting"
              onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(meetingHref(callId)); } }}>
              Answer on the meeting page
            </Link>
          )}
          {undo}
          {raise}
          {withdraw && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => act((c) => { bumpProposalPrompt(c, live.id); return answerProposal(c, live.id, 'withdraw'); })} data-testid="assistant-proposal-withdraw">
              {live.you.response === 'consent' ? 'Withdraw my consent' : 'Withdraw my objection'}
            </Button>
          )}
          {resultLink}
        </>
      ) : null}
      meta={expiry ? <T size="xs" tone="tertiary" data-testid="assistant-proposal-expiry">{expiry}</T> : null}
      after={errorNode}
      {...(open ? { onCollapse: () => setOpen(false), collapseTestId: 'assistant-proposal-collapse' } : {})}
    />
  );
}

export interface AssistantMessageExtrasProps {
  metadata: Record<string, unknown> | undefined;
  viewerId: string | null;
  callId: string | null;
  decide?: typeof decideAssistantAction;
}

/** The part under a Milo reply ("Asked by <name>"); null for any other message. */
export function AssistantMessageExtras({ metadata }: Pick<AssistantMessageExtrasProps, 'metadata'>) {
  const message = readAssistantMessage(metadata);
  if (message?.kind !== 'assistant-reply') return null;
  return <T size="xs" tone="tertiary" data-testid="assistant-reply-asked-by">{askedByLine(message)}</T>;
}

/**
 * "Open the meeting page" under a closing notice. A closing notice names its meeting in the message's metadata, never in its text: the
 * link is built from that field (the portal's own meeting path), so nothing in the chat becomes a link because of what a message says.
 */
function MeetingLink({ callId }: { callId: string }) {
  const navigate = useNavigate();
  const href = meetingHref(callId);
  return (
    <Link href={href} data-testid="assistant-notice-meeting-link" onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(href); } }}>
      Open the meeting page
    </Link>
  );
}

/** A short state notice's line inside the thread's tinted pill, with the meeting link when it carries one. */
function NoticeLine({ content, callId }: { content: string; callId: string | undefined }) {
  return (
    <Inline gap="sm" align="center" wrap>
      <T size="xs" tone="secondary" wrap data-testid="assistant-notice-line">{content}</T>
      {callId && <MeetingLink callId={callId} />}
    </Inline>
  );
}

/** A long notice (the join notice) as a quiet notice block: its first sentence, the rest behind "More". */
function NoticeBlock({ content, callId }: { content: string; callId: string | undefined }) {
  const { first, rest } = splitNotice(content);
  return (
    <InlineAlert tone="info" className="mt-1 max-w-md" data-testid="assistant-notice-block">
      <Stack gap="xs">
        <T size="xs" wrap data-testid="assistant-notice-line">{first}</T>
        {rest && (
          <Disclosure summary="More" density="compact" variant="plain" data-testid="assistant-notice-more">
            <T size="xs" tone="secondary" wrap data-testid="assistant-notice-rest">{rest}</T>
          </Disclosure>
        )}
        {callId && <MeetingLink callId={callId} />}
      </Stack>
    </InlineAlert>
  );
}

/**
 * The minutes notice as a card in the shared anatomy: "Minutes" and "Ready", the summary's first lines (the message's text, clamped to
 * two lines), the counts the server attached as one line, and a button that opens the meeting. The counts name decisions consented
 * through the call's proposals too.
 */
export function MinutesCard({ summary, counts, callId }: { summary: string; counts: MinutesCounts; callId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <Card tone="default" padding="none" className="mt-1 max-w-md px-3 py-2.5" data-testid="assistant-minutes-card" data-layout="others">
      <Stack gap="xs">
        <Inline gap="sm" align="center" justify="between" wrap={false}>
          {/* An addition (Milo was invited back and heard more) says so; the card is otherwise the same. */}
          <T size="xs" weight="medium" tone="secondary" data-testid="assistant-minutes-title">{counts.added ? `${ASSISTANT_NAME} added to the minutes` : 'Minutes'}</T>
          <StatusPill tone="success" label={counts.added ? 'Updated' : 'Ready'} size="sm" data-testid="assistant-minutes-status" />
        </Inline>
        {summary && <T size="sm" clamp={2} data-testid="assistant-minutes-summary">{summary}</T>}
        <T size="xs" tone="secondary" wrap data-testid="assistant-minutes-counts">{minutesCountLine(counts)}</T>
        {callId && (
          <Inline gap="sm" align="center">
            <Button variant="secondary" size="sm" onClick={() => navigate(meetingHref(callId))} data-testid="assistant-notice-meeting-link">Open the meeting</Button>
          </Inline>
        )}
      </Stack>
    </Card>
  );
}

/** A short Milo state notice as a system line; null for any other message (and for the minutes notice and a long notice), so the thread draws it as usual. */
export function assistantSystemLine(message: { content: string; metadata?: Record<string, unknown> }): ReactNode | null {
  const read = readAssistantMessage(message.metadata);
  return read?.kind === 'assistant-notice' && !read.minutes && !isLongNotice(message.content) ? <NoticeLine content={message.content} callId={read.meetingCallId} /> : null;
}

/** The action, proposal or minutes card, or a long notice's block, standing in for the bubble's text; null for any other message. */
export function assistantBody(message: { content?: string; metadata?: Record<string, unknown> }, viewerId: string | null, callId: string | null, decide?: typeof decideAssistantAction): ReactNode | null {
  const read = readAssistantMessage(message.metadata);
  if (read?.kind === 'assistant-notice' && read.minutes) return <MinutesCard summary={message.content ?? ''} counts={read.minutes} callId={read.meetingCallId} />;
  if (read?.kind === 'assistant-notice' && isLongNotice(message.content ?? '')) return <NoticeBlock content={message.content ?? ''} callId={read.meetingCallId} />;
  if (read?.kind === 'assistant-proposal') return <AssistantProposalCardView card={read} statement={message.content ?? ''} callId={callId} />;
  return read?.kind === 'assistant-action' ? <AssistantActionCard action={read} viewerId={viewerId} callId={callId} decide={decide} /> : null;
}
