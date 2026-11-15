// Proposals Milo notices in a call, as the portal reads them (docs/meeting-consent-design.md). The shapes mirror the proposals route
// in middleware/src/routes/meeting-assistant.ts (`proposalView`); change both together.
//
// The rules kept here: answers are given in the deck; the card in the chat shows the proposal and carries the quiet actions (Answer,
// which opens the deck; withdrawing an answer; Undo of a dismissal; Raise it again). The deck asks one proposal at a time: first those
// waiting on this person (they are needed and have not consented, or they may run it now), then those where their answer is optional.
// Only the first group is counted. An objection's reason is shared with everyone who can see the proposal, and the deck says so first.

import { ASSISTANT_NAME } from './meetingAssistantModel.ts';

export type ProposalState = 'open' | 'consented' | 'running' | 'done' | 'failed' | 'objected' | 'dismissed' | 'expired';
export const PROPOSAL_STATES: readonly ProposalState[] = ['open', 'consented', 'running', 'done', 'failed', 'objected', 'dismissed', 'expired'];
export type ProposalResponseKind = 'consent' | 'object';
export type ProposalAnswer = 'consent' | 'object' | 'withdraw' | 'not-a-decision' | 'reopen';

export interface ProposalPerson { userId: string; name: string }
export interface ProposalResponseView extends ProposalPerson { response: ProposalResponseKind; reason: string | null; at: number }
/** `summary`: what will be written, in plain words, from the server ("Create a work item titled …, owned by Lee"). */
export type ProposalOutcomeView = { kind: 'decision'; initiativeId: string | null; summary?: string } | { kind: 'tool'; name: string; summary?: string };

export interface ProposalRunView { by: ProposalPerson; at: number; title: string | null; href: string | null; note: string | null; raisedAs: string | null }
/** A line Milo heard, sent only to people who were in the call. */
export interface HeardLine { speaker: string; text: string }

export interface ProposalView {
  id: string;
  callId: string | null;
  statement: string;
  /** `asked`: a person asked Milo for it (`askedBy`); otherwise Milo raised it from what it heard. */
  source: 'watcher' | 'asked' | 'dev';
  askedBy: ProposalPerson | null;
  /** The lines Milo heard (a short excerpt); empty for anyone who was not in the call. */
  heard: HeardLine[];
  /** A decision: recorded as decided by its executor, or as waiting for the initiative owner's decision. */
  recordsAs: 'decided' | 'waiting' | null;
  outcome: ProposalOutcomeView;
  state: ProposalState;
  executor: ProposalPerson;
  named: ProposalPerson[];
  responses: ProposalResponseView[];
  missing: { people: string[]; more: number; objectedBy: string[] };
  dismissedBy: string | null;
  dismissedByName: string | null;
  createdAt: number;
  /** The latest run (the server's `run`): whose browser, then what was made (`title`, `href` to a portal path) or why not (`note`). */
  run: ProposalRunView | null;
  /** When it expires unrun (end of the call + 72 h); null while the call goes on. */
  expiresAt: number | null;
  you: {
    userId: string; response: ProposalResponseKind | null; isExecutor: boolean; isNamed: boolean; isAsker: boolean;
    /** The server says this person may run it now (the executor's "Run it now", or a take-over after a hand-back). */
    canRun: boolean;
    canDismiss: boolean; canReopen: boolean; canRaiseAgain: boolean;
  };
}

/** States in which people may still answer (the server's ANSWERABLE). */
export const ANSWERABLE: readonly ProposalState[] = ['open', 'objected', 'consented'];

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const person = (v: unknown): ProposalPerson | null => {
  const r = rec(v);
  return r && str(r['userId']) ? { userId: r['userId'], name: str(r['name']) ? r['name'] : r['userId'] } : null;
};

