// Proposals Nova notices in a call, as the portal reads them (docs/meeting-consent-design.md). The shapes mirror the proposals route
// in middleware/src/routes/meeting-assistant.ts (`proposalView`); change both together.
//
// The rules kept here: the card in the chat only shows; answers are given in the deck. The deck asks one proposal at a time, oldest
// first, and only proposals this person may still answer; after answering the same person may withdraw from the deck. An objection's
// reason is shared with everyone in the call and the deck says so before it is sent.

export type ProposalState = 'open' | 'consented' | 'running' | 'done' | 'failed' | 'objected' | 'dismissed' | 'expired';
export const PROPOSAL_STATES: readonly ProposalState[] = ['open', 'consented', 'running', 'done', 'failed', 'objected', 'dismissed', 'expired'];
export type ProposalResponseKind = 'consent' | 'object';
export type ProposalAnswer = 'consent' | 'object' | 'withdraw' | 'not-a-decision';

export interface ProposalPerson { userId: string; name: string }
export interface ProposalResponseView extends ProposalPerson { response: ProposalResponseKind; reason: string | null; at: number }
export type ProposalOutcomeView = { kind: 'decision'; initiativeId: string | null } | { kind: 'tool'; name: string };

export interface ProposalRunView { by: ProposalPerson; at: number; title: string | null; href: string | null; note: string | null }

export interface ProposalView {
  id: string;
  statement: string;
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
  you: { userId: string; response: ProposalResponseKind | null; isExecutor: boolean; isNamed: boolean; canRun: boolean };
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
  return { by, at: Number(r['at']) || 0, title: str(r['title']) ? r['title'] : null, href: portalPath(r['href']), note: str(r['note']) ? r['note'] : null };
};

