// The owner's real voice sessions, replayed through today's controller
// (docs/voice/replay.md). fixtures/real-sessions.json is written by
// scripts/voice/sessions-to-replay.mjs from middleware/.voice-log: per session
// the ordered delegations, each call's tool and argument shape (never words),
// how it ended, and its card. Here every session is played again on the fake
// clock with the scripted mint: the "model" makes the same calls in the same
// order (a continuation plays the delegation's next logged call), the runners
// and planners answer each call the way the log says it ended (done, refused
// with that reason, failed with that code; the cards are answered as the user
// answered them), and the controller in between is today's. A session recorded
// before a gap was fixed may break an invariant in its log; the replay must not.
//
// Arguments are rebuilt from the shape: the enum values as logged, a ref as
// `<kind>:<hash prefix>`, free text as "Replay words <hash prefix>" (so equal
// logged arguments stay equal and nothing else does, and any word reaching the
// event log is caught by invariant g). A refusal the log gives no reason for
// (or `other`) is answered by the real runner on those arguments, so (e) asks
// what today's runner says.
//
// Invariants (the gaps doc's, per session):
//   a  every delegation ends: a response.create after every tool output, stopped rounds included (G59)
//   b  the session is never deaf: every logged delegation is played, and one more request after the last is answered
//   c  at most four calls run per user turn (G43); a navigation ends the turn but for a read of that page (G51)
//   d  every action call that ran shows exactly one card or rides a G41 cover; a failed post never reuses the cover
//   e  a refusal carries a reason other than `other`; a failure carries a code (G47)
//   f  an identical refused call is terminal the second time in a turn and never runs a third (G29)
//   g  the event log the replay posts holds closed-vocabulary tokens only, never the words

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUDGET_CARD, STALLED_CARD, VoiceController } from '../controller.ts';
import { VoiceClient, type MockFrame } from '../client.ts';
import { VOICE_PLANNERS, VOICE_RUNNERS } from '../actions.ts';
import { NAVIGATED_STOP, ResultMemory, ambiguous, done, failed, needsConfirm, planPreparedCall, prepareToolCall, refused, runVoiceTool, type ToolContext, type ToolResult, type VoiceToolPlanner, type VoiceToolRunner } from '../tools.ts';
import { activityScopes, budgetScopes, createKinds, listKinds, queueWorkKinds, summaryKinds, voiceToolSpec } from '../catalogue.ts';
import { FAILURE_CODES, REFUSAL_CODES, refusalCode } from '../sessionEvents.ts';
import { callKey } from '../refusals.ts';
import { FakeClock, fakeFetch, isToolRow, loggedEvents, route, toolContext, type LoggedRequest } from './voiceHarness.ts';

// ── the fixture ───────────────────────────────────────────────────────────

interface Card { shownMs: number; mode: string | null; decision: 'confirmed' | 'cancelled' | 'unanswered'; by?: string; afterMs?: number; phrase?: string; clickRequired?: number; inferred?: boolean }
interface LoggedCall {
  seq: number; atMs: number; durationMs?: number; resultSeq?: number; tool: string; shape: Record<string, string | number | boolean>; argsKey: string | null;
  outcome: 'done' | 'refused' | 'failed' | 'cancelled' | 'unfinished'; reason?: string; code?: string; result?: string; candidates?: number; rows?: number; count?: number; card?: Card;
}
interface Delegation { atMs: number; seq: number; heardBefore: boolean; inferred?: boolean; calls: LoggedCall[] }
interface Session { id: string; tenant: string; tools: string[]; format: string; delegations: Delegation[]; counts: Record<string, number> }

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/real-sessions.json', import.meta.url), 'utf8')) as { sessions: Session[] };
const SESSIONS = FIXTURE.sessions;
const short = (id: string) => id;
const sessionNamed = (prefix: string): Session => {
  const s = SESSIONS.find((x) => short(x.id) === prefix);
  assert.ok(s, `the fixture holds ${prefix}`);
  return s;
};

// ── arguments from a shape ────────────────────────────────────────────────

const CANARY = 'Replay words';
/** The refusals today's controller gives before a call runs: a replay may let such a logged call through (it then runs). */
const GATES = new Set(['navigated', 'too-many-calls', 'repeat-failed', 'card-open']);
const BOOLEAN_FIELDS = new Set(['paused', 'requeued', 'member', 'read', 'publish']);
const ENUM_FIELDS: Record<string, string> = { status: 'done', reviewed: 'accept', type: 'story', privacy: 'public', duration: '7d', window: '7d', startsOn: '2026-11-10', endsOn: '2026-11-20' };

type Args = Record<string, unknown>;
interface Opened { kind: string; ref: string }

function fieldsOf(list: unknown, key: string): Args {
  const out: Args = {};
  for (const f of String(list ?? '').split(',').filter(Boolean)) {
    out[f] = BOOLEAN_FIELDS.has(f) ? true : ENUM_FIELDS[f] ?? (f === 'thread' ? `message:${key}` : `${CANARY} ${key}`);
  }
  return out;
}

/**
 * The call's arguments, rebuilt from its logged shape. `opened` is the record a done open of this delegation opened;
 * `conversation` counts the conversations opened so far, so a message after another open goes to another channel.
 */
