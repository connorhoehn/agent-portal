// The decision watcher (docs/meeting-consent-design.md, "Detection" and package 5): it notices a decision in the call's STORED
// transcript and posts a proposal, without a sound and without touching the live session.
//
//   1. Each stored line is tested against a cheap trigger (TRIGGER: the minutes' DECISION pattern, widened).
//   2. On a hit it waits for a pause: no new line for QUIET_MS, at most MAX_WAIT_MS from the hit. It never checks while Milo is
//      answering (past the cap while it still is, the wait is dropped), never while paused (pause clears the wait), and never in a
//      call with fewer than two people seated.
//   3. It sends the last WINDOW_MS of lines (at most WINDOW_LINES; Milo's own echoes and unattributed pieces left out) to the model
//      (decision-model.ts) and reads a strict schema back (decision-prompt.ts).
//   4. A proposal is posted only when: the answer says it is a decision with confidence >= MIN_CONFIDENCE; its evidence lines are in
//      the window and come from two or more people; no watcher proposal of this call was posted in the last MIN_GAP_MS and fewer
//      than MAX_PER_CALL were in this listening period; no proposal of the call has the same normalised statement; and no dismissed ("Not a decision")
//      proposal of the call is near it (word overlap >= NEAR_DISMISSED). The caps and the suppression are read from the stored
//      proposals, so a restart keeps them. The proposal that reaches MAX_PER_CALL is followed by one notice to the call (once a period)
//      (capNotice): the count is read from the stored proposals, so it is said once, also across a restart.
//   5. The server builds the outcome: a decision on the call's initiative, or the "create" work-item arguments the minutes use.
//      The model's statement is shown, never executed. `named` keeps roster names only, mapped to user ids here.
//   6. The executor: the first named person who is seated now; else the initiative's owner when seated; else the person who spoke
//      the agreeing line (the last evidence line by someone other than the proposer). Package 1 needs an executor at posting, and
//      package 3's take-over still lets any consenter run it later.
//
// Money: each check is booked to the inviter under `meeting_assistant` (spend.ts, WatcherSpend) with its token cost; no check is
// made once the call's listening hold is used up. Privacy: no transcript text, prompt or answer is logged, only codes and counts.
// Lifetime: the per-call state is in memory only and is removed on stop; pause clears any wait, so nothing outlives the call.
import { CREATE_ACTIONS } from '../voice/catalogue.js';
import { estimateUsageCost } from '../pricing.js';
import { DECISION, resolveOwner, type RosterEntry } from './minutes.js';
import { createProposal } from './proposals.js';
import { DECISION_MODEL_ID, type CheckLine, type DecisionAnswer } from './decision-prompt.js';
import { makeDecisionModel, type DecisionModel, type ModelCheckResult } from './decision-model.js';
import { watcherSpend, type WatcherSpend } from './spend.js';
import { ASSISTANT_NAME } from './chat-types.js';
import type { AssistantStore } from './store.js';
import { periodOf, type AssistantRecord, type Proposal, type ProposalOutcome, type TranscriptLine } from './types.js';

/** The cheap trigger: the minutes' DECISION pattern, widened with the phrases people use when they settle something. */
export const TRIGGER = new RegExp(`${DECISION.source}|\\blet'?s go with\\b|\\bso we'?ll\\b|\\bi'?ll take\\b|\\bcan you own\\b`, 'i');
export const QUIET_MS = 6_000;
export const MAX_WAIT_MS = 45_000;
export const WINDOW_MS = 90_000;
export const WINDOW_LINES = 40;
export const MIN_CONFIDENCE = 0.8;
export const MIN_GAP_MS = 2 * 60_000;
export const MAX_PER_CALL = 8;
export const NEAR_DISMISSED = 0.6;
/** Said once a listening period, by the proposal that reaches the cap (the watcher's own, or one raised again). */
export const capNotice = (period = 1): string =>
  `${ASSISTANT_NAME} has raised ${MAX_PER_CALL} proposals ${period > 1 ? 'since it was invited back' : 'in this call'} and will not raise more. You can still ask ${ASSISTANT_NAME} to record a decision.`;

