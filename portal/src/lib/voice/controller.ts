// The dock's session controller: the client's frames in, the phase machine,
// the tool runner and the confirm card out (docs/voice-navigator-spec.md §3,
// §5, §7). React-free (VoiceFooterPane subscribes through
// useSyncExternalStore), so the whole loop runs under `node --test` against
// a mock mint.
//
// The tool loop, per delegation (§1 "P3 tool result"):
//   session.delegation.created           -> executing
//   response.event / output_item.done    -> prepare the call (schema, tenant,
//      { function_call }                    can()); a confirm tool with a real
//                                           runner shows the card (confirming),
//                                           anything else runs at once
//   the call settles                     -> response.item.create with the
//                                           shaped output; a /events row with
//                                           the args' sha256
//   nested response.completed, and no    -> exactly one response.create
//      call of the delegation still open
//   the continuation's response.completed -> the delegation is done
//      with nothing new to answer
// `response.completed` arrives BEFORE the result is sent (V1), so it is never
// read as "the call is done"; a result that settles first waits for it (and
// COMPLETION_GRACE_MS, should it never come).
//
// A confirm tool with a planner (actions.ts: start_computer, run_command,
// send_chat_message) runs it first, reads only, so the card shows the resolved
// target and the composed command; a planner may end the call without a card
// (a refusal, several matching names). Nothing acts before the confirm, and a
// cancel answers { confirmed: false } and runs nothing.
//
// Money (§7): the controller meters elapsed/60 × the mint's rate against the
// hold, privately (the owner's rule: no dollar figure in the dock while a
// session runs, so the snapshot carries none); at 90% the voice says how many
// minutes are left once (commentary), at 100% (or the mint's maxSeconds) the
// dock hangs up itself with reason `cutoff`. A mint that answers 409 on the
// user's budget shows a card ("This session will exceed your budget by $x");
// Confirm mints again with confirmOverUserBudget. The user's daily voice
// minutes (G13) are the server's: a mint refused on them is the dock's
// `unavailable` reason (client.ts dailyMinutesText), and a session they cut
// short (the mint's `dailyMinutesLeft`) says how much of today is left.
//
// Confirming by voice (sweep 2 M2): only the user's first utterance after the
// card decides, and only once it has ended (a quiet UTTERANCE_GAP_MS, or the
// next word starting UTTERANCE_SPLIT_MS after the last one in the audio): an
// affirmation at its start confirms ("yes", "yeah", "yep", "confirm", "do
// it", "go ahead"; "ok", "okay" and "sure" only as the whole utterance), and
// any utterance with "instead", "no", "cancel", "wait" (and the like) cancels
// as soon as it is heard. Anything else leaves the card to a click.
//
// Every card the dock raises carries a fresh `requestId` (the library's
// VoicePending / VoicePendingChoice key, 2.510.5), so two requests with one
// title never share a card's state. The choice card no longer moves the phase:
// the library opens it on `pendingChoice` alone.

import { VoiceClient, type ClientEvent, type MediaFactory, type StopReason, type VoiceFrame, type VoiceMint } from './client.ts';
import { initialMachine, phaseAt, reduce, sessionOpen, type MachineEvent, type MachineState, type VoicePhase } from './machine.ts';
import {
  cancelledResult, hashToolArgs, localHref, openableHref, planPreparedCall, prepareToolCall, refused, runPreparedCall, spokenOrdinal, toolAvailable,
  type ConfirmPlan, type PreparedCall, type ToolContext, type ToolResult, type VoiceToolPlanner, type VoiceToolRunner,
} from './tools.ts';
import { VOICE_PLANNERS, VOICE_RUNNERS } from './actions.ts';
import { DEFAULT_TOAST_SECONDS } from './work.ts';

export const TICK_MS = 100;
export const COMPLETION_GRACE_MS = 1500;
export const BUDGET_WARN_RATIO = 0.9;
const MAX_TURNS = 50;

export type ToolStatus = 'running' | 'done' | 'refused' | 'failed';

export interface VoiceTurnView {
  id: string;
  role: 'you' | 'assistant';
  text: string;
  at: number;
  toolCalls?: Array<{ name: string; status: ToolStatus; summary: string }>;
}

export interface VoicePendingView {
  callId: string;
  /** Unique per card raised (the library remounts the card when it changes). */
  requestId: number;
  tool: string;
  title: string;
  detail?: string;
}