/** A link is drawn only to a path inside the portal, never to whatever URL a field holds. */
const portalPath = (v: unknown): string | null => (str(v) && /^\/(?!\/)/.test(v) ? v : null);
const runOf = (v: unknown): ProposalRunView | null => {
  const r = rec(v); const by = person(r?.['by']);
  if (!r || !by) return null;
  return { by, at: Number(r['at']) || 0, title: str(r['title']) ? r['title'] : null, href: portalPath(r['href']), note: str(r['note']) ? r['note'] : null, raisedAs: str(r['raisedAs']) ? r['raisedAs'] : null };
};
const heardOf = (v: unknown): HeardLine[] => (Array.isArray(v) ? v : []).flatMap((x): HeardLine[] => {
  const r = rec(x);
  return r && str(r['text']) ? [{ speaker: str(r['speaker']) ? r['speaker'] : 'Someone', text: r['text'] }] : [];
});

/** One proposal from the route's JSON; null when malformed (it is then left out, never drawn half). */
export function parseProposal(raw: unknown): ProposalView | null {
  const r = rec(raw);
  if (!r || !str(r['id']) || !str(r['statement']) || !PROPOSAL_STATES.includes(r['state'] as ProposalState)) return null;
  const executor = person(r['executor']);
  const o = rec(r['outcome']);
  const summary = o && str(o['summary']) ? { summary: o['summary'] } : {};
  const outcome: ProposalOutcomeView | null = o?.['kind'] === 'decision' ? { kind: 'decision', initiativeId: str(o['initiativeId']) ? o['initiativeId'] : null, ...summary }
    : o?.['kind'] === 'tool' && str(o['name']) ? { kind: 'tool', name: o['name'], ...summary } : null;
  if (!executor || !outcome) return null;
  const responses = (Array.isArray(r['responses']) ? r['responses'] : []).flatMap((x): ProposalResponseView[] => {
    const p = person(x); const xr = rec(x);
    if (!p || !xr || (xr['response'] !== 'consent' && xr['response'] !== 'object')) return [];
    return [{ ...p, response: xr['response'], reason: str(xr['reason']) ? xr['reason'] : null, at: Number(xr['at']) || 0 }];
  });
  const m = rec(r['missing']) ?? {};
  const you = rec(r['you']) ?? {};
  return {
    id: r['id'], callId: str(r['callId']) ? r['callId'] : null, statement: r['statement'], outcome, state: r['state'] as ProposalState, executor,
    source: r['source'] === 'asked' || r['source'] === 'dev' ? r['source'] : 'watcher', askedBy: person(r['askedBy']), heard: heardOf(r['heard']),
    recordsAs: r['recordsAs'] === 'decided' || r['recordsAs'] === 'waiting' ? r['recordsAs'] : null,
    named: (Array.isArray(r['named']) ? r['named'] : []).map(person).filter((p): p is ProposalPerson => !!p), responses,
    missing: {
      people: Array.isArray(m['people']) ? m['people'].filter(str) : [], more: Number(m['more']) || 0,
      objectedBy: Array.isArray(m['objectedBy']) ? m['objectedBy'].filter(str) : [],
    },
    dismissedBy: str(r['dismissedBy']) ? r['dismissedBy'] : null, dismissedByName: str(r['dismissedByName']) ? r['dismissedByName'] : null, createdAt: Number(r['createdAt']) || 0,
    run: runOf(r['run']), expiresAt: Number(r['expiresAt']) || null,
    you: {
      userId: str(you['userId']) ? you['userId'] : '', response: you['response'] === 'consent' || you['response'] === 'object' ? you['response'] : null,
      isExecutor: you['isExecutor'] === true, isNamed: you['isNamed'] === true, isAsker: you['isAsker'] === true, canRun: you['canRun'] === true,
      canDismiss: you['canDismiss'] === true, canReopen: you['canReopen'] === true, canRaiseAgain: you['canRaiseAgain'] === true,
    },
  };
}

export function parseProposals(raw: unknown): ProposalView[] {
  const list = rec(raw)?.['proposals'];
  return (Array.isArray(list) ? list : []).map(parseProposal).filter((p): p is ProposalView => !!p).sort((a, b) => a.createdAt - b.createdAt);
}

/** True while something can still change for this proposal by an answer. */
export const isAnswerable = (p: Pick<ProposalView, 'state'>): boolean => ANSWERABLE.includes(p.state);