/**
 * When the current listening period began (0 for the first: all of it). The cap counts each period on its own, since each is paid for
 * on its own: an invitation back may raise MAX_PER_CALL more.
 */
export const periodStart = (record: Pick<AssistantRecord, 'session'> | null): number => record?.session?.periodFrom ?? 0;

/**
 * After a proposal of `source` was stored: when it is the one that brought the period's count to exactly MAX_PER_CALL, post the cap
 * notice. Read from the stored proposals, so a restart neither repeats it nor forgets it.
 */
export async function noticeIfCapReached(store: AssistantStore, callId: string, source: Proposal['source'], post: (callId: string, text: string) => Promise<void>): Promise<boolean> {
  if (source !== 'watcher') return false;
  const record = await store.get(callId).catch(() => null);
  const from = periodStart(record);
  const count = (await store.listProposals(callId)).filter((p) => p.source === 'watcher' && p.createdAt >= from).length;
  if (count !== MAX_PER_CALL) return false;
  await post(callId, capNotice(record ? periodOf(record) : 1));
  return true;
}

export type CheckCode =
  | 'posted' | 'gone' | 'not-listening' | 'alone' | 'cap' | 'too-soon' | 'budget' | 'one-speaker' | 'model-timeout' | 'model-error'
  | 'malformed' | 'not-a-decision' | 'low-confidence' | 'evidence' | 'duplicate' | 'suppressed' | 'no-outcome' | 'invalid' | 'assistant-busy';

