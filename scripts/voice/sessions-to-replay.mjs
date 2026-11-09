#!/usr/bin/env node
// scripts/voice/sessions-to-replay.mjs : the owner's real voice sessions as a replay fixture.
//
// Reads every session log in middleware/.voice-log/*.jsonl (the middleware's own
// session log: event kinds, tool names, argument shapes, outcomes, codes, never
// words) and writes portal/src/lib/voice/__tests__/fixtures/real-sessions.json,
// which realSessions.test.ts replays through today's controller.
//
//   node scripts/voice/sessions-to-replay.mjs              regenerate the fixture
//   node scripts/voice/sessions-to-replay.mjs --check      exit 1 when the fixture on disk differs
//   node scripts/voice/sessions-to-replay.mjs --log <dir>  read another log folder
//
// What is kept, per session: the tenant, the minted tool list, and the ordered
// delegations, each with whether the user spoke before it (the dock listening
// or thinking since the last delegation) and its tool calls: the tool, the summarized
// argument shape (the enum values, a ref's kind, counts: argShape in
// portal/src/lib/voice/sessionEvents.ts), a 12-hex prefix of the argument hash
// (equal prefixes are equal arguments, nothing else), the outcome with its
// refusal reason or failure code, and the card (shown, by voice or click,
// confirmed / cancelled / never answered). Also the stops (G29, G43, G48, G51
// refusals and the dock's stop diagnostics) and how the session closed.
// Timings are milliseconds from the session's start, rounded to 100 ms.
//
// Which logs count as real sessions: a row of kind `sideband` (a Live API
// connection the middleware watched; the middleware's own tests and the mock
// mint have none) and at least one delegation or tool result. Sessions recorded
// before the dock logged delegations (8 November, before 23:30) carry only
// tool-result rows: their delegations are inferred (calls less than 3 s apart
// are one delegation) and marked `inferred`.
//
// No words: only whitelisted keys are copied, every string must be a closed-
// vocabulary token (letters, digits, `_ - : , .`, no spaces), and the script
// refuses to write if anything else made it through (assertNoWords).

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const logArg = argv.indexOf('--log');
const LOG_DIR = logArg >= 0 ? resolve(argv[logArg + 1]) : join(ROOT, 'middleware/.voice-log');
const OUT = join(ROOT, 'portal/src/lib/voice/__tests__/fixtures/real-sessions.json');
const CHECK = argv.includes('--check');

/** The argument-shape keys argShape can write (sessionEvents.ts SHAPE_KEYS and its derived fields). */
const SHAPE_KEYS = new Set([
  'action', 'phrase', 'kind', 'scope', 'detail', 'part', 'sort', 'answer', 'type', 'groupBy', 'status', 'page', 'tab', 'decision',
  'filterScope', 'filteredBy', 'refKind', 'targetKind', 'byName', 'rowCount', 'targets', 'thread', 'attachKind', 'fields',
]);
/** The result-summary keys copied (resultSummary in sessionEvents.ts), minus ids. */
const RESULT_KEYS = new Set(['reason', 'code', 'gate', 'result', 'count', 'rows', 'candidates', 'of']);
/** The refusals the controller itself gives before a call runs, and the stops. */
const STOP_REASONS = new Set(['too-many-calls', 'navigated', 'repeat-failed']);
const STOP_EVENTS = new Set(['refusal-repeated', 'delegation-stuck', 'delegation-empty', 'unanswered', 'restart', 'unanswered-dismissed']);
/** Keys that hold words anywhere in the voice stack (the dock's NEVER_KEYS and the server's FORBIDDEN_KEYS). */
const WORD_KEYS = new Set([
  'delta', 'transcript', 'text', 'said', 'utterance', 'words', 'content', 'body', 'message_text', 'instructions', 'prompt',
  'args', 'arguments', 'input', 'output', 'query', 'q', 'sdp', 'summary_text', 'title', 'detail', 'message', 'name', 'note', 'say',
]);
const TOKEN = /^[A-Za-z0-9_.:,-]{0,120}$/;
const INFER_GAP_MS = 3000;

const round = (ms) => Math.max(0, Math.round(ms / 100) * 100);
const token = (v) => (typeof v === 'string' && TOKEN.test(v) ? v : null);

function shapeOf(data) {
  const out = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (!SHAPE_KEYS.has(k)) continue;
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (token(v) != null) out[k] = v;
  }
  return out;
}