export function synthArgs(tenant: string, call: LoggedCall, opened: Opened | null, conversation = 0): Args {
  const s = call.shape;
  const key = call.argsKey ?? `s${call.seq}`;
  const known = Object.keys(s).length > 0;
  const words = `${CANARY} ${key}`;
  // A ref of the kind just opened is that record (s17: "open Alpha, what are its decisions").
  const refOf = (k: unknown): string => (k === 'position' ? '1' : k === 'other' || typeof k !== 'string' ? words : opened?.kind === k ? opened.ref : `${k}:${key}`);
  const a: Args = {};
  const copy = (...keys: string[]) => { for (const k of keys) if (s[k] !== undefined) a[k] = s[k]; };
  const target = () => ({ kind: typeof s['targetKind'] === 'string' ? s['targetKind'] : 'channel', name: `Replay ${typeof s['targetKind'] === 'string' ? s['targetKind'] : 'channel'} ${conversation}` });
  switch (call.tool) {
    case 'open':
      copy('page', 'tab', 'scope', 'kind');
      if (s['byName']) a['name'] = words;
      if (s['refKind'] !== undefined) a['ref'] = s['refKind'] === 'position' ? '1' : s['refKind'] === 'other' ? words : `${String(s['refKind'])}:${key}`;
      if (!known) a['ref'] = '1';
      break;
    case 'search':
      a['query'] = words;
      copy('type', 'sort', 'answer', 'detail');
      if (s['scope'] !== undefined) a['scope'] = s['scope'] === 'workspace' ? 'workspace' : `p-${key}`;
      break;
    case 'list': {
      a['kind'] = s['kind'] ?? listKinds(tenant)[0];
      copy('scope', 'detail');
      const filter: Args = {};
      if (s['filterScope'] !== undefined) filter['scope'] = s['filterScope'];
      for (const f of String(s['filteredBy'] ?? (known ? '' : 'q')).split(',').filter(Boolean)) filter[f] = f === 'status' ? 'open' : f === 'since' ? 'yesterday' : words;
      if (Object.keys(filter).length) a['filter'] = filter;
      break;
    }
    case 'get':
      a['ref'] = s['refKind'] !== undefined ? refOf(s['refKind']) : `initiative:${key}`;
      copy('part', 'detail');
      break;
    case 'summary': a['kind'] = s['kind'] ?? summaryKinds(tenant)[0]; break;
    case 'budget': a['scope'] = s['scope'] ?? budgetScopes(tenant)[0]; copy('groupBy'); break;
    case 'activity': a['scope'] = s['scope'] ?? activityScopes(tenant)[0]; break;
    case 'access_request_status': copy('scope'); break;
    case 'set_status': a['status'] = s['status'] ?? 'away'; break;
    case 'message':
      a['target'] = target();
      a['text'] = words;
      if (s['thread']) a['thread'] = `message:${key}`;
      if (s['attachKind'] !== undefined) a['attach'] = refOf(s['attachKind']);
      break;
    case 'call': a['action'] = s['action'] ?? 'start'; a['target'] = target(); break;
    case 'queue_work':
      a['kind'] = s['kind'] ?? queueWorkKinds(tenant)[0];
      a['target'] = s['targetKind'] !== undefined ? refOf(s['targetKind']) : words;
      copy('scope');
      if (typeof s['rowCount'] === 'number') a['rows'] = Array.from({ length: s['rowCount'] }, (_, i) => i + 1);
      break;
    case 'decide': a['ref'] = s['refKind'] !== undefined ? refOf(s['refKind']) : '1'; a['decision'] = s['decision'] ?? 'approve'; copy('scope'); break;
    case 'create': a['kind'] = s['kind'] ?? createKinds(tenant)[0]; a['fields'] = s['fields'] !== undefined ? fieldsOf(s['fields'], key) : { title: words }; break;
    case 'update': a['ref'] = s['refKind'] !== undefined ? refOf(s['refKind']) : '1'; a['fields'] = s['fields'] !== undefined ? fieldsOf(s['fields'], key) : { status: 'done' }; break;
    case 'computer': {
      // A rows-only session logged no action: a card means start, no card the no-card open-shell (G30's four in five seconds).
      const action = typeof s['action'] === 'string' ? s['action'] : call.card ? 'start' : 'open-shell';
      a['action'] = action;
      if (action === 'start') a['initiatives'] = Array.from({ length: typeof s['targets'] === 'number' ? s['targets'] : 1 }, (_, i) => `p-${key}-${i}`);
      else if (action === 'hand-work') { a['machine'] = `m-${key}`; a['job'] = `work-item:${key}`; } else a['computer'] = `c-${key}`;
      if (action === 'run') a['phrase'] = s['phrase'];
      break;
    }
    default: break;
  }
  return a;
}

/** What a done open leaves the turn: a ref for a record (by ref or by name), none for a page or a row of the page in view. */
function openedBy(args: Args): Opened | null {
  if (args['page'] || args['scope'] === 'this-page') return null;
  if (typeof args['ref'] === 'string' && /^[a-z][a-z-]*:/.test(args['ref'])) return { kind: args['ref'].split(':')[0]!, ref: args['ref'] };
  if (typeof args['kind'] === 'string' && typeof args['name'] === 'string') return { kind: args['kind'], ref: `${args['kind']}:${String(args['name']).split(' ').at(-1)}` };
  return null;
}

// ── the answers the log gives ─────────────────────────────────────────────

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: `row:${i + 1}`, title: `Replay row ${i + 1}` }));
const candidatesOf = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: `initiative:c${i + 1}`, title: `Replay candidate ${i + 1}`, kind: 'initiative', href: `/iq/projects/c${i + 1}` }));

/** The result today's runner contract gives for a call the log says landed (open's G51 stop as tools.ts writes it). */
function landed(tool: string, args: Args, logged: LoggedCall | null): ToolResult {
  if (tool === 'open') {
    if (args['page']) return done('navigated', { page: args['page'], label: 'Replay page', path: '/iq/replay', say: 'Opened Replay page.', ...NAVIGATED_STOP }, 'Opened Replay page');
    if (args['tab'] && args['scope'] === 'this-page' && !args['ref'] && !args['name']) return done('navigated', { tab: args['tab'], path: `/iq/replay?tab=${String(args['tab'])}` }, `Showing ${String(args['tab'])}`);
    const ref = openedBy(args)?.ref ?? 'row:1';
    if (args['scope'] === 'this-page') return done('navigated', { ref, title: 'Replay row', path: '/iq/replay/row', say: 'Opened Replay row.' }, 'Opened Replay row');
    return done('navigated', { ref, title: 'Replay record', path: '/iq/replay/record', say: 'Opened Replay record.', ...NAVIGATED_STOP }, 'Opened Replay record');
  }
  // A call the log shows refused by the dock's own gate ran today: it lands, under its tool's own result kind.
  const kind = logged?.result && !/^(refused|ambiguous|failed|cancelled)$/.test(logged.result) ? logged.result : tool;
  if (tool === 'list' || tool === 'search' || tool === 'get' || tool === 'activity') {
    const rows = logged?.rows ?? 0;
    return done(kind, { count: logged?.count ?? rows, rows: rowsOf(rows) }, `${rows} rows`);
  }
  return done(kind, {}, 'Done');
}