/**
 * Several records matched a name (open's `ambiguous`, catalogue v2 V2-4): the
 * library's VoiceChoiceCard shows them; the user picks by click or by saying
 * the number, which the dock passes to the card as `ordinal`.
 */
export interface VoiceChoiceView {
  id: string;
  /** Unique per card raised, from the same counter as VoicePendingView's. */
  requestId: number;
  title: string;
  candidates: ReadonlyArray<{ title: string; subtitle?: string; kind?: string; href?: string }>;
  /** 1-based, set when the user said a number; the card chooses that row. */
  ordinal?: number;
}

export interface VoiceSnapshot {
  phase: VoicePhase;
  level: number;
  outputLevel: number;
  elapsedSeconds: number;
  pending: VoicePendingView | null;
  /** The numbered choice an ambiguous name left, or null. */
  choice: VoiceChoiceView | null;
  lastLine: { role: 'you' | 'assistant'; text: string } | null;
  turns: readonly VoiceTurnView[];
  muted: boolean;
  /** Why unavailable, or why the last session ended early. */
  reason: string | null;
  /** The figure the last close reported, once it has. */
  closedSeconds: number | null;
}

type Timer = unknown;

export interface ControllerOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  media: MediaFactory | null;
  /** The tool context at call time (tenant, role, can(), the router). */
  toolContext(): ToolContext;
  runners?: Readonly<Record<string, VoiceToolRunner>>;
  /** What runs before a confirm card (default: actions.ts VOICE_PLANNERS); a tool without one shows describeConfirm's card. */
  planners?: Readonly<Record<string, VoiceToolPlanner>>;
  /** The card's wording, over the planner's own and defaultConfirmText. */
  describeConfirm?(call: PreparedCall, plan: ConfirmPlan | null): { title: string; detail?: string } | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
  /** Re-evaluate time-based phases, levels and the budget. Default: an interval of TICK_MS. */
  autoTick?: boolean;
  closeWaitMs?: number;
}

interface CallRecord { name: string; status: 'confirming' | 'running' | 'answered' }
interface DelegationRecord { calls: Map<string, CallRecord>; completed: boolean; unanswered: number; grace: Timer | null }
/** What the card has heard: the first utterance after it, and whether that utterance has ended. */
interface Heard { text: string; lastEndMs: number | null; quiet: Timer | null; done: boolean }
interface Pending { callId: string; delegationId: string; call: PreparedCall; plan: ConfirmPlan | null; startedAt: number; heard: Heard; view: VoicePendingView }

/** The card id of a mint that waits on the user's budget (not a tool call). */
export const BUDGET_CARD = 'voice-budget';

/** The 409 card: how far over the session goes, from the mint's estimate and what the budget has left. */
export function budgetConfirmText(b: { estimateUsd: number | null; remainingUsd: number | null; reason: string | null }): { title: string; detail: string } {
  const over = b.estimateUsd != null && b.remainingUsd != null ? Math.max(0, b.estimateUsd - Math.max(0, b.remainingUsd)) : null;
  const usd = (v: number) => `$${v < 1 ? v.toFixed(2) : v.toFixed(2).replace(/\.00$/, '')}`;
  return {
    title: 'Over your budget',
    detail: over != null && over > 0
      ? `This session will exceed your budget by ${usd(over)}. Start it anyway?`
      : `${b.reason ?? 'This session goes over your budget.'} Start it anyway?`,
  };
}

/** Wall-clock quiet after the last word that ends the utterance. */
export const UTTERANCE_GAP_MS = 700;
/** An audio gap between two words (start_ms − the last end_ms) that starts a new utterance. */
export const UTTERANCE_SPLIT_MS = 300;