// ---- the card ------------------------------------------------------------------------------------------------------------------

export type ChipState = 'waiting' | 'consented' | 'objected';
export interface PersonChip { userId: string; name: string; state: ChipState; label: string; tone: 'neutral' | 'success' | 'danger'; runsIt: boolean }

/**
 * What will be written, in plain words: the server's summary ("Create a work item titled …, owned by Lee"), or for a decision "Record
 * as a decision on Auth Migration". Never a tool name. `initiativeName` is null until it is known.
 */
export function outcomeLine(outcome: ProposalOutcomeView, initiativeName: string | null): string {
  if (outcome.kind === 'decision') return initiativeName ? `Record as a decision on ${initiativeName}` : outcome.summary ?? 'Record as a decision';
  return outcome.summary ?? 'Carry out the action people agreed';
}

/** Before it runs, whether a decision will be recorded as decided or as waiting for the owner's decision; null for anything else. */
export function recordsLine(p: Pick<ProposalView, 'recordsAs' | 'outcome' | 'state'>): string | null {
  if (p.outcome.kind !== 'decision' || !p.recordsAs || !isAnswerable(p)) return null;
  return p.recordsAs === 'decided' ? 'It will be recorded as decided.' : "It will be recorded as waiting for the initiative owner's decision.";
}

/** Who raised it: "Asked by Dana", or "Milo heard a decision" for one Milo raised from what it heard. */
export function eyebrowOf(p: Pick<ProposalView, 'source' | 'askedBy' | 'executor'>): string {
  return p.source === 'asked' ? `Asked by ${(p.askedBy ?? p.executor).name}` : `${ASSISTANT_NAME} heard a decision`;
}

/** One quoted line Milo heard, for the card and the deck: "“Let's cut over the smallest first.” Sam". */
export const heardText = (l: HeardLine): string => `“${l.text}” ${l.speaker}`;

const nameIn = (p: ProposalView, userId: string): string =>
  [p.executor, ...p.named, ...p.responses].find((x) => x.userId === userId)?.name ?? userId;