/** The answer the log gives for this call, or null when the real runner should answer (no reason, or `other`). */
function asLogged(tool: string, args: Args, logged: LoggedCall | null): ToolResult | null {
  if (!logged) return landed(tool, args, null);
  if (logged.outcome === 'failed') return failed('It did not go through.', logged.code ? { code: logged.code } : {});
  if (logged.outcome === 'refused') {
    if (!logged.reason || logged.reason === 'other') return null;
    if (GATES.has(logged.reason)) return landed(tool, args, logged);
    if (logged.reason === 'ambiguous') return ambiguous('Several match; read them out and ask which.', candidatesOf(logged.candidates ?? 2));
    return refused('Refused, as the session log says.', { code: logged.reason });
  }
  return landed(tool, args, logged);
}

// ── one replay ────────────────────────────────────────────────────────────

interface Meta { callId: string; logged: LoggedCall | null; args: Args; turn: number; delegation: number }
interface Replay {
  session: Session;
  metas: Map<string, Meta>;
  /** The wire output each call got (the model's form), and what the replay's runner returned in full. */
  outputs: Map<string, Record<string, unknown>>;
  results: Map<string, ToolResult>;
  /** What the dock sent, in order: a tool output (by call) or a response.create. */
  sent: Array<{ type: 'output'; callId: string } | { type: 'create' }>;
  ran: Set<string>;
  realRunner: Set<string>;
  events: Array<Record<string, unknown>>;
  rows: Array<Record<string, unknown>>;
  closeBodies: unknown[];
  delegationsPlayed: number;
  probeAnswered: boolean;
  virtualMs: number;
}

interface Live {
  client: VoiceClient | null;
  onInput: () => void;
  onCall: (callId: string) => void;
  onOutput: (callId: string, output: string) => void;
  onCreate: () => void;
}
let live: Live | null = null;

type ClientInternals = { deliver(data: string): void; play(frames: MockFrame[]): void; sendToolOutput(callId: string, output: string): string | null; requestResponse(): string | null };
const proto = VoiceClient.prototype as unknown as ClientInternals;
const original = { deliver: proto.deliver, sendToolOutput: proto.sendToolOutput, requestResponse: proto.requestResponse };
proto.deliver = function (this: VoiceClient, data: string) {
  if (live) {
    live.client = this;
    try {
      const ev = JSON.parse(data) as { type?: string; event?: { type?: string; item?: { type?: string; call_id?: string } } };
      if (ev.type === 'session.input_transcript.delta') live.onInput();
      if (ev.type === 'response.event' && ev.event?.type === 'response.output_item.done' && ev.event.item?.type === 'function_call' && ev.event.item.call_id) live.onCall(ev.event.item.call_id);
    } catch { /* not ours */ }
  }
  original.deliver.call(this, data);
};
proto.sendToolOutput = function (this: VoiceClient, callId: string, output: string) {
  live?.onOutput(callId, output);
  return original.sendToolOutput.call(this, callId, output);
};
proto.requestResponse = function (this: VoiceClient) {
  const id = original.requestResponse.call(this);
  live?.onCreate();
  return id;
};

const env = (d: string, event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
/** The conversation a replayed message goes to (the planner's plan.data.channel, which G41's cover keys on). */
const channelOf = (args: Args) => {
  const t = (args['target'] ?? {}) as Record<string, unknown>;
  return `social:ch:${String(t['kind'] ?? 'channel')}-${String(t['name'] ?? '').split(' ').at(-1)}`;
};
const clampGap = (ms: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(ms) ? ms : lo));

/** A done open of a conversation (a channel, team, DM or room): later messages go there, not to the one before. */
const CONVERSATIONS = new Set(['channel', 'team', 'dm', 'room']);
const opensConversation = (call: LoggedCall) => call.tool === 'open' && call.outcome === 'done'
  && (CONVERSATIONS.has(String(call.shape['kind'])) || CONVERSATIONS.has(String(call.shape['refKind'])));