const AFFIRM = /^[\s"'“]*(yes|yeah|yep|confirm(ed)?|do it|go ahead)\b/i;
const BARE_OK = /^[\s"'“]*(ok|okay|sure)[\s.!,"'”]*$/i;
const CANCEL = /\b(instead|no|nope|cancel|wait|stop|don'?t|never ?mind)\b/i;

/**
 * The card's answer from the first utterance after it: `cancel` as soon as a
 * cancelling word is heard, `confirm` only once the utterance has ended and
 * starts with an affirmation (or is only "ok", "okay" or "sure"), else null.
 */
export function confirmDecision(utterance: string, ended: boolean): 'confirm' | 'cancel' | null {
  if (CANCEL.test(utterance)) return 'cancel';
  if (!ended) return null;
  return AFFIRM.test(utterance) || BARE_OK.test(utterance) ? 'confirm' : null;
}

/** The default card wording per tool, before (or without) a planner: the tool and its arguments, as plain text. */
export function defaultConfirmText(call: PreparedCall): { title: string; detail?: string } {
  const a = call.args;
  if (call.spec.name === 'send_chat_message') {
    const target = (a['target'] ?? {}) as Record<string, unknown>;
    const where = target['kind'] === 'dm' ? String(target['name']) : `#${String(target['name'])}`;
    return { title: `Post to ${where}`, detail: String(a['text'] ?? '') };
  }
  if (call.spec.name === 'start_computer') {
    const ids = Array.isArray(a['initiativeIds']) ? (a['initiativeIds'] as string[]) : [];
    return { title: ids.length === 1 ? `Start a computer for ${ids[0]}` : `Start ${ids.length} computers`, detail: `${ids.join(', ')}. A running computer bills idle time until it stops.` };
  }
  if (call.spec.name === 'run_command') {
    return { title: `Run on ${String(a['computerId'])}`, detail: String(a['phrase']).replace(/-/g, ' ') };
  }
  const detail = Object.entries(a).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ');
  return { title: call.spec.name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), ...(detail ? { detail } : {}) };
}

export class VoiceController {
  private machine: MachineState = initialMachine;
  private client: VoiceClient | null = null;
  private mint: VoiceMint | null = null;
  private delegations = new Map<string, DelegationRecord>();
  private pending: Pending | null = null;
  private choice: (VoiceChoiceView & { heard: string }) | null = null;
  private choiceSeq = 0;
  /** One per card raised (confirm, choice, budget): the library's requestId. */
  private requestSeq = 0;
  private budgetCard: VoicePendingView | null = null;
  private turns: VoiceTurnView[] = [];
  private turnSeq = 0;
  private levels = { input: 0, output: 0 };
  private muted = false;
  private warned = false;
  private lastToastSeconds = DEFAULT_TOAST_SECONDS;
  private elapsedFrozen: number | null = null;
  private closedSeconds: number | null = null;
  /** Sessions this dock minted and the seconds their close reported (for a mint's `session-open` 409). */
  private ownSessions = new Map<string, number>();
  private snapshot: VoiceSnapshot;
  private listeners = new Set<() => void>();
  private ticker: Timer | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;
  private readonly runners: Readonly<Record<string, VoiceToolRunner>>;
  private readonly planners: Readonly<Record<string, VoiceToolPlanner>>;

  private readonly opts: ControllerOptions;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.runners = opts.runners ?? VOICE_RUNNERS;
    this.planners = opts.planners ?? VOICE_PLANNERS;
    this.snapshot = this.build();
  }

  // ── store ────────────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): VoiceSnapshot => this.snapshot;

  /** Re-read levels, phases that depend on time, and the budget. */
  tick(): void {
    if (this.client && this.machine.base === 'live') {
      const l = this.client.levels();
      this.levels = { input: l.input, output: l.output };
      this.dispatch({ type: 'levels', at: this.now(), input: l.input, output: l.output }, false);
      this.checkBudget();
    }
    this.publish();
  }

  // ── commands ─────────────────────────────────────────────────────────────

  async start(opts: { confirmOverUserBudget?: boolean } = {}): Promise<void> {
    if (sessionOpen(this.machine)) return;
    this.reset();
    this.dispatch({ type: 'start' });
    const client = new VoiceClient({
      fetch: this.opts.fetch, media: this.opts.media, onEvent: (e) => this.onClientEvent(client, e),
      now: this.now, setTimer: this.setTimer, clearTimer: this.clearTimer,
      knownSeconds: (id) => this.ownSessions.get(id) ?? null,
      ...(this.opts.closeWaitMs !== undefined ? { closeWaitMs: this.opts.closeWaitMs } : {}),
    });
    this.client = client;
    if (this.opts.autoTick !== false) this.startTicker();
    await client.start(opts.confirmOverUserBudget ? { confirmOverUserBudget: true } : {});
  }

  async stop(reason: StopReason = 'closed'): Promise<void> {
    const client = this.client;
    if (!client || !sessionOpen(this.machine)) return;
    // A card still up is answered as cancelled so the row records it.
    if (this.pending) this.resolvePending(false, 'click');
    this.clearChoice();
    this.dispatch({ type: 'stop' });
    await client.stop(reason);
  }

  toggle(): Promise<void> {
    return sessionOpen(this.machine) ? this.stop('closed') : this.start();
  }

  toggleMute(): void {
    if (!this.client || this.machine.base !== 'live') return;
    this.muted = !this.muted;
    this.client.setMuted(this.muted);
    this.publish();
  }

  confirm(by: 'voice' | 'click' = 'click'): void {
    if (this.budgetCard) { this.budgetCard = null; void this.start({ confirmOverUserBudget: true }); return; }
    this.resolvePending(true, by);
  }
  cancel(by: 'voice' | 'click' = 'click'): void {
    if (this.budgetCard) {
      this.budgetCard = null;
      this.dispatch({ type: 'unavailable', reason: 'Not started: this session would go over your budget.' });
      return;
    }
    this.resolvePending(false, by);
  }

  /**
   * A background job queue_work queued has ended (G19, work.ts): while the
   * session is live the voice says it (session.commentary.append) and the
   * transcript keeps the line; after it, the toast and the notification carry it.
   */
  noteJobOutcome(line: string): void {
    if (this.machine.base !== 'live' || !this.client) return;
    this.client.appendCommentary(`Tell the user: ${line}`);
    this.addLine('assistant', line);
  }

  /** How long a job toast stays once its job ends: the last mint's VOICE_TOAST_SECONDS, else the default. */
  toastSeconds(): number {
    return this.lastToastSeconds;
  }

  /**
   * The user picked row `index` of the choice card (by click, or the card acting on the spoken ordinal): open its
   * href, which the open runner built and checked, after the same in-portal, in-tenant check; the voice learns it silently.
   */
  choose(index: number): void {
    const c = this.choice;
    const picked = c?.candidates[index];
    this.clearChoice();
    if (!c || !picked?.href) return;
    const ctx = this.opts.toolContext();
    if (!openableHref(picked.href, ctx)) return;
    ctx.navigate(picked.href);
    this.addLine('assistant', `Opened ${picked.title}`);
    this.noteContext(`The user chose "${picked.title}" from the numbered choice; it is now open. Do not open it again.`);
  }

  cancelChoice(): void {
    this.clearChoice();
  }

  /** The choice card opens on `pendingChoice` alone (ui-components 2.510.5), so it never touches the phase. */
  private clearChoice(): void {
    if (!this.choice) return;
    this.choice = null;
    this.publish();
  }

  /** Silent page context for the voice (§1: session.thinking.append, delegation_id null). */
  noteContext(text: string): void {
    if (this.machine.base === 'live') this.client?.appendThinking(text);
  }

  clearTurns(): void {
    this.turns = [];
    this.publish();
  }

  dispose(): void {
    this.stopTicker();
    void this.stop('dropped');
    this.listeners.clear();
  }

  // ── client events ────────────────────────────────────────────────────────

  private onClientEvent(client: VoiceClient, e: ClientEvent): void {
    if (client !== this.client) return;
    switch (e.type) {
      case 'minted':
        this.mint = e.mint;
        if (typeof e.mint.toastSeconds === 'number' && e.mint.toastSeconds > 0) this.lastToastSeconds = e.mint.toastSeconds;
        if (e.mint.dailyMinutesLeft != null) {
          const m = Math.max(1, e.mint.dailyMinutesLeft);
          this.addLine('assistant', `About ${m} minute${m === 1 ? '' : 's'} of voice left today.`);
        }
        this.publish();
        return;
      case 'unavailable':
        this.stopTicker();
        this.dispatch({ type: 'unavailable', reason: e.reason });
        return;
      case 'budget-confirm':
        this.stopTicker();
        this.budgetCard = { callId: BUDGET_CARD, requestId: ++this.requestSeq, tool: 'voice_session', ...budgetConfirmText(e) };
        this.dispatch({ type: 'budget-confirm' });
        return;
      case 'failed':
        this.stopTicker();
        this.dispatch({ type: 'failed', reason: e.reason });
        return;
      case 'dropped':
        this.addLine('assistant', 'The voice connection dropped.');
        return;
      case 'ended':
        this.elapsedFrozen = client.elapsedSeconds();
        this.closedSeconds = e.seconds;
        if (client.mint && e.seconds != null) {
          this.ownSessions.set(client.mint.sessionId, e.seconds);
          if (this.ownSessions.size > 10) this.ownSessions.delete(this.ownSessions.keys().next().value!);
        }
        this.clearDelegations();
        this.stopTicker();
        this.dispatch({ type: 'closed', reason: e.reason === 'cutoff' ? 'The session reached its budget and was ended.' : e.reason === 'dropped' ? 'The connection dropped.' : null });
        return;
      case 'frame':
        this.onFrame(client, e.frame);
    }
  }

  private onFrame(client: VoiceClient, f: VoiceFrame): void {
    const at = this.now();
    switch (f.kind) {
      case 'started':
        this.dispatch({ type: 'started' });
        return;
      case 'input':
        this.appendTurn('you', f.text, at);
        this.dispatch({ type: 'input', at });
        if (this.pending) this.hearForPending(f.text, f.startMs, f.endMs);
        else if (this.choice) this.hearForChoice(f.text);
        return;
      case 'output':
        this.appendTurn('assistant', f.text, at);
        this.dispatch({ type: 'output', at });
        return;
      case 'delegation':
        this.delegation(f.delegationId);
        this.dispatch({ type: 'delegation', id: f.delegationId });
        return;
      case 'call':
        void this.onCall(client, f.delegationId ?? `solo_${f.callId}`, f.callId, f.name, f.arguments);
        return;
      case 'response-completed':
        if (f.delegationId) this.onCompleted(client, f.delegationId);
        return;
      case 'response-failed':
        if (f.delegationId) this.closeDelegation(f.delegationId);
        return;
      case 'muted':
        this.muted = f.muted;
        this.publish();
        return;
      case 'error':
        // An error for one of our own events (a tool result, a context append) does not end the session.
        this.addLine('assistant', `Voice error: ${f.message}`);
        return;
      case 'closed':
      case 'usage':
      case 'audio':
      case 'ack':
      case 'response-progress':
      case 'other':
        this.publish();
    }
  }

  // ── the tool loop ────────────────────────────────────────────────────────

  private delegation(id: string): DelegationRecord {
    let rec = this.delegations.get(id);
    if (!rec) {
      rec = { calls: new Map(), completed: false, unanswered: 0, grace: null };
      this.delegations.set(id, rec);
    }
    return rec;
  }

  private async onCall(client: VoiceClient, delegationId: string, callId: string, name: string, rawArgs: string): Promise<void> {
    const rec = this.delegation(delegationId);
    if (rec.calls.has(callId)) return;
    if (!this.machine.openDelegations.includes(delegationId)) this.dispatch({ type: 'delegation', id: delegationId });
    rec.calls.set(callId, { name, status: 'running' });
    const startedAt = this.now();
    const ctx = this.opts.toolContext();
    const prepared = prepareToolCall(name, rawArgs, ctx);
    if (!prepared.ok) {
      await this.answer(client, delegationId, callId, name, prepared.result, startedAt, rawArgs);
      return;
    }
    const call = prepared.call;
    // A dropped `command` (§6) is its own refused row: the attempt is on record, its text is not (§9).
    if (call.ignored?.length) {
      void hashToolArgs({ ignored: call.ignored }).then((argsSha256) => client.reportToolCall({ tool: name, argsSha256, outcome: 'refused', durationMs: 0 }));
    }
    if (call.spec.confirm && toolAvailable(name, this.runners)) {
      // The delegation asks one call at a time (parallel_tool_calls: false); a second card would hide the first.
      if (this.pending) {
        await this.answer(client, delegationId, callId, name, refused('Another action is waiting for the user to confirm. Ask again after it.'), startedAt, call.args);
        return;
      }
      let plan: ConfirmPlan | null = null;
      if (this.planners[name]) {
        this.attachTool(name, 'running', call.spec.says);
        this.dispatch({ type: 'call-running', callId });
        const planned = await planPreparedCall(call, ctx, this.planners);
        if (client !== this.client || this.machine.base !== 'live') return;
        if (planned && 'result' in planned) {
          await this.answer(client, delegationId, callId, name, planned.result, startedAt, call.args);
          return;
        }
        plan = planned?.plan ?? null;
        if (this.pending) {
          await this.answer(client, delegationId, callId, name, refused('Another action is waiting for the user to confirm. Ask again after it.'), startedAt, call.args);
          return;
        }
      }
      rec.calls.set(callId, { name, status: 'confirming' });
      const text = this.opts.describeConfirm?.(call, plan) ?? (plan ? { title: plan.title, ...(plan.detail ? { detail: plan.detail } : {}) } : defaultConfirmText(call));
      this.pending = { callId, delegationId, call, plan, startedAt, heard: { text: '', lastEndMs: null, quiet: null, done: false }, view: { callId, requestId: ++this.requestSeq, tool: name, ...text } };
      this.attachTool(name, 'running', text.title);
      this.dispatch({ type: 'confirm-shown', callId });
      return;
    }
    await this.execute(client, delegationId, callId, call, startedAt, ctx);
  }

  private async execute(client: VoiceClient, delegationId: string, callId: string, call: PreparedCall, startedAt: number, ctx: ToolContext, confirmedBy?: 'voice' | 'click', plan?: ConfirmPlan | null): Promise<void> {
    this.attachTool(call.spec.name, 'running', call.spec.says);
    this.dispatch({ type: 'call-running', callId });
    let res = await runPreparedCall(call, ctx, this.runners, plan?.data);
    if (confirmedBy) res = { ...res, output: { ...res.output, confirmed: true, by: confirmedBy } };
    await this.answer(client, delegationId, callId, call.spec.name, res, startedAt, call.args, confirmedBy);
  }

  private async answer(client: VoiceClient, delegationId: string, callId: string, name: string, res: ToolResult, startedAt: number, args: unknown, confirmedBy?: 'voice' | 'click'): Promise<void> {
    if (client !== this.client || this.machine.base !== 'live') return;
    client.sendToolOutput(callId, JSON.stringify(res.output));
    this.noteChoice(res);
    const rec = this.delegation(delegationId);
    rec.calls.set(callId, { name, status: 'answered' });
    rec.unanswered += 1;
    this.attachTool(name, res.outcome === 'done' ? 'done' : res.outcome === 'failed' ? 'failed' : 'refused', res.summary);
    this.dispatch({ type: 'call-done', callId });
    // The row keeps a hash of the arguments, never the arguments (§9).
    void hashToolArgs(args).then((argsSha256) => client.reportToolCall({
      tool: name, argsSha256, outcome: res.outcome, durationMs: Math.max(0, Math.round(this.now() - startedAt)),
      ...(confirmedBy ? { confirmedBy } : {}),
    }));
    this.maybeContinue(client, delegationId);
  }

  /** An ambiguous result whose candidates each open on a page becomes the choice card; any other answered call clears it. */
  private noteChoice(res: ToolResult): void {
    const cands = res.output['kind'] === 'ambiguous' && Array.isArray(res.output['candidates']) ? res.output['candidates'] as Array<Record<string, unknown>> : null;
    const rows = cands?.filter((c) => typeof c['title'] === 'string' && typeof c['href'] === 'string' && localHref(c['href'] as string)) ?? [];
    if (cands && rows.length && rows.length === cands.length) {
      this.clearChoice();
      this.choice = {
        id: `choice-${++this.choiceSeq}`, requestId: ++this.requestSeq, heard: '',
        title: 'Which one?',
        candidates: rows.map((c) => ({
          title: c['title'] as string, href: c['href'] as string,
          ...(typeof c['subtitle'] === 'string' ? { subtitle: c['subtitle'] } : {}), ...(typeof c['kind'] === 'string' ? { kind: c['kind'] } : {}),
        })),
      };
    } else this.clearChoice();
    this.publish();
  }

  private onCompleted(client: VoiceClient, delegationId: string): void {
    const rec = this.delegations.get(delegationId);
    if (!rec) return;
    rec.completed = true;
    this.maybeContinue(client, delegationId);
  }

  private maybeContinue(client: VoiceClient, delegationId: string): void {
    const rec = this.delegations.get(delegationId);
    if (!rec) return;
    const open = [...rec.calls.values()].some((c) => c.status !== 'answered');
    if (open) return;
    if (rec.unanswered > 0) {
      if (!rec.completed) {
        // The result settled before the response that asked for it completed: wait for it, bounded.
        if (rec.grace == null) {
          rec.grace = this.setTimer(() => { rec.grace = null; rec.completed = true; this.maybeContinue(client, delegationId); }, COMPLETION_GRACE_MS);
        }
        return;
      }
      if (rec.grace != null) { this.clearTimer(rec.grace); rec.grace = null; }
      // One response.create for every output of this round (§1).
      rec.unanswered = 0;
      rec.completed = false;
      rec.calls.clear();
      client.requestResponse();
      return;
    }
    // The continuation (or a delegation that called nothing) completed: it is done.
    if (rec.completed) this.closeDelegation(delegationId);
  }

  private closeDelegation(id: string): void {
    const rec = this.delegations.get(id);
    if (rec?.grace != null) this.clearTimer(rec.grace);
    this.delegations.delete(id);
    this.dispatch({ type: 'delegation-done', id });
  }

  private clearDelegations(): void {
    for (const rec of this.delegations.values()) if (rec.grace != null) this.clearTimer(rec.grace);
    this.delegations.clear();
  }

  /** "The second one": the card is told the ordinal and chooses it (once per value); a number past the rows is ignored. */
  private hearForChoice(text: string): void {
    const c = this.choice;
    if (!c) return;
    c.heard += text;
    const n = spokenOrdinal(c.heard);
    if (n == null || n > c.candidates.length || c.ordinal === n) return;
    this.choice = { ...c, ordinal: n };
    this.publish();
  }

  /** The first utterance after the card decides it (confirmDecision); a later one is the voice's, not the card's. */
  private hearForPending(text: string, startMs: number | null, endMs: number | null): void {
    const p = this.pending;
    if (!p || p.heard.done) return;
    const h = p.heard;
    // The next word starts well after the last one ended: the first utterance is over, and this word is not part of it.
    if (h.text.trim() && startMs != null && h.lastEndMs != null && startMs - h.lastEndMs >= UTTERANCE_SPLIT_MS) {
      this.endUtterance(p);
      return;
    }
    h.text += text;
    if (endMs != null) h.lastEndMs = endMs;
    if (confirmDecision(h.text, false) === 'cancel') { this.resolvePending(false, 'voice'); return; }
    if (h.quiet != null) this.clearTimer(h.quiet);
    h.quiet = this.setTimer(() => { h.quiet = null; if (this.pending === p) this.endUtterance(p); }, UTTERANCE_GAP_MS);
  }

  private endUtterance(p: Pending): void {
    const h = p.heard;
    if (h.done) return;
    h.done = true;
    if (h.quiet != null) { this.clearTimer(h.quiet); h.quiet = null; }
    const decision = confirmDecision(h.text, true);
    if (decision) this.resolvePending(decision === 'confirm', 'voice');
  }

  private resolvePending(confirmed: boolean, by: 'voice' | 'click'): void {
    const p = this.pending;
    const client = this.client;
    if (!p || !client) return;
    if (p.heard.quiet != null) { this.clearTimer(p.heard.quiet); p.heard.quiet = null; }
    this.pending = null;
    this.dispatch({ type: 'confirm-resolved', callId: p.callId });
    if (confirmed) {
      void this.execute(client, p.delegationId, p.callId, p.call, p.startedAt, this.opts.toolContext(), by, p.plan);
    } else {
      void this.answer(client, p.delegationId, p.callId, p.call.spec.name, cancelledResult(by), p.startedAt, p.call.args, by);
    }
  }

  // ── money (§7) ───────────────────────────────────────────────────────────

  private budget(): { usedUsd: number; holdUsd: number } | null {
    if (!this.mint) return null;
    const used = Math.round((this.elapsed() / 60) * this.mint.budget.usdPerMinute * 10_000) / 10_000;
    return { usedUsd: used, holdUsd: this.mint.budget.holdUsd };
  }

  private checkBudget(): void {
    const b = this.budget();
    const mint = this.mint;
    if (!b || !mint || !this.client) return;
    // The ratio from the unrounded spend: the meter's 4-place figure can sit just under 90% for a whole tick.
    const ratio = b.holdUsd > 0 ? ((this.elapsed() / 60) * mint.budget.usdPerMinute) / b.holdUsd : 0;
    const timeRatio = mint.maxSeconds > 0 ? this.elapsed() / mint.maxSeconds : 0;
    if (ratio >= 1 || timeRatio >= 1) { void this.stop('cutoff'); return; }
    if (!this.warned && (ratio >= BUDGET_WARN_RATIO || timeRatio >= BUDGET_WARN_RATIO)) {
      this.warned = true;
      const leftSec = Math.min(
        mint.budget.usdPerMinute > 0 ? ((b.holdUsd - b.usedUsd) / mint.budget.usdPerMinute) * 60 : Infinity,
        mint.maxSeconds - this.elapsed(),
      );
      const minutes = Math.max(1, Math.round(leftSec / 60));
      const line = `About ${minutes} minute${minutes === 1 ? '' : 's'} left on this voice session.`;
      this.client.appendCommentary(`Tell the user: ${line}`);
      this.addLine('assistant', line);
    }
  }

  private elapsed(): number {
    return this.elapsedFrozen ?? this.client?.elapsedSeconds() ?? 0;
  }

  // ── transcript ───────────────────────────────────────────────────────────

  private appendTurn(role: 'you' | 'assistant', text: string, at: number): void {
    if (!text) return;
    const last = this.turns[this.turns.length - 1];
    if (last && last.role === role && !last.toolCalls?.length) {
      this.turns = [...this.turns.slice(0, -1), { ...last, text: last.text + text }];
    } else {
      this.pushTurn({ id: `t${++this.turnSeq}`, role, text: text.trimStart(), at });
    }
  }

  private pushTurn(turn: VoiceTurnView): void {
    this.turns = [...this.turns, turn].slice(-MAX_TURNS);
  }

  private addLine(role: 'you' | 'assistant', text: string): void {
    this.pushTurn({ id: `t${++this.turnSeq}`, role, text, at: this.now() });
    this.publish();
  }

  /** A tool call in the transcript: replaces the newest running entry of the same tool, else joins the latest turn. */
  private attachTool(name: string, status: ToolStatus, summary: string): void {
    const entry = { name, status, summary };
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const calls = this.turns[i]!.toolCalls ?? [];
      const j = calls.map((c) => (c.name === name && c.status === 'running')).lastIndexOf(true);
      if (j >= 0) {
        const next = [...this.turns];
        next[i] = { ...this.turns[i]!, toolCalls: calls.map((c, k) => (k === j ? entry : c)) };
        this.turns = next;
        return;
      }
    }
    const last = this.turns[this.turns.length - 1];
    if (!last) { this.pushTurn({ id: `t${++this.turnSeq}`, role: 'assistant', text: '', at: this.now(), toolCalls: [entry] }); return; }
    this.turns = [...this.turns.slice(0, -1), { ...last, toolCalls: [...(last.toolCalls ?? []), entry] }];
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private reset(): void {
    this.clearDelegations();
    this.pending = null;
    this.choice = null;
    this.budgetCard = null;
    this.mint = null;
    this.warned = false;
    this.muted = false;
    this.elapsedFrozen = null;
    this.closedSeconds = null;
    this.levels = { input: 0, output: 0 };
  }

  private dispatch(e: MachineEvent, publish = true): void {
    this.machine = reduce(this.machine, e);
    if (publish) this.publish();
  }

  private startTicker(): void {
    this.stopTicker();
    const loop = () => { this.ticker = this.setTimer(loop, TICK_MS); this.tick(); };
    this.ticker = this.setTimer(loop, TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker != null) this.clearTimer(this.ticker);
    this.ticker = null;
  }

  private build(): VoiceSnapshot {
    const phase = phaseAt(this.machine, this.now());
    const live = this.machine.base === 'live';
    const last = [...this.turns].reverse().find((t) => t.text.trim());
    return {
      phase,
      level: live ? round(this.levels.input) : 0,
      outputLevel: live ? round(this.levels.output) : 0,
      elapsedSeconds: Math.floor(this.elapsed()),
      pending: this.pending?.view ?? this.budgetCard ?? null,
      choice: this.choice ? { id: this.choice.id, requestId: this.choice.requestId, title: this.choice.title, candidates: this.choice.candidates, ...(this.choice.ordinal ? { ordinal: this.choice.ordinal } : {}) } : null,
      lastLine: last ? { role: last.role, text: last.text.trim() } : null,
      turns: this.turns,
      muted: this.muted,
      reason: this.machine.reason,
      closedSeconds: this.closedSeconds,
    };
  }

  private publish(): void {
    const next = this.build();
    const prev = this.snapshot;
    if (prev.phase === next.phase && prev.level === next.level && prev.outputLevel === next.outputLevel
      && prev.elapsedSeconds === next.elapsedSeconds && prev.pending === next.pending && prev.turns === next.turns
      && prev.choice?.id === next.choice?.id && prev.choice?.ordinal === next.choice?.ordinal
      && prev.lastLine?.text === next.lastLine?.text && prev.muted === next.muted && prev.reason === next.reason
      && prev.closedSeconds === next.closedSeconds) return;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 20) / 20;