const joinWords = (parts: readonly string[]): string => (parts.length <= 1 ? parts[0] ?? '' : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`);

/** Whether this person's consent is still required (they are named or run it, and have not consented). */
export const isNeeded = (p: Pick<ProposalView, 'missing' | 'you'>): boolean => !!p.you.userId && p.missing.people.includes(p.you.userId);

/** "Needs you (runs it) and Priya." when the viewer is needed, else "Needs Priya (runs it) and one more person."; null once nobody is missing. */
export function needsLine(p: ProposalView): string | null {
  const me = p.you.userId;
  const ordered = [...p.missing.people.filter((u) => u === me), ...p.missing.people.filter((u) => u !== me)];
  const people = ordered.map((u) => `${u === me ? 'you' : nameIn(p, u)}${u === p.executor.userId ? ' (runs it)' : ''}`);
  const more = p.missing.more === 0 ? [] : [p.missing.more === 1 ? 'one more person' : `${p.missing.more} more people`];
  const parts = [...people, ...more];
  return parts.length ? `Needs ${joinWords(parts)}.` : null;
}

/** For someone whose consent is not required: their answer is optional. */
export const OPTIONAL_LINE = 'Your answer is optional: you can also consent or object.';

/** While objected, what clears it: "Blocked until Bob withdraws the objection, or someone raises it again." Every objector is named. */
export function blockedLine(p: ProposalView): string | null {
  if (p.state !== 'objected') return null;
  const objectors = p.responses.filter((r) => r.response === 'object').map((r) => (r.userId === p.you.userId ? 'you' : r.name));
  if (!objectors.length) return null;
  const verb = objectors.length > 1 ? 'withdraw their objections' : objectors[0] === 'you' ? 'withdraw your objection' : 'withdraws the objection';
  return `Blocked until ${joinWords(objectors)} ${verb}, or someone raises it again.`;
}

/** "Waiting on you · expires Tue, Nov 17, 3:00 PM" (or "Expires …") once the call has ended; null while it goes on or once finished. */
export function expiryLine(p: ProposalView, now = Date.now()): string | null {
  if (!p.expiresAt || !isAnswerable(p) || p.expiresAt <= now) return null;
  const when = new Date(p.expiresAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return waitingOnYou(p) ? `Waiting on you · expires ${when}` : `Expires ${when}`;
}

/** One chip per involved person (the executor, everyone named, everyone who answered), executor first. */
export function personChips(p: ProposalView): PersonChip[] {
  const order = [p.executor, ...p.named, ...p.responses];
  const seen = new Set<string>();
  const chips: PersonChip[] = [];
  for (const who of order) {
    if (seen.has(who.userId)) continue;
    seen.add(who.userId);
    const r = p.responses.find((x) => x.userId === who.userId);
    const state: ChipState = r ? (r.response === 'consent' ? 'consented' : 'objected') : 'waiting';
    const label = state === 'objected' && r?.reason ? `${who.name} · objected: ${r.reason}` : `${who.name} · ${state}`;
    chips.push({ userId: who.userId, name: who.name, state, label, tone: state === 'consented' ? 'success' : state === 'objected' ? 'danger' : 'neutral', runsIt: who.userId === p.executor.userId });
  }
  return chips;
}

/** The card's closing line for a state other than open; null while open (the needs line says it). */
export function stateLine(p: ProposalView): string | null {
  switch (p.state) {
    // Handed back (the executor may not run it, or was not there): the server's sentence says who can.
    case 'consented': return p.run?.note ?? (p.you.isExecutor ? 'Everyone needed has consented. Ready for you to run it.' : `Everyone needed has consented. Ready for ${p.executor.name} to run it.`);
    case 'objected': {
      const objections = p.responses.filter((r) => r.response === 'object').map((r) => `${r.name}${r.reason ? `: ${r.reason}` : ''}`);
      return objections.length ? `Objected by ${objections.join('; ')}` : 'Objected';
    }
    case 'dismissed': {
      if (p.run?.raisedAs) return 'Raised again as a new proposal';
      const who = p.dismissedBy && p.dismissedBy === p.you.userId ? 'you' : p.dismissedByName ?? (p.dismissedBy ? nameIn(p, p.dismissedBy) : null);
      const what = p.source === 'asked' ? 'Dropped' : p.outcome.kind === 'tool' ? 'Marked not needed' : 'Marked not a decision';
      return who ? `${what} by ${who}` : what;
    }
    case 'expired': return 'Expired without running';
    case 'running': return p.run?.by.userId === p.you.userId ? 'You are running it' : `${(p.run?.by ?? p.executor).name} is running it`;
    case 'done': {
      const what = p.outcome.kind !== 'decision' ? 'Done' : p.recordsAs === 'waiting' ? "Recorded as waiting for the owner's decision" : p.recordsAs === 'decided' ? 'Recorded as decided' : 'Recorded';
      return p.run?.title ? `${what} · ${p.run.title}` : what;
    }
    // The server's sentence says what went wrong and that nothing was changed.
    case 'failed': {
      const note = p.run?.note ?? `${ASSISTANT_NAME} could not carry this out, so nothing was changed.`;
      return p.run?.raisedAs ? `${note} Raised again as a new proposal.` : note;
    }
    default: return null;
  }
}

// ---- the deck ------------------------------------------------------------------------------------------------------------------

/**
 * Waiting on this person: it is open or objected and they are needed (named or running it) and have not answered, or the server says
 * they may run it now. Only these are counted on Milo's footer mark.
 */
export function waitingOnYou(p: ProposalView): boolean {
  if (p.state === 'consented') return p.you.canRun;
  return (p.state === 'open' || p.state === 'objected') && p.you.response === null && isNeeded(p);
}

/** Their answer is optional: open, they are not needed, and they have not answered. Asked after the waiting ones, never counted. */
export const optionalFor = (p: ProposalView): boolean => p.state === 'open' && p.you.response === null && !isNeeded(p);

/**
 * The proposals this person's deck asks about, oldest first: those waiting on them, then those where their answer is optional,
 * skipping any they set aside ("Not now", "Skip": `kept`, by `keptKey`). Answered ones are not asked again: withdrawing is on the card.
 */
export function deckQueue(proposals: readonly ProposalView[], kept: ReadonlySet<string> = new Set()): ProposalView[] {
  const live = proposals.filter((p) => isAnswerable(p) && !kept.has(keptKey(p)));
  return [...live.filter(waitingOnYou), ...live.filter((p) => !waitingOnYou(p) && optionalFor(p))];
}

/** How many of the deck's proposals are waiting on this person (the footer count). */
export const waitingCount = (queue: readonly ProposalView[]): number => queue.filter(waitingOnYou).length;

/** A set-aside run offer asks again after a new hand-back; a set-aside optional question stays aside. */
export const keptKey = (p: Pick<ProposalView, 'id' | 'you' | 'run' | 'state'>): string =>
  `${p.id}:${p.state === 'consented' && p.you.canRun ? `run:${p.run?.at ?? 0}` : p.you.response ?? 'ask'}`;

/** Someone other than the executor may run a consented proposal now (after a hand-back; the server's `you.canRun`). */
export const mayTakeOver = (p: Pick<ProposalView, 'you'>): boolean => p.you.canRun && !p.you.isExecutor;

/** The card's link to what was made: only once done, and only to a portal path. */
export const resultHref = (p: Pick<ProposalView, 'state' | 'run'>): string | null => (p.state === 'done' ? p.run?.href ?? null : null);

/**
 * The consent option's label. The executor's consent runs it only when it is the last one needed ("Consent and run" / "Consent and
 * record"); otherwise it is "Consent", and they are asked to run it once everyone needed has consented.
 */
export function consentLabel(p: Pick<ProposalView, 'outcome' | 'you' | 'missing' | 'state'>): string {
  const last = p.you.isExecutor && p.state === 'open' && p.missing.more === 0 && p.missing.people.length === 1 && p.missing.people[0] === p.you.userId;
  if (!last) return 'Consent';
  return p.outcome.kind === 'decision' ? 'Consent and record' : 'Consent and run';
}

/** "Not a decision" on a decision Milo heard, "Not needed" on a work item it heard, "Drop it" for the asker of an asked one. */
export const dismissLabel = (p: Pick<ProposalView, 'source' | 'outcome'>): string =>
  (p.source === 'asked' ? 'Drop it' : p.outcome.kind === 'tool' ? 'Not needed' : 'Not a decision');

/** The count on Milo's footer mark: "1 proposal", "2 proposals"; null at none. */
export const proposalCountWords = (n: number): string | null => (n <= 0 ? null : n === 1 ? '1 proposal' : `${n} proposals`);

export const RUN_NOW = 'Run it now';
export const RUN_HERE = 'Run it myself';

export const OBJECTION_SHARED = 'Why do you object? Everyone who can see this proposal will see your reason.';

// ---- the card's size --------------------------------------------------------------------------------------------------------

/**
 * How big and loud a proposal card is (the same four layouts as the action card's): `you` when it waits on the viewer, `others` while
 * it waits on someone else or runs, `done` once recorded or made (one row with a success mark and the link), `muted` once dismissed,
 * expired or failed (one quiet row with the reason, and Undo or Raise it again where they apply). Before the route's view arrives,
 * the message's state alone decides.
 */
export function proposalLayout(state: ProposalState, p: ProposalView | null): 'you' | 'others' | 'done' | 'muted' {
  if (state === 'done') return 'done';
  if (state === 'dismissed' || state === 'expired' || state === 'failed') return 'muted';
  return p && waitingOnYou({ ...p, state }) ? 'you' : 'others';
}

/** One person's accessible name on the card's avatar group: "Vera Green · consented · runs it". */
export const personLabel = (chip: Pick<PersonChip, 'label' | 'runsIt'>): string => (chip.runsIt ? `${chip.label} · runs it` : chip.label);