async function replay(session: Session): Promise<Replay> {
  const SESSION = session.id;
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 7200, expiresAt: '2026-11-09T23:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: session.tools, budget: { holdUsd: 500, usdPerMinute: 0.05 },
      mockScript: { onStart: [{ atMs: 0, event: { type: 'session.started', session: { id: `live_${short(SESSION)}` } } }], onResponseCreate: [], onClose: [{ atMs: 50, event: { type: 'session.closed', reason: 'close_requested' } }] },
    }),
  ]);
  // The dock's own context as the pane gives it (a job tracker included), for the real runners a reasonless refusal reaches.
  const ctx: ToolContext = toolContext({ fetch, tenant: session.tenant, role: 'admin', results: new ResultMemory(), jobs: { track: () => {} } });

  const r: Replay = {
    session, metas: new Map(), outputs: new Map(), results: new Map(), sent: [], ran: new Set(), realRunner: new Set(),
    events: [], rows: [], closeBodies: [], delegationsPlayed: 0, probeAnswered: false, virtualMs: 0,
  };
  // The arguments of every logged call, rebuilt up front (an open's record carries to the delegation's later reads).
  let conversation = 0;
  const planned = session.delegations.map((d) => {
    let opened: Opened | null = null;
    return d.calls.map((call) => {
      const args = synthArgs(session.tenant, call, opened, conversation);
      if (call.tool === 'open' && call.outcome === 'done') opened = openedBy(args) ?? opened;
      if (opensConversation(call)) conversation += 1;
      return { call, args };
    });
  });
  const probeArgs: Args = { kind: listKinds(session.tenant)[0] };

  let turn = 0;
  let current: Meta | null = null;
  let lastProgress = 0;
  let active: { index: number; id: string; next: number; calls: Array<{ call: LoggedCall | null; args: Args }> } | null = null;
  const callIdOf = (index: number, i: number) => `call_${index}_${i}`;

  const play = (frames: MockFrame[]) => (live!.client as unknown as ClientInternals).play(frames);
  const callFrame = (d: string, index: number, i: number, args: Args, tool: string, at: number): MockFrame => ({
    atMs: at, event: env(d, { type: 'response.output_item.done', item: { id: `fc_${index}_${i}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(args), call_id: callIdOf(index, i), name: tool } }),
  });
  const completed = (d: string, n: string, at: number): MockFrame => ({ atMs: at, event: env(d, { type: 'response.completed', response: { id: `r_${d}_${n}`, status: 'completed', output: [] } }) });
  const said = (at: number, text: string): MockFrame => ({ atMs: at, event: { type: 'session.input_transcript.delta', delta: text, start_ms: clock.t + at, end_ms: clock.t + at + 400 } });
  const voice = (at: number): MockFrame => ({ atMs: at, event: { type: 'session.output_transcript.delta', delta: 'Done.' } });

  /** Delegation `index` (the probe after the last), `delay` ms from now; a delegation with no call chains the next. */
  const startDelegation = (index: number, delay: number, frames: MockFrame[] = []): void => {
    const probe = index >= session.delegations.length;
    const d = probe ? null : session.delegations[index]!;
    const id = probe ? 'deleg_probe' : `deleg_${index}`;
    const calls = probe ? [{ call: null, args: probeArgs }] : planned[index]!;
    let t = delay;
    if (!d || d.heardBefore) { frames.push(said(t, 'Next request.')); t += 800; }
    frames.push({ atMs: t, event: { type: 'session.delegation.created', delegation: { id, type: 'delegation', response_id: `r_${id}_0`, target: 'responses' } } });
    frames.push({ atMs: t + 10, event: env(id, { type: 'response.created', response: { id: `r_${id}_0`, status: 'in_progress', output: [] } }) });
    active = { index, id, next: 0, calls };
    if (calls.length) {
      frames.push(callFrame(id, index, 0, calls[0]!.args, calls[0]!.call?.tool ?? 'list', t + 200), completed(id, '0', t + 250));
      active.next = 1;
      play(frames);
      return;
    }
    // A delegation that called nothing (the confirm word's echo, G34): it completes, the voice speaks, the next one follows.
    frames.push(completed(id, '0', t + 250), voice(t + 600));
    const next = session.delegations[index + 1];
    startDelegation(index + 1, t + 600 + clampGap(next ? next.atMs - d!.atMs : 1000, 800, 3000), frames);
  };

  live = {
    client: null,
    onInput: () => { turn += 1; lastProgress = clock.t; },
    onCall: (callId) => {
      lastProgress = clock.t;
      const m = /^call_(\d+)_(\d+)$/.exec(callId);
      const index = m ? Number(m[1]) : -1;
      const i = m ? Number(m[2]) : -1;
      const step = index >= session.delegations.length ? { call: null, args: probeArgs } : planned[index]?.[i];
      current = { callId, logged: step?.call ?? null, args: step?.args ?? {}, turn, delegation: index };
      r.metas.set(callId, current);
      if (index >= 0 && index < session.delegations.length && i === 0) r.delegationsPlayed += 1;
    },
    onOutput: (callId, output) => {
      lastProgress = clock.t;
      r.sent.push({ type: 'output', callId });
      const out = JSON.parse(output) as Record<string, unknown>;
      r.outputs.set(callId, out);
    },
    onCreate: () => {
      lastProgress = clock.t;
      r.sent.push({ type: 'create' });
      const a = active;
      if (!a) return;
      if (a.next < a.calls.length) {
        // The continuation makes the delegation's next logged call, after the logged pause (bounded).
        const i = a.next++;
        const prev = a.calls[i - 1]!.call, cur = a.calls[i]!.call;
        const gap = clampGap(cur && prev ? cur.atMs - prev.atMs - (prev.durationMs ?? 0) : 500, 300, 2000);
        play([callFrame(a.id, a.index, i, a.calls[i]!.args, cur?.tool ?? 'list', gap), completed(a.id, String(i), gap + 50)]);
        return;
      }
      // The continuation ends the delegation in speech; the next delegation follows after the logged gap (bounded).
      if (a.index >= session.delegations.length) { r.probeAnswered = true; active = null; play([completed(a.id, 'final', 100), voice(300)]); return; }
      const d = session.delegations[a.index]!, next = session.delegations[a.index + 1];
      const end = d.calls.length ? d.calls.at(-1)!.atMs + (d.calls.at(-1)!.durationMs ?? 0) : d.atMs;
      startDelegation(a.index + 1, 400 + clampGap(next ? next.atMs - end : 1000, 800, 3000), [completed(a.id, 'final', 100), voice(300)]);
    },
  };

  const mark = () => { if (current) r.ran.add(current.callId); };
  const real = (tool: string): boolean => {
    const l = current?.logged;
    return !!l && l.outcome === 'refused' && (!l.reason || l.reason === 'other');
  };
  const runner = (tool: string): VoiceToolRunner => async (args, c, plan, answer) => {
    mark();
    const here = current;
    let res: ToolResult | null = null;
    if (real(tool) && VOICE_RUNNERS[tool]) { r.realRunner.add(here!.callId); res = await VOICE_RUNNERS[tool]!(args, c, plan, answer);}
    res ??= asLogged(tool, args, here?.logged ?? null) ?? landed(tool, args, here?.logged ?? null);
    if (here) r.results.set(here.callId, res);
    return res;
  };
  const planner = (tool: string): VoiceToolPlanner => async (args, c) => {
    mark();
    const here = current;
    const l = here?.logged ?? null;
    // Refused before any card, as logged: the planner's refusal (or the real planner's, when the log gave no reason).
    if (l && l.outcome === 'refused' && !l.card) {
      if (real(tool)) {
        r.realRunner.add(here!.callId);
        const out = VOICE_PLANNERS[tool] ? await VOICE_PLANNERS[tool]!(args, c) : null;
        if (out && 'result' in out) r.results.set(here!.callId, out.result);
        return out;
      }
      if (!GATES.has(l.reason ?? '')) {
        const res = asLogged(tool, args, l)!;
        r.results.set(here!.callId, res);
        return { result: res };
      }
    }
    return { plan: { title: `Replay ${tool}`, data: tool === 'message' ? { channel: channelOf(args) } : {} } };
  };
  const tools = Object.keys(VOICE_RUNNERS);
  const runners = Object.fromEntries(tools.map((t) => [t, runner(t)]));
  const planners = Object.fromEntries(Object.keys(VOICE_PLANNERS).map((t) => [t, planner(t)]));

  const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, runners, planners });
  // The cards, answered as the log says the user answered them (bounded waits).
  const answered = new Set<number>();
  c.subscribe(() => {
    const p = c.getSnapshot().pending;
    if (!p || p.callId === STALLED_CARD || p.callId === BUDGET_CARD || answered.has(p.requestId)) return;
    answered.add(p.requestId);
    const card = r.metas.get(p.callId)?.logged?.card;
    clock.setTimer(() => {
      if (c.getSnapshot().pending?.requestId !== p.requestId) return;
      lastProgress = clock.t;
      if (!card || card.decision === 'unanswered') { if (card) c.cancel('click'); else c.confirm('click'); return; }
      if (card.by === 'voice' && p.confirmBy === 'voice') { play([said(0, card.decision === 'cancelled' ? 'Cancel that.' : 'Confirm.')]); return; }
      if (card.decision === 'cancelled') c.cancel('click'); else c.confirm('click');
    }, clampGap(card?.afterMs ?? 800, 300, 1500));
  });

  try {
    await c.start();
    await clock.advance(200);
    assert.ok(live.client, `${short(SESSION)}: the scripted session started`);
    startDelegation(0, 300);
    // Until the probe is answered, or nothing has moved for 30 s of virtual time (a deaf session).
    while (!r.probeAnswered && clock.t - lastProgress < 30_000) await clock.advance(1000, 100);
    await clock.advance(1500, 100);
    r.virtualMs = clock.t;
    const stopping = c.stop();
    await clock.advance(1500, 100);
    await stopping;
    await clock.advance(2000, 100);
  } finally {
    c.dispose();
    live = null;
  }
  r.events = loggedEvents(log);
  r.rows = log.filter((q: LoggedRequest) => isToolRow(q)).map((q) => q.body as Record<string, unknown>);
  r.closeBodies = log.filter((q) => q.url.endsWith('/close')).map((q) => q.body);
  return r;
}

const cache = new Map<string, Promise<Replay>>();
const replayOf = (s: Session) => {
  let p = cache.get(s.id);
  if (!p) { p = replay(s); cache.set(s.id, p); }
  return p;
};

/** The logged calls today's controller refuses before they run, as `seq: code` (navigated, too-many-calls, repeat-failed). */
export function upFront(r: Replay): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of r.metas.values()) {
    const o = r.outputs.get(m.callId);
    if (m.logged && gateRefused(o) && !r.ran.has(m.callId)) out[String(m.logged.seq)] = String(o!['code']);
  }
  return out;
}

/** One line per replayed call: seq, tool, the log's ending, today's (REPLAY_DEBUG=<prefix> prints it). */
export function describe(r: Replay): string[] {
  return [...r.metas.values()].map((m) => {
    const out = r.outputs.get(m.callId);
    const now = !out ? 'no output' : out['kind'] === 'refused' ? `refused ${String(out['code'] ?? '-')}${out['stop'] ? ' stop' : ''}` : `${String(out['kind'])}${out['stop'] ? ' stop' : ''}`;
    const was = m.logged ? `${m.logged.outcome}${m.logged.reason ? ` ${m.logged.reason}` : ''}` : 'probe';
    return `${m.logged?.seq ?? 'probe'}\tt${m.turn}\t${m.logged?.tool ?? 'list'}\tlog: ${was}\treplay: ${now}${r.ran.has(m.callId) ? '' : ' (not run)'}`;
  });
}

// ── the invariants ────────────────────────────────────────────────────────

const seqOf = (r: Replay, callId: string) => { const m = r.metas.get(callId); return m?.logged ? String(m.logged.seq) : callId === 'call_probe' || (m && m.delegation >= r.session.delegations.length) ? 'probe' : callId; };
const codeOf = (o: Record<string, unknown> | undefined) => (o && typeof o['code'] === 'string' ? o['code'] : null);
const gateRefused = (o: Record<string, unknown> | undefined) => !!o && o['kind'] === 'refused' && GATES.has(String(o['code'] ?? ''));
const readsThisPage = (m: Meta, openedRef: string | null) => (m.args['scope'] === 'this-page' && (m.logged?.tool === 'list' || m.logged?.tool === 'get'))
  || (m.logged?.tool === 'get' && openedRef != null && m.args['ref'] === openedRef);
const TOKEN = /^[A-Za-z0-9_.:,-]{0,120}$/;

/** Every invariant break of a replay, as `<invariant>:<logged seq>` keys with a line of evidence. */
export function violations(r: Replay): Map<string, string> {
  const v = new Map<string, string>();
  const add = (key: string, why: string) => { if (!v.has(key)) v.set(key, why); };
  const calls = [...r.metas.values()];

  // (a) every tool output is continued: a response.create follows it before the next output (one call at a time).
  r.sent.forEach((s, i) => {
    if (s.type !== 'output') return;
    const nextOutput = r.sent.findIndex((x, j) => j > i && x.type === 'output');
    const create = r.sent.findIndex((x, j) => j > i && x.type === 'create');
    if (create < 0 || (nextOutput >= 0 && create > nextOutput)) add(`a:${seqOf(r, s.callId)}`, `the output of ${r.metas.get(s.callId)?.logged?.tool ?? 'the call'} was never continued (no response.create)`);
  });
  // G64: past MAX_STOPPED_CONTINUATIONS the dock still continues (delegation-stuck is only logged); a runaway restart is a break.
  for (const e of r.events) if ((e['data'] as Record<string, unknown> | undefined)?.['cause'] === 'runaway') add('a:runaway', 'the dock restarted the session on a runaway delegation');

  // (b) never deaf: every logged delegation with a call was played, and the probe request was answered.
  const withCalls = r.session.delegations.filter((d) => d.calls.length).length;
  if (r.delegationsPlayed < withCalls) {
    const last = calls.filter((m) => m.logged).at(-1);
    add(`b:${last?.logged?.seq ?? 'start'}`, `deaf after seq ${last?.logged?.seq ?? '-'}: ${r.delegationsPlayed} of ${withCalls} delegations reached the dock`);
  }
  if (!r.probeAnswered) add('b:probe', 'one more request after the session was not answered');

  // (c) at most four calls run per turn; a navigation ends the turn but for a read of that page.
  const byTurn = new Map<number, Meta[]>();
  for (const m of calls) byTurn.set(m.turn, [...(byTurn.get(m.turn) ?? []), m]);
  for (const ms of byTurn.values()) {
    const ran = ms.filter((m) => r.ran.has(m.callId));
    if (ran.length > 4) add(`c:${seqOf(r, ran[4]!.callId)}`, `${ran.length} calls ran in one user turn`);
    let opened: string | null | undefined;
    for (const m of ms) {
      if (opened !== undefined && r.ran.has(m.callId) && !readsThisPage(m, opened)) add(`c:${seqOf(r, m.callId)}`, `${m.logged?.tool ?? 'a call'} ran after a navigation in the same turn`);
      const res = r.results.get(m.callId);
      if (res?.outcome === 'done' && res.output['kind'] === 'navigated' && res.output['stop'] === true && opened === undefined) opened = typeof res.output['ref'] === 'string' ? res.output['ref'] : null;
    }
  }

  // (d) one card per action call that ran past its planner, or a G41 cover; never the cover after a failed post.
  const shown = new Map<string, number>(), covered = new Set<string>();
  for (const e of r.events) {
    const d = (e['data'] ?? {}) as Record<string, unknown>;
    if (e['kind'] === 'confirm-shown') shown.set(String(d['callId']), (shown.get(String(d['callId'])) ?? 0) + 1);
    if (e['kind'] === 'confirmed' && d['by'] === 'session') covered.add(String(d['callId']));
  }
  const failedChannels = new Set<string>();
  for (const m of calls) {
    const tool = m.logged?.tool ?? 'list';
    const spec = voiceToolSpec(tool);
    const out = r.outputs.get(m.callId);
    const cards = shown.get(m.callId) ?? 0;
    const eligible = !!spec && needsConfirm({ spec, args: m.args });
    if (cards > 1) add(`d:${seqOf(r, m.callId)}`, `${cards} cards for one ${tool} call`);
    if (!eligible && cards) add(`d:${seqOf(r, m.callId)}`, `a card for ${tool}, which needs none`);
    const acted = out && out['kind'] !== 'refused' && out['kind'] !== 'ambiguous';
    if (eligible && acted && cards + (covered.has(m.callId) ? 1 : 0) !== 1) add(`d:${seqOf(r, m.callId)}`, `${tool} ${String(out!['kind'])} with ${cards} cards and ${covered.has(m.callId) ? 'a' : 'no'} cover`);
    if (tool === 'message') {
      const ch = channelOf(m.args);
      if (covered.has(m.callId) && failedChannels.has(ch)) add(`d:${seqOf(r, m.callId)}`, 'a message rode the cover of a channel whose post failed');
      if (out?.['kind'] === 'failed') failedChannels.add(ch);
      else if (out && out['kind'] !== 'refused' && out['kind'] !== 'cancelled') failedChannels.delete(ch);
    }
  }

  // (e) refusals carry a reason other than `other`; failures carry a code.
  const callOfEvent = (d: Record<string, unknown>) => String(d['callId'] ?? '');
  for (const e of r.events) {
    if (e['kind'] !== 'refused') continue;
    const d = (e['data'] ?? {}) as Record<string, unknown>;
    const reason = d['reason'];
    if (typeof reason !== 'string' || !(REFUSAL_CODES as readonly string[]).includes(reason) || reason === 'other') add(`e:${seqOf(r, callOfEvent(d))}`, `${String(e['tool'])} refused with reason ${String(reason)}`);
  }
  for (const row of r.rows) {
    const summary = (row['summary'] ?? {}) as Record<string, unknown>;
    if (row['outcome'] === 'failed' && !(typeof summary['code'] === 'string' && ((FAILURE_CODES as readonly string[]).includes(summary['code']) || /^http-[45]\d\d$/.test(summary['code'])))) add(`e:row-${String(row['tool'])}`, `a failed ${String(row['tool'])} row without a code`);
  }
  for (const [callId, out] of r.outputs) if (out['kind'] === 'failed' && !codeOf(out)) add(`e:${seqOf(r, callId)}`, 'a failed output without a code');

  // (f) an identical refused call: the second in a turn is terminal (stop), a third never runs.
  for (const ms of byTurn.values()) {
    const seen = new Map<string, number>();
    for (const m of ms) {
      const out = r.outputs.get(m.callId);
      const k = callKey(m.logged?.tool ?? 'list', m.args);
      const before = seen.get(k) ?? 0;
      if (before >= 2 && r.ran.has(m.callId)) add(`f:${seqOf(r, m.callId)}`, `an identical ${m.logged?.tool} ran after two refusals in one turn`);
      if (out?.['kind'] === 'refused' || out?.['kind'] === 'ambiguous') {
        if (gateRefused(out) || out['code'] === 'card-open') continue;
        seen.set(k, before + 1);
        if (before === 1 && out['stop'] !== true) add(`f:${seqOf(r, m.callId)}`, `the second identical refused ${m.logged?.tool} was not terminal`);
      }
    }
  }

  // (g) the event log: tokens only, no canary word.
  const walk = (x: unknown, path: string): void => {
    if (typeof x === 'string') { if (!TOKEN.test(x) || x.includes('Replay')) add(`g:${path}`, `free text at ${path}`); return; }
    if (Array.isArray(x)) { x.forEach((y, i) => walk(y, `${path}[${i}]`)); return; }
    if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, `${path}.${k}`);
  };
  r.events.forEach((e, i) => walk(e, `event${i}`));
  r.rows.forEach((e, i) => walk(e, `row${i}`));
  r.closeBodies.forEach((e, i) => walk(e, `close${i}`));
  return v;
}


// ── the tests ─────────────────────────────────────────────────────────────

test('the fixture holds the owner\'s sessions, no words, every call with a tool and an outcome', () => {
  assert.ok(SESSIONS.length >= 25, `${SESSIONS.length} sessions`);
  for (const s of SESSIONS) {
    assert.match(s.id, /^s\d{2}$/);
    for (const d of s.delegations) for (const c of d.calls) {
      assert.ok(voiceToolSpec(c.tool), `${short(s.id)} seq ${c.seq}: ${c.tool} is a catalogue tool`);
      assert.match(c.outcome, /^(done|refused|failed|cancelled|unfinished)$/);
    }
  }
  const text = JSON.stringify(SESSIONS);
  assert.doesNotMatch(text, /"(delta|transcript|text|said|utterance|query|arguments|args|title|detail|message|name|note|say)"\s*:/, 'no word-bearing key');
  const strings = text.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  for (const s of strings) assert.match(JSON.parse(s) as string, TOKEN, 'every string is a token');
});

for (const session of SESSIONS) {
  test(`replay ${short(session.id)} (${session.tenant}, ${session.counts['delegations']} delegations, ${session.counts['calls']} calls): invariants a to g`, async () => {
    const r = await replayOf(session);
    assert.deepEqual([...violations(r)].map(([k, why]) => `${k} ${why}`), [], `${short(session.id)} replay breaks an invariant`);
    // Every logged call was made again, and every delegation with a call reached the dock.
    assert.equal([...r.metas.values()].filter((m) => m.logged).length, session.counts['calls']);
    assert.equal(r.delegationsPlayed, session.delegations.filter((d) => d.calls.length).length);
  });
}

// ── G64: the bugs the first replays exposed, fixed ───────────────────────

test('G64 B1: the four sessions a stuck delegation made deaf now continue every output and answer to the end', async () => {
  // The call after two stop answers whose output the dock used to leave without a continuation (delegation-stuck).
  for (const [prefix, seq] of [['s14', 193], ['s10', 59], ['s20', 50], ['s05', 14]] as const) {
    const r = await replayOf(sessionNamed(prefix));
    const m = [...r.metas.values()].find((x) => x.logged?.seq === seq);
    assert.ok(m, `${prefix} seq ${seq} was replayed`);
    assert.equal(r.outputs.get(m.callId)?.['kind'], 'refused', `${prefix} seq ${seq} is still refused before it runs`);
    const i = r.sent.findIndex((s) => s.type === 'output' && s.callId === m.callId);
    assert.equal(r.sent[i + 1]?.type, 'create', `${prefix} seq ${seq}: its output is continued`);
    const events = r.events.map((e) => (e['data'] as Record<string, unknown> | undefined)?.['event']);
    assert.ok(events.includes('delegation-stuck'), `${prefix}: the stuck delegation is still logged`);
    assert.ok(!events.includes('restart'), `${prefix}: no runaway restart`);
    assert.equal(r.delegationsPlayed, sessionNamed(prefix).delegations.filter((d) => d.calls.length).length, `${prefix}: every later delegation reached the dock`);
    assert.ok(r.probeAnswered, `${prefix}: and one more request is answered`);
  }
});

test('G64 B2 (s25 seq 7): open { page, tab } on a page with no known tabs is refused `invalid-arguments` with the forms that work', async () => {
  const r = await replayOf(sessionNamed('s25'));
  const m = [...r.metas.values()].find((x) => x.logged?.seq === 7)!;
  assert.deepEqual(m.args, { page: 'communication', tab: 'channels' });
  const out = r.outputs.get(m.callId)!;
  assert.equal(out['code'], 'invalid-arguments');
  assert.match(String(out['next']), /scope "this-page" and tab/);
  assert.match(String(out['next']), /ref with tab/);
});

test('G64 B2: open { page, tab } opens the page on its tab when the page declares tabs or is the one in view', async () => {
  const palette = toolContext().palette;
  const page = palette.pages.find((p) => p.pageId === 'communication' && p.tenant === 'orgiq')!;
  // Declared by the palette row.
  const declared = toolContext({ palette: { ...palette, pages: palette.pages.map((p) => (p === page ? { ...p, tabs: ['channels', 'dms'] } : p)) } });
  const res = await runVoiceTool('open', { page: 'communication', tab: 'channels' }, declared);
  assert.equal(res.outcome, 'done');
  assert.equal(res.output['stop'], true, 'a page is a navigation (G51)');
  assert.deepEqual(declared.navigations, [`${page.path}?tab=channels`]);
  const missing = await runVoiceTool('open', { page: 'communication', tab: 'calls' }, declared);
  assert.equal(missing.output['code'], 'not-on-this-page');
  assert.deepEqual(missing.output['tabs'], ['channels', 'dms']);
  // Published by the page in view (usePublishPageTabs).
  const inView = toolContext({ tabs: () => ({ path: page.path, tabs: ['history', 'channels'], tab: 'history' }) });
  const viewed = await runVoiceTool('open', { page: 'communication', tab: 'channels' }, inView);
  assert.equal(viewed.outcome, 'done');
  assert.deepEqual(inView.navigations, [`${page.path}?tab=channels`]);
});

test('G64 B3 (s14 seq 157): the dispatch planner says `not-dispatchable` (with why) and `not-on-initiative`, never `other`', async () => {
  // The retry after the first dispatch landed (G48's reading of): the item is in progress now.
  const plan = async (status: string, rowRef: string) => {
    const { fetch } = fakeFetch([
      route('GET', '/api/graph/projects/p-1/work', 200, [{ id: 'e-1', type: 'epic', title: 'Epic', children: [{ id: 'w-1', type: 'story', title: 'Rotate the keys', status, storyPoints: 3, children: [] }] }]),
      route('GET', '/api/graph/projects/p-1', 200, { name: 'Alpha' }),
      route('GET', '/api/agent-projects', 200, { projects: [] }),
    ]);
    const ctx = toolContext({ fetch, tenant: 'orgiq', role: 'admin', results: new ResultMemory(), jobs: { track: () => {} },
      page: () => ({ path: '/iq/projects/p-1', record: { ref: 'initiative:p-1', title: 'Alpha' }, rows: [{ ref: rowRef, title: 'Rotate the keys', href: '/iq/projects/p-1?item=w-1' }] }) });
    const prepared = prepareToolCall('queue_work', { kind: 'dispatch', target: 'the first one', scope: 'this-page', rows: [1] }, ctx);
    assert.ok(prepared.ok);
    const out = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
    assert.ok(out && 'result' in out && out.result.outcome === 'refused', 'the planner refuses it');
    return out.result.output;
  };
  const busy = await plan('in_progress', 'work-item:w-1');
  assert.equal(refusalCode(busy), 'not-dispatchable');
  assert.match(String(busy['blocked']), /up next/);
  assert.match(String(busy['next']), /cannot be dispatched now/);
  const elsewhere = await plan('open', 'work-item:w-9');
  assert.equal(refusalCode(elsewhere), 'not-on-initiative');
  assert.match(String(elsewhere['next']), /not work of the initiative in view/);
});

// ── regressions the gaps doc established, on the sessions that showed them ──

test('G51 (s14, four pages in one request): designs opens, the other three are refused `navigated` and every round is continued', async () => {
  const r = await replayOf(sessionNamed('s14'));
  const bySeq = new Map([...r.metas.values()].filter((m) => m.logged).map((m) => [m.logged!.seq, m]));
  const designs = bySeq.get(187)!;
  assert.equal(designs.args['page'], 'designs');
  assert.ok(r.ran.has(designs.callId));
  assert.equal(r.outputs.get(designs.callId)?.['stop'], true, 'the navigation ends the request');
  for (const seq of [189, 191, 193]) {
    const m = bySeq.get(seq)!;
    assert.equal(r.outputs.get(m.callId)?.['code'], 'navigated', `seq ${seq}`);
    assert.ok(!r.ran.has(m.callId), 'refused before it runs');
    const i = r.sent.findIndex((s) => s.type === 'output' && s.callId === m.callId);
    assert.equal(r.sent[i + 1]?.type, 'create', `G59/G64: seq ${seq}'s round is continued`);
  }
});

test('G51 follow-up (s17): the read of the record just opened runs today, where the log refused it `navigated` and went silent', async () => {
  const r = await replayOf(sessionNamed('s17'));
  const get = [...r.metas.values()].find((m) => m.logged?.seq === 21)!;
  assert.equal(get.logged!.reason, 'navigated');
  assert.ok(r.ran.has(get.callId));
  assert.notEqual(r.outputs.get(get.callId)?.['kind'], 'refused');
  assert.ok(r.probeAnswered, 'and the next request is answered (the log: silent for the remaining 30 s)');
});

test('G43 + G59 (s14): the fifth call is refused `too-many-calls`, the round is continued, and the session answers again', async () => {
  const r = await replayOf(sessionNamed('s14'));
  const fifth = [...r.metas.values()].find((m) => m.logged?.seq === 243)!;
  const out = r.outputs.get(fifth.callId)!;
  assert.equal(out['code'], 'too-many-calls');
  assert.equal(out['stop'], true);
  const i = r.sent.findIndex((s) => s.type === 'output' && s.callId === fifth.callId);
  assert.equal(r.sent[i + 1]?.type, 'create');
  assert.ok(r.probeAnswered, 'the log: one 1.9 s line, then nothing for 67 s');
});

test('G48 + G41 (s15, four posts that failed): two tries with their cards, then `repeat-failed` before any card', async () => {
  const r = await replayOf(sessionNamed('s15'));
  const posts = [...r.metas.values()].filter((m) => m.logged?.tool === 'message');
  assert.deepEqual(posts.map((m) => m.logged!.seq), [8, 19, 39, 49]);
  assert.deepEqual(posts.map((m) => { const o = r.outputs.get(m.callId)!; return o['kind'] === 'refused' ? `refused ${String(o['code'])}` : String(o['kind']); }),
    ['failed', 'failed', 'refused repeat-failed', 'refused repeat-failed']);
  assert.equal(r.outputs.get(posts[1]!.callId)?.['stop'], true, 'the second failure ends the round');
  const shown = r.events.filter((e) => e['kind'] === 'confirm-shown').map((e) => (e['data'] as Record<string, unknown>)['callId']);
  assert.deepEqual(shown.filter((id) => posts.some((p) => p.callId === id)), [posts[0]!.callId, posts[1]!.callId], 'each try showed its card; no cover after a failure');
  for (const p of posts.slice(0, 2)) assert.match(String(r.outputs.get(p.callId)?.['code']), /^(not-connected|not-a-member|receipt-timeout|timeout|rejected|http-\d{3})$/, 'G47: the failure says why');
});

test('G42 (s10): `get message:<id>` is refused `invalid-ref`, no longer the catch-all `other`', async () => {
  const r = await replayOf(sessionNamed('s10'));
  const get = [...r.metas.values()].find((m) => m.logged?.seq === 50)!;
  assert.equal(get.logged!.reason, 'other');
  assert.equal(r.outputs.get(get.callId)?.['code'], 'invalid-ref');
});

test('G62: an ambiguous answer with one candidate shows no choice card (s19, s33); two candidates show one (s21)', async () => {
  for (const [prefix, cards] of [['s19', 0], ['s33', 0], ['s21', 1]] as const) {
    const s = sessionNamed(prefix);
    assert.ok(s.delegations.some((d) => d.calls.some((c) => c.reason === 'ambiguous' && c.candidates === (cards ? 2 : 1))), prefix);
    const r = await replayOf(s);
    const shown = r.events.filter((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === 'choice-shown');
    assert.equal(shown.length, cards, prefix);
  }
});

/**
 * The calls the model made in a real session that today's controller refuses before they run (G43 too-many-calls,
 * G48 repeat-failed, G51 navigated), by logged seq. A change here is a change of policy: read the session in
 * docs/voice-navigator-gaps.md before updating it.
 */
const UP_FRONT: Record<string, Record<string, string>> = {
  s03: { 23: 'navigated', 25: 'navigated' },
  s05: { 12: 'too-many-calls', 13: 'too-many-calls', 14: 'too-many-calls', 15: 'too-many-calls', 29: 'navigated', 30: 'navigated' },
  s07: { 19: 'navigated', 21: 'navigated' },
  's08': { 39: 'navigated' },
  s10: { 55: 'navigated', 57: 'navigated', 59: 'navigated' },
  s14: { 113: 'too-many-calls', 189: 'navigated', 191: 'navigated', 193: 'navigated', 227: 'navigated', 243: 'too-many-calls' },
  's15': { 39: 'repeat-failed', 49: 'repeat-failed' },
  's20': { 46: 'too-many-calls', 48: 'too-many-calls', 50: 'too-many-calls', 52: 'too-many-calls', 54: 'too-many-calls' },
  's28': { 62: 'navigated' },
  's29': { 42: 'navigated', 45: 'navigated' },
};

test('the calls today\'s controller refuses up front, per session, are the ones the gaps doc expects', async () => {
  for (const s of SESSIONS) {
    const r = await replayOf(s);
    assert.deepEqual(upFront(r), UP_FRONT[short(s.id)] ?? {}, short(s.id));
  }
});

// REPLAY_DEBUG=all (or a comma list of session prefixes) prints every replayed call, the log's ending and today's.
if (process.env['REPLAY_DEBUG']) {
  test('debug: the replayed calls of the named sessions', async () => {
    const table: Record<string, Record<string, string>> = {};
    for (const s of SESSIONS.filter((x) => process.env['REPLAY_DEBUG'] === 'all' || process.env['REPLAY_DEBUG']!.split(',').includes(short(x.id)))) {
      const r = await replayOf(s);
      console.log(`== ${short(s.id)}: ${r.virtualMs} ms of virtual time`);
      for (const line of describe(r)) console.log(line);
      for (const [k, why] of violations(r)) console.log(`  violation ${k}: ${why}`);
      if (Object.keys(upFront(r)).length) table[short(s.id)] = upFront(r);
    }
    console.log(`up front: ${JSON.stringify(table)}`);
  });
}