/** One proposal from the route's JSON; null when malformed (it is then left out, never drawn half). */
export function parseProposal(raw: unknown): ProposalView | null {
  const r = rec(raw);
  if (!r || !str(r['id']) || !str(r['statement']) || !PROPOSAL_STATES.includes(r['state'] as ProposalState)) return null;
  const executor = person(r['executor']);
  const o = rec(r['outcome']);
  const outcome: ProposalOutcomeView | null = o?.['kind'] === 'decision' ? { kind: 'decision', initiativeId: str(o['initiativeId']) ? o['initiativeId'] : null }
    : o?.['kind'] === 'tool' && str(o['name']) ? { kind: 'tool', name: o['name'] } : null;
  if (!executor || !outcome) return null;
  const responses = (Array.isArray(r['responses']) ? r['responses'] : []).flatMap((x): ProposalResponseView[] => {
    const p = person(x); const xr = rec(x);
    if (!p || !xr || (xr['response'] !== 'consent' && xr['response'] !== 'object')) return [];
    return [{ ...p, response: xr['response'], reason: str(xr['reason']) ? xr['reason'] : null, at: Number(xr['at']) || 0 }];
  });
  const m = rec(r['missing']) ?? {};
  const you = rec(r['you']) ?? {};
  return {
    id: r['id'], statement: r['statement'], outcome, state: r['state'] as ProposalState, executor,
    named: (Array.isArray(r['named']) ? r['named'] : []).map(person).filter((p): p is ProposalPerson => !!p), responses,
    missing: {
      people: Array.isArray(m['people']) ? m['people'].filter(str) : [], more: Number(m['more']) || 0,
      objectedBy: Array.isArray(m['objectedBy']) ? m['objectedBy'].filter(str) : [],
    },
    dismissedBy: str(r['dismissedBy']) ? r['dismissedBy'] : null, dismissedByName: str(r['dismissedByName']) ? r['dismissedByName'] : null, createdAt: Number(r['createdAt']) || 0,
    run: runOf(r['run']), expiresAt: Number(r['expiresAt']) || null,
    you: {
      userId: str(you['userId']) ? you['userId'] : '', response: you['response'] === 'consent' || you['response'] === 'object' ? you['response'] : null,
      isExecutor: you['isExecutor'] === true, isNamed: you['isNamed'] === true, canRun: you['canRun'] === true,
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

/** "Record as a decision on Auth Migration", or the tool it runs. `initiativeName` is null until it is known. */
export function outcomeLine(outcome: ProposalOutcomeView, initiativeName: string | null): string {
  if (outcome.kind === 'decision') return initiativeName ? `Record as a decision on ${initiativeName}` : 'Record as a decision';
  return `Run ${outcome.name.replace(/[_.-]+/g, ' ')}`;
}

const nameIn = (p: ProposalView, userId: string): string =>
  [p.executor, ...p.named, ...p.responses].find((x) => x.userId === userId)?.name ?? userId;

/** "Needs: Priya (runs it), one more." — who still has to consent; null once nobody is missing. */
export function needsLine(p: ProposalView): string | null {
  const people = p.missing.people.map((u) => (u === p.executor.userId ? `${nameIn(p, u)} (runs it)` : nameIn(p, u)));
  const more = p.missing.more === 0 ? [] : [p.missing.more === 1 ? 'one more' : `${p.missing.more} more`];
  const parts = [...people, ...more];
  return parts.length ? `Needs: ${parts.join(', ')}.` : null;
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
    // Handed back (the executor may not run it, or their browser was not there): the server's sentence says who can.
    case 'consented': return p.run?.note ?? `Consented, waiting for ${p.executor.name} to run it`;
    case 'objected': {
      const first = p.responses.find((r) => r.response === 'object');
      return first ? `Objected by ${first.name}${first.reason ? `: ${first.reason}` : ''}` : 'Objected';
    }
    case 'dismissed': {
      const who = p.dismissedByName ?? (p.dismissedBy ? nameIn(p, p.dismissedBy) : null);
      return who ? `Marked not a decision by ${who}` : 'Marked not a decision';
    }
    case 'expired': return 'Expired without running';
    case 'running': return `Running in ${(p.run?.by ?? p.executor).name}'s browser`;
    case 'done': {
      const what = p.outcome.kind === 'decision' ? 'Recorded' : 'Done';
      return p.run?.title ? `${what} · ${p.run.title}` : what;
    }
    case 'failed': return p.run?.note ? `Failed: ${p.run.note}` : 'Failed';
    default: return null;
  }
}

// ---- the deck ------------------------------------------------------------------------------------------------------------------

/**
 * The proposals this person's deck asks about, oldest first: first those still waiting for their answer (not yet consented, so a new
 * answer can matter), then those they answered (to withdraw), skipping any they chose to keep as answered (`kept`, by `id:response`).
 */
export function deckQueue(proposals: readonly ProposalView[], kept: ReadonlySet<string> = new Set()): ProposalView[] {
  const live = proposals.filter(isAnswerable);
  const ask = live.filter((p) => p.you.response === null && p.state !== 'consented');
  const answered = live.filter((p) => p.you.response !== null && !kept.has(keptKey(p)));
  return [...ask, ...answered];
}

/** A hand-back after the answer was kept asks again: the offer to run it is new. */
export const keptKey = (p: Pick<ProposalView, 'id' | 'you' | 'run'>): string => `${p.id}:${p.you.response ?? ''}${mayTakeOver(p) && p.run ? `:${p.run.at}` : ''}`;

/** A consenter who is not the executor may run a consented proposal in their own browser (the server's `you.canRun`). */
export const mayTakeOver = (p: Pick<ProposalView, 'you'>): boolean => p.you.canRun && !p.you.isExecutor;

/** The card's link to what was made: only once done, and only to a portal path. */
export const resultHref = (p: Pick<ProposalView, 'state' | 'run'>): string | null => (p.state === 'done' ? p.run?.href ?? null : null);

/** The consent option's label: the executor's consent is the one that runs it. */
export function consentLabel(p: Pick<ProposalView, 'outcome' | 'you'>): string {
  if (!p.you.isExecutor) return 'Consent';
  return p.outcome.kind === 'decision' ? 'Consent and record' : 'Consent and run';
}

/** The count on Nova's footer mark: "1 proposal", "2 proposals"; null at none. */
export const proposalCountWords = (n: number): string | null => (n <= 0 ? null : n === 1 ? '1 proposal' : `${n} proposals`);

export const RUN_HERE = 'Run it in my browser';

export const OBJECTION_SHARED = 'Everyone in the call will see this';