function resultOf(summary) {
  const out = {};
  for (const [k, v] of Object.entries(summary ?? {})) {
    if (!RESULT_KEYS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (token(v) != null) out[k] = v;
  }
  return out;
}

function readSession(file) {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows.sort((a, b) => a.seq - b.seq);
  const kinds = new Set(rows.map((r) => r.kind));
  const minted = rows.find((r) => r.kind === 'minted');
  if (!minted || minted.data?.mock === true || !kinds.has('sideband')) return null;
  if (!kinds.has('delegation') && !kinds.has('tool-result')) return null;
  const t0 = Date.parse((rows.find((r) => r.kind === 'started') ?? minted).at);
  const at = (r) => round(Date.parse(r.at) - t0);

  // Pair each tool-call row with the next result row of the same tool (the dock answers calls one at a time).
  const results = rows.filter((r) => r.kind === 'tool-result');
  const used = new Set();
  const resultFor = (call) => {
    const r = results.find((x) => !used.has(x) && x.seq > call.seq && x.data?.tool === call.data?.tool);
    if (r) used.add(r);
    return r ?? null;
  };
  const cardFor = (callId) => {
    if (!callId) return null;
    const shown = rows.find((r) => r.kind === 'confirm-shown' && r.data?.callId === callId);
    if (!shown) return null;
    const decided = rows.find((r) => (r.kind === 'confirmed' || r.kind === 'cancelled') && r.data?.callId === callId);
    const card = { shownMs: at(shown), mode: token(shown.data?.by) ?? null, decision: decided ? decided.kind : 'unanswered' };
    if (decided) {
      card.by = token(decided.data?.by);
      if (typeof decided.data?.afterMs === 'number') card.afterMs = round(decided.data.afterMs);
      if (token(decided.data?.phrase)) card.phrase = decided.data.phrase;
    }
    const told = rows.filter((r) => r.kind === 'client' && r.data?.event === 'click-required' && r.seq > shown.seq && (!decided || r.seq < decided.seq)).length;
    if (told) card.clickRequired = told;
    return card;
  };
  const callOf = (callRow, result) => {
    const d = result?.data ?? {};
    const call = {
      seq: callRow ? callRow.seq : result.seq,
      atMs: callRow ? at(callRow) : round(Date.parse(result.at) - t0 - (d.durationMs ?? 0)),
      tool: token((callRow ?? result).data?.tool),
      shape: shapeOf(callRow ? callRow.data : d.summary),
      argsKey: typeof d.argsSha256 === 'string' && /^[0-9a-f]{64}$/.test(d.argsSha256) ? d.argsSha256.slice(0, 12) : null,
      outcome: result ? token(d.outcome) : 'unfinished',
      ...resultOf(d.summary),
    };
    if (result) { call.resultSeq = result.seq; call.durationMs = round(d.durationMs ?? 0); }
    const refusal = rows.find((r) => r.kind === 'refused' && callRow && r.data?.callId === callRow.data?.callId);
    if (refusal && !call.reason && token(refusal.data?.reason)) call.reason = refusal.data.reason;
    const card = callRow ? cardFor(callRow.data?.callId) : null;
    if (card) call.card = card;
    else if (result && (d.confirmedBy === 'voice' || d.confirmedBy === 'click')) {
      // A rows-only session: the result says who confirmed (or cancelled) the card it had.
      call.card = { shownMs: call.atMs, mode: null, decision: d.outcome === 'cancelled' ? 'cancelled' : 'confirmed', by: d.confirmedBy, afterMs: round(d.durationMs ?? 0), inferred: true };
    }
    return call;
  };

  const delegations = [];
  // The user had the floor since the last delegation (the dock listening or thinking, or the delegation's own phase
  // change coming from there): the delegation answers new words. Only one opened while the dock stayed executing,
  // confirming or speaking is taken as the same user turn.
  const floor = (p) => p === 'listening' || p === 'thinking';
  const heardSince = (fromSeq, toSeq) => rows.some((r) => r.kind === 'client' && r.data?.event === 'phase' && r.seq > fromSeq && r.seq <= toSeq + 1
    && ((r.seq < toSeq && floor(r.data?.phase)) || (r.seq > toSeq && floor(r.data?.from))));
  const callRows = rows.filter((r) => r.kind === 'tool-call');
  if (kinds.has('delegation') || callRows.length) {
    let lastSeq = 0;
    let current = null;
    for (const r of rows) {
      if (r.kind === 'delegation') {
        current = { atMs: at(r), seq: r.seq, heardBefore: heardSince(lastSeq, r.seq), calls: [] };
        delegations.push(current);
        lastSeq = r.seq;
      } else if (r.kind === 'tool-call') {
        if (!current) { current = { atMs: at(r), seq: r.seq, heardBefore: true, inferred: true, calls: [] }; delegations.push(current); }
        current.calls.push(callOf(r, resultFor(r)));
      }
    }
  } else {
    // Rows only: one call per result, a new delegation when the next call starts INFER_GAP_MS after the last ended.
    let lastEnd = -Infinity;
    let current = null;
    for (const r of results) {
      const call = callOf(null, r);
      used.add(r);
      if (!current || call.atMs - lastEnd > INFER_GAP_MS) {
        current = { atMs: call.atMs, seq: r.seq, heardBefore: true, inferred: true, calls: [] };
        delegations.push(current);
      }
      current.calls.push(call);
      lastEnd = round(Date.parse(r.at) - t0);
    }
  }

  const stops = [];
  for (const d of delegations) for (const c of d.calls) if (STOP_REASONS.has(c.reason)) stops.push({ seq: c.seq, atMs: c.atMs, kind: c.reason, tool: c.tool });
  for (const r of rows) if (r.kind === 'client' && STOP_EVENTS.has(r.data?.event)) stops.push({ seq: r.seq, atMs: at(r), kind: r.data.event });
  stops.sort((a, b) => a.seq - b.seq);
  const closed = rows.filter((r) => r.kind === 'closed').at(-1);
  const calls = delegations.flatMap((d) => d.calls);
  return {
    id: token(minted.sessionId),
    tenant: token(minted.tenant),
    date: token(minted.at.slice(0, 16)),
    tools: (minted.data?.tools ?? []).map(token).filter(Boolean),
    format: kinds.has('delegation') ? 'delegations' : 'rows-only',
    durationMs: round(Date.parse(rows.at(-1).at) - t0),
    counts: {
      delegations: delegations.length, calls: calls.length,
      done: calls.filter((c) => c.outcome === 'done').length, refused: calls.filter((c) => c.outcome === 'refused').length,
      failed: calls.filter((c) => c.outcome === 'failed').length, cancelled: calls.filter((c) => c.outcome === 'cancelled').length,
      unfinished: calls.filter((c) => c.outcome === 'unfinished').length, cards: calls.filter((c) => c.card).length,
    },
    delegations,
    stops,
    close: closed ? { stopReason: token(closed.data?.stopReason), reason: token(closed.data?.reason) } : null,
  };
}

/** Fails loudly when anything but a closed-vocabulary token, a number or a boolean was copied, or a word key appears. */
function assertNoWords(v, path = '$') {
  if (v == null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
  if (typeof v === 'string') {
    if (!TOKEN.test(v)) throw new Error(`free text at ${path}: refusing to write the fixture`);
    return;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => assertNoWords(x, `${path}[${i}]`)); return; }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (WORD_KEYS.has(k.toLowerCase())) throw new Error(`word-bearing key ${path}.${k}: refusing to write the fixture`);
      assertNoWords(x, `${path}.${k}`);
    }
    return;
  }
  throw new Error(`unexpected value at ${path}`);
}

const files = existsSync(LOG_DIR) ? readdirSync(LOG_DIR).filter((f) => /^vs_[0-9a-f-]{36}\.jsonl$/.test(f)).sort() : [];
if (!files.length) { console.error(`no session logs in ${LOG_DIR}`); process.exit(1); }
const sessions = files.map((f) => readSession(join(LOG_DIR, f))).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
const fixture = {
  about: 'The owner\'s real voice sessions (middleware/.voice-log), summarized for realSessions.test.ts by scripts/voice/sessions-to-replay.mjs. No words: shapes, outcomes, codes, timings (ms from start, 100 ms).',
  sessions,
};
assertNoWords(fixture.sessions);
const text = `${JSON.stringify(fixture, null, 1)}\n`;
const total = sessions.reduce((n, s) => n + s.counts.calls, 0);
if (CHECK) {
  const disk = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (disk !== text) { console.error(`${OUT} is stale: run node scripts/voice/sessions-to-replay.mjs`); process.exit(1); }
  console.log(`fixture current: ${sessions.length} sessions, ${total} calls`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: ${sessions.length} sessions, ${sessions.reduce((n, s) => n + s.counts.delegations, 0)} delegations, ${total} calls`);
}