export interface WatcherDeps {
  store: () => AssistantStore;
  clock: () => number;
  /** Active seat holders' user ids. */
  seated: (callId: string) => Promise<string[]>;
  nameOf: (userId: string) => Promise<string>;
  /** The initiative owner's user id, or null. */
  ownerOf: (initiativeId: string) => Promise<string | null>;
  initiativeName: (initiativeId: string) => Promise<string | null>;
  model?: () => DecisionModel;
  spend?: () => WatcherSpend;
  /** Is Milo answering in this call right now (speaking, or one of its tool calls open)? */
  assistantAnswering?: (callId: string) => boolean;
  /** Is this stored line Milo's own voice heard back? */
  isEcho?: (callId: string, line: TranscriptLine) => boolean;
  /** Posts one of Milo's notices to the call (never throws). Default: the call chat. */
  notice?: (callId: string, text: string) => Promise<void>;
  /** A one-shot timer; returns its canceller. Default: an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

interface Watch {
  callId: string;
  /** When the current wait began (the trigger line), or null when not waiting. */
  hitAt: number | null;
  lastLineAt: number;
  cancel: (() => void) | null;
  /** Bumped by pause and stop: a check begun before it never posts after it. */
  gen: number;
  checking: Promise<void> | null;
  counts: Record<string, number>;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/** Lowercase words only: the form duplicates are compared in. */
export const normaliseStatement = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
/** Word overlap of two statements (Jaccard over their word sets). */
export function similarity(a: string, b: string): number {
  const x = new Set(normaliseStatement(a).split(' ').filter(Boolean));
  const y = new Set(normaliseStatement(b).split(' ').filter(Boolean));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/** A roster name the model gave, as a person: the exact display name, or a first name only one person has. */
function personNamed(name: string, roster: readonly RosterEntry[]): RosterEntry | null {
  const exact = resolveOwner(name, roster);
  if (exact) return exact;
  const first = roster.filter((r) => r.name.split(/\s+/)[0] === name.trim());
  return first.length === 1 ? first[0]! : null;
}

export class DecisionWatcher {
  private readonly watches = new Map<string, Watch>();
  constructor(private readonly deps: WatcherDeps) {}

  private now(): number { return this.deps.clock(); }
  private schedule(fn: () => void, ms: number): () => void { return (this.deps.schedule ?? defaultSchedule)(fn, ms); }

  /** Begin watching a call (Milo joined or resumed after a restart). Idempotent. */
  start(callId: string): void {
    if (this.watches.has(callId)) return;
    this.watches.set(callId, { callId, hitAt: null, lastLineAt: 0, cancel: null, gen: 0, checking: null, counts: {} });
  }

  /** Paused: the wait is dropped and a check under way will not post. Watching carries on when lines are stored again. */
  pause(callId: string): void {
    const w = this.watches.get(callId);
    if (!w) return;
    this.clearWait(w);
    w.gen += 1;
  }

  /** Milo left or was dismissed: everything of this call is dropped. */
  stop(callId: string): void {
    const w = this.watches.get(callId);
    if (!w) return;
    this.clearWait(w);
    w.gen += 1;
    this.watches.delete(callId);
  }

  dispose(): void { for (const id of [...this.watches.keys()]) this.stop(id); }
  isWatching(callId: string): boolean { return this.watches.has(callId); }
  isWaiting(callId: string): boolean { return this.watches.get(callId)?.hitAt != null; }
  /** Codes and counts only (tests, the dev view). */
  stats(callId: string): Record<string, number> { return { ...(this.watches.get(callId)?.counts ?? {}) }; }
  /** Wait for a check under way (tests). */
  async idle(callId: string): Promise<void> { await this.watches.get(callId)?.checking; }

  /** A line was stored. Unattributed pieces and Milo's echoes neither trigger nor reset the wait. */
  onLine(line: TranscriptLine): void {
    const w = this.watches.get(line.callId);
    if (!w || line.userId === null) return;
    if (this.deps.isEcho?.(line.callId, line)) return;
    w.lastLineAt = this.now();
    if (w.hitAt === null) {
      if (!TRIGGER.test(line.text)) return;
      w.hitAt = w.lastLineAt;
      this.count(w, 'trigger');
    }
    this.arm(w);
  }

  private clearWait(w: Watch): void {
    w.cancel?.(); w.cancel = null; w.hitAt = null;
  }

  private count(w: Watch, code: string): void { w.counts[code] = (w.counts[code] ?? 0) + 1; }

  private arm(w: Watch, delay?: number): void {
    w.cancel?.();
    const hitAt = w.hitAt!;
    const now = this.now();
    const due = delay !== undefined ? now + delay : Math.min(w.lastLineAt + QUIET_MS, hitAt + MAX_WAIT_MS);
    const gen = w.gen;
    w.cancel = this.schedule(() => { w.cancel = null; this.fire(w, gen); }, Math.max(0, Math.min(due, hitAt + MAX_WAIT_MS) - now));
  }

  private fire(w: Watch, gen: number): void {
    if (w.gen !== gen || this.watches.get(w.callId) !== w || w.hitAt === null) return;
    const now = this.now();
    const capAt = w.hitAt + MAX_WAIT_MS;
    if (this.deps.assistantAnswering?.(w.callId) || w.checking) {
      // Never while Milo is answering (or a check is still out): try again after a quiet spell, but not past the cap.
      if (now >= capAt) { this.clearWait(w); this.finish(w, 'assistant-busy', 0); return; }
      this.arm(w, Math.min(QUIET_MS, capAt - now));
      return;
    }
    w.hitAt = null;
    const run: Promise<void> = this.check(w, gen)
      .catch((e: unknown) => { this.finish(w, 'model-error', 0); console.warn('[meeting-assistant] decision check failed', (e as Error)?.name ?? 'error'); })
      .finally(() => { if (w.checking === run) w.checking = null; });
    w.checking = run;
  }

  private finish(w: Watch, code: CheckCode, lines: number): void {
    this.count(w, code);
    console.info('[meeting-assistant] decision check', code, `lines=${lines}`);
  }

  /** One check: the gates, the model, the rules, then the proposal. */
  private async check(w: Watch, gen: number): Promise<void> {
    const store = this.deps.store();
    const live = (): boolean => w.gen === gen && this.watches.get(w.callId) === w;
    const record = await store.get(w.callId);
    if (!record || !live()) { this.finish(w, 'gone', 0); return; }
    if (record.state !== 'listening') { this.finish(w, 'not-listening', 0); return; }
    const seated = new Set(await this.deps.seated(w.callId).catch(() => [] as string[]));
    if (seated.size < 2) { this.finish(w, 'alone', 0); return; }
    const now = this.now();
    const existing = await store.listProposals(w.callId);
    const mine = existing.filter((p) => p.source === 'watcher');
    const from = periodStart(record);
    if (mine.filter((p) => p.createdAt >= from).length >= MAX_PER_CALL) { this.finish(w, 'cap', 0); return; }
    if (mine.some((p) => now - p.createdAt < MIN_GAP_MS)) { this.finish(w, 'too-soon', 0); return; }
    const spend = (this.deps.spend ?? watcherSpend)();
    if (!spend.allowed(record, now)) { this.finish(w, 'budget', 0); return; }

    const window = await this.windowOf(record, now);
    if (new Set(window.map((l) => l.userId)).size < 2) { this.finish(w, 'one-speaker', window.length); return; }
    const roster = await this.rosterOf(record, seated);
    const names = new Map(roster.map((r) => [r.userId, r.name]));
    const lines: CheckLine[] = window.map((l) => ({ seq: l.seq, speaker: names.get(l.userId!) ?? (l.speakerName && l.speakerName !== l.userId ? l.speakerName : 'Someone'), text: l.text }));

    const model = (this.deps.model ?? makeDecisionModel)();
    const result = await model.check({ lines, roster: roster.map((r) => r.name) });
    if (result.sent) await this.book(record, model, result, now);
    if (!live()) { this.finish(w, 'gone', window.length); return; }
    if (result.code === 'timeout' || result.code === 'error') { this.finish(w, result.code === 'timeout' ? 'model-timeout' : 'model-error', window.length); return; }
    const answer = result.answer;
    if (!answer) { this.finish(w, 'malformed', window.length); return; }
    const verdict = await this.judge(record, answer, window, roster, seated, existing);
    if (typeof verdict === 'string') { this.finish(w, verdict, window.length); return; }

    // Read the state once more right before posting: a pause or a stop during the check posts nothing.
    const again = await store.get(w.callId);
    if (!live() || !again || again.state !== 'listening') { this.finish(w, 'gone', window.length); return; }
    try {
      await createProposal(store, { callId: w.callId, tenant: record.tenant, statement: answer.statement, outcome: verdict.outcome, named: verdict.named, executor: verdict.executor, source: 'watcher', evidence: verdict.evidence, at: this.now() });
    } catch {
      this.finish(w, 'invalid', window.length); return;
    }
    this.finish(w, 'posted', window.length);
    await noticeIfCapReached(store, w.callId, 'watcher', this.deps.notice ?? (async () => undefined)).catch(() => false);
  }

  /** The window: the last WINDOW_MS of stored lines, at most WINDOW_LINES, attributed and not Milo's echo. */
  private async windowOf(record: AssistantRecord, now: number): Promise<TranscriptLine[]> {
    const recent = await this.deps.store().lines(record.callId, Math.max(0, record.nextSeq - 1 - WINDOW_LINES), WINDOW_LINES);
    return recent.filter((l) => l.at >= now - WINDOW_MS && l.userId !== null && !this.deps.isEcho?.(record.callId, l)).slice(-WINDOW_LINES);
  }

  /** Everyone who held a seat while Milo was in the call, and everyone seated now, by display name. */
  private async rosterOf(record: AssistantRecord, seated: Set<string>): Promise<RosterEntry[]> {
    const ids = [...new Set([...record.attendees, ...seated, record.invitedBy])];
    return Promise.all(ids.map(async (userId) => ({ userId, name: await this.deps.nameOf(userId).catch(() => userId) })));
  }

  /** The rules of step 4 to 6: a verdict to post, or the code it was dropped for. */
  private async judge(record: AssistantRecord, answer: DecisionAnswer, window: TranscriptLine[], roster: RosterEntry[], seated: Set<string>, existing: Proposal[]): Promise<CheckCode | { outcome: ProposalOutcome; named: string[]; executor: string; evidence: number[] }> {
    if (!answer.isDecision || answer.outcome === 'none') return 'not-a-decision';
    if (answer.confidence < MIN_CONFIDENCE) return 'low-confidence';
    const bySeq = new Map(window.map((l) => [l.seq, l]));
    const evidence = answer.evidence.filter((n) => bySeq.has(n)).sort((a, b) => a - b);
    const speakers = evidence.map((n) => bySeq.get(n)!.userId!);
    if (new Set(speakers).size < 2) return 'evidence';
    const norm = normaliseStatement(answer.statement);
    if (!norm) return 'not-a-decision';
    if (existing.some((p) => normaliseStatement(p.statement) === norm)) return 'duplicate';
    if (existing.some((p) => p.state === 'dismissed' && similarity(p.statement, answer.statement) >= NEAR_DISMISSED)) return 'suppressed';

    const named = [...new Set(answer.named.map((n) => personNamed(n, roster)?.userId).filter((u): u is string => !!u))];
    let outcome: ProposalOutcome;
    if (answer.outcome === 'decision') {
      if (!record.initiativeId || CREATE_ACTIONS[record.tenant]?.['decision'] === undefined) return 'no-outcome';
      outcome = { kind: 'decision', initiativeId: record.initiativeId };
    } else {
      if (CREATE_ACTIONS[record.tenant]?.['work-item'] === undefined) return 'no-outcome';
      const { createWorkItemArgs } = await import('./minutes-service.js');
      const initiativeName = record.initiativeId ? await this.deps.initiativeName(record.initiativeId).catch(() => null) : null;
      outcome = { kind: 'tool', name: 'create', args: createWorkItemArgs(answer.statement, initiativeName) };
    }

    const proposer = speakers[0]!;
    const agreeing = [...speakers].reverse().find((u) => u !== proposer)!;
    let executor = named.find((u) => seated.has(u)) ?? null;
    if (!executor && record.initiativeId) {
      const owner = await this.deps.ownerOf(record.initiativeId).catch(() => null);
      if (owner && seated.has(owner)) executor = owner;
    }
    return { outcome, named, executor: executor ?? agreeing, evidence };
  }

  /** Book the check to the inviter: the provider's counts when given, else the estimate. A booking failure is logged, never thrown. */
  private async book(record: AssistantRecord, model: DecisionModel, result: ModelCheckResult, now: number): Promise<void> {
    const usage = result.usage ?? result.estimate;
    const reported = result.usage !== null && model.kind === 'bedrock';
    const costUsd = estimateUsageCost(DECISION_MODEL_ID, usage);
    try {
      await (this.deps.spend ?? watcherSpend)().record({
        callId: record.callId, inviterId: record.invitedBy, initiativeId: record.initiativeId, n: now, model: model.modelId, costUsd,
        basis: costUsd === null ? 'unknown' : reported ? 'reported' : 'estimated', tokensIn: usage.inputTokens, tokensOut: usage.outputTokens,
      });
    } catch (e) {
      console.warn('[meeting-assistant] decision check spend not booked', (e as Error)?.name ?? 'error');
    }
  }
}

/** The process's dependencies: seats from the call chat runtime, names from identity, the owner and name from the initiative. */
export function defaultWatcherDeps(over: Partial<WatcherDeps> & Pick<WatcherDeps, 'store' | 'clock'>): WatcherDeps {
  return {
    seated: async (callId) => {
      const { callChatRuntime } = await import('../call-chat.js');
      return (await callChatRuntime().seatedUsers(callId)).filter((u) => u.active).map((u) => u.userId);
    },
    nameOf: async (userId) => (await import('./chat.js')).nameOf(userId),
    ownerOf: async (initiativeId) => {
      const [{ getProject }, { userForPerson }] = await Promise.all([import('../../providers/projects.js'), import('../social-notify.js')]);
      return userForPerson((await getProject(initiativeId))?.ownerId ?? null);
    },
    initiativeName: async (initiativeId) => (await (await import('../../providers/projects.js')).getProject(initiativeId))?.name ?? null,
    notice: async (callId, text) => (await import('./chat.js')).postNoticeQuietly(callId, text),
    ...over,
  };
}
