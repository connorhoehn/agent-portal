#!/usr/bin/env node
// Differential probe for the voice navigator: start a Live session over the primary WebSocket with EXACTLY the
// `session` object the middleware mints (lib/voice/openai.ts liveSessionBody, fed the way routes/voice.ts feeds it
// for a tenant), speak WAV utterances into it, answer every delegated function call, and record every frame.
// Package V1's scripts/voice/probe-realtime.mjs used its own prototype body; this one isolates the middleware's.
//
//   cd middleware && npx tsx ../scripts/voice/probe-middleware-body.mjs --label <s> --out <file.jsonl> \
//       --wav <utterance.wav> [--wav <second.wav> ...] [--tenant orgiq] [--dry (print the session object, no call)]
//
// The only changes to the minted body are the transport's: a WebSocket needs session.audio.format
// ({ type: 'audio/pcm', rate: 24000 }), which WebRTC negotiates itself, and refuses session.client.data_channel
// (error invalid_value "client.data_channel is only supported for WebRTC sessions.", 8 November), so `client` is
// dropped; the allowlist is exercised by a browser walk instead (docs/voice-navigator-spec.md §1, 8 November).
// One toggle per session isolates a suspect:
//   TOGGLE=v1-instructions     session.instructions = V1's prototype voice prompt (it says "Delegate to the backend")
//   TOGGLE=no-parallel         drop delegation.responses.parallel_tool_calls
//   TOGGLE=v1-tools            delegation.responses.tools = V1's two loose tools instead of the strict catalogue
//
// Tool results: search_people / search_records read GET {PORTAL_API}/api/search (default http://localhost:3001, the
// mock middleware, read-only, no cookie: the demo session) shaped as portal/src/lib/voice/tools.ts searchRunner does;
// navigate and the rest answer { ok: true } so the loop completes. Every session is closed within HARD_CAP_MS.
//
// The key comes from OPENAI_API_KEY, else middleware/.env, and is never logged: every line passes the same redaction
// as probe-realtime.mjs, and a line containing the key's prefix throws instead of being written.
import { readFileSync, appendFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const mw = (p) => new URL(`../../middleware/src/${p}`, here).href;
const { liveSessionBody } = await import(mw('lib/voice/openai.ts'));
const { toolsForTenant, responsesFunctionTools, voiceInstructions, delegationInstructions } = await import(mw('lib/voice/catalogue.ts'));
const { voiceConfig } = await import(mw('lib/voice/config.ts'));

function keyFromMiddlewareEnv() {
  try {
    const m = readFileSync(new URL('../../middleware/.env', here), 'utf8').match(/^OPENAI_API_KEY=(.*)$/m);
    return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
  } catch { return ''; }
}
const KEY = process.env.OPENAI_API_KEY || keyFromMiddlewareEnv();
const API = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const WSS = API.replace(/^http/, 'ws');
const PORTAL_API = (process.env.PORTAL_API || 'http://localhost:3001').replace(/\/$/, '');
const TOGGLE = process.env.TOGGLE || '';
const HARD_CAP_MS = Number(process.env.HARD_CAP_MS || 40_000);
const RATE = 24000, CHUNK_MS = 100, CHUNK_BYTES = (RATE * 2 * CHUNK_MS) / 1000;

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const wavs = argv.flatMap((a, i) => (a === '--wav' ? [argv[i + 1]] : []));
const LABEL = opt('--label', 'mw-body');
const OUT = opt('--out', '');
const TENANT = opt('--tenant', 'orgiq');
if (!KEY) { console.error('No key: set OPENAI_API_KEY or put it in middleware/.env'); process.exit(1); }
if (!argv.includes('--dry') && (!OUT || !wavs.length)) { console.error('usage: probe-middleware-body.mjs --label <s> --out <file.jsonl> --wav <file> [--wav <file>]'); process.exit(1); }

const T0 = performance.now();
const now = () => Math.round(performance.now() - T0);
const KEY_PREFIX = KEY.slice(0, 12);
const SECRET_KEYS = /^(authorization|client_secret|ephemeral.*|api_key|secret|password)$/i;
function rms(b64) {
  const b = Buffer.from(b64, 'base64'); let s = 0; const n = Math.floor(b.length / 2);
  for (let i = 0; i < n; i++) { const x = b.readInt16LE(i * 2) / 32768; s += x * x; }
  return n ? Math.round(Math.sqrt(s / n) * 10000) / 10000 : 0;
}
function redact(v, k = '', pt = '') {
  if (typeof v === 'string') {
    if (SECRET_KEYS.test(k)) return '[redacted]';
    if (v.includes(KEY_PREFIX) || /sk-[A-Za-z0-9_-]{8,}/.test(v)) return '[redacted sk-]';
    if ((k === 'audio' || k === 'delta') && /audio/.test(pt)) return { bytes: Buffer.byteLength(v, 'base64'), rms: rms(v) };
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, k, pt));
  if (v && typeof v === 'object') {
    const o = {}; const t = typeof v.type === 'string' ? v.type : pt;
    for (const [kk, x] of Object.entries(v)) o[kk] = SECRET_KEYS.test(kk) ? '[redacted]' : redact(x, kk, t);
    return o;
  }
  return v;
}
function log(dir, ev) {
  const line = JSON.stringify({ t: now(), s: LABEL, dir, ...redact(ev) });
  if (line.includes(KEY_PREFIX)) throw new Error('refusing to log a line containing the key');
  appendFileSync(OUT, line + '\n');
}
const note = (type, data = {}) => log('note', { type, ...data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readWav(file) {
  const b = readFileSync(file);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) throw new Error(`${file}: need PCM16 mono 24 kHz`);
  return data;
}

// ---------- the session object, exactly as routes/voice.ts mints it ----------
const cfg = voiceConfig();
const tools = toolsForTenant(TENANT);
const session = liveSessionBody({
  model: cfg.model, instructions: voiceInstructions(TENANT, cfg.delegationModel ? tools : []),
  delegationInstructions: delegationInstructions(TENANT), voice: cfg.voice,
  delegationModel: cfg.delegationModel, tools: responsesFunctionTools(tools),
});
session.audio = { ...(session.audio ?? {}), format: { type: 'audio/pcm', rate: RATE } };
delete session.client;
const V1_INSTRUCTIONS = 'You are a friendly voice assistant. Keep answers short and conversational. You help the user move around the OrgIQ portal. Delegate to the backend whenever the user asks to open a page, search, or look someone up; the backend can open pages and search people. Never invent results.';
if (TOGGLE === 'v1-instructions') session.instructions = V1_INSTRUCTIONS;
if (TOGGLE === 'no-parallel') delete session.delegation?.responses?.parallel_tool_calls;
if (TOGGLE === 'v1-tools' && session.delegation) {
  session.delegation.responses.tools = [
    { type: 'function', name: 'navigate', description: 'Open a portal page in the user\'s browser tab.', parameters: { type: 'object', properties: { route: { type: 'string', enum: ['/iq/search', '/admin/devbox', '/iq/projects'] } }, required: ['route'], additionalProperties: false }, strict: true },
    { type: 'function', name: 'search_people', description: 'Search the organisation\'s people directory (skills, experts, owners).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, strict: true },
  ];
}

if (argv.includes('--dry')) { console.log(JSON.stringify(session, null, 1)); process.exit(0); }

// ---------- tool results ----------
async function runTool(name, argsJson) {
  let a = {}; try { a = JSON.parse(argsJson || '{}'); } catch { return { ok: false, error: 'arguments were not JSON' }; }
  if (name === 'search_people' || name === 'search_records') {
    const type = name === 'search_people' ? 'person' : (a.type ?? 'all');
    const limit = typeof a.limit === 'number' ? a.limit : 5;
    const q = new URLSearchParams({ q: String(a.query ?? ''), type, limit: String(limit), ...(a.sort ? { sort: a.sort } : {}) });
    try {
      const r = await fetch(`${PORTAL_API}/api/search?${q}`, { signal: AbortSignal.timeout(5000) });
      const body = await r.json();
      const rows = (body.results ?? []).slice(0, limit).map((x) => ({ name: x.title, subtitle: x.subtitle, detail: x.description, matched: x.matchReason, href: x.href }));
      return { kind: 'search_results', type, query: a.query, total: body.total ?? rows.length, rows };
    } catch (e) { return { ok: false, error: `search read failed: ${e.message}` }; }
  }
  return { ok: true, tool: name, note: 'probe: done' };
}

// ---------- the socket ----------
const ws = new WebSocket(`${WSS}/live/sessions`, { headers: { Authorization: `Bearer ${KEY}` } });
let closed = false, started = false, lastOutputAt = 0, lastAnswerAt = 0;
const pending = new Map();
const waiters = [];
const wake = (ev) => { for (const w of [...waiters]) if (!ev || w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev ?? null); } };
const waitFor = (pred, ms, label) => new Promise((resolve) => {
  if (closed) return resolve(null);
  const w = { pred, resolve }; waiters.push(w);
  setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); note('wait.timeout', { label, ms }); resolve(null); } }, ms);
});
function send(ev) { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(ev)); log('out', ev); } else note('send.dropped', { event_type: ev.type }); }
async function answer(call) {
  const output = await runTool(call.name, call.arguments);
  note('tool.result', { call_id: call.call_id, name: call.name, output });
  send({ type: 'response.item.create', event_id: `tool_result_${call.call_id}`, item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) } });
  pending.delete(call.call_id);
  lastAnswerAt = now();
  if (![...pending.values()].some((p) => p.delegation_id === call.delegation_id)) send({ type: 'response.create', event_id: `continue_${call.call_id}` });
}
ws.addEventListener('message', ({ data }) => {
  let ev; try { ev = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { return; }
  log('in', ev);
  if (ev.type === 'session.started') started = true;
  if (ev.type === 'session.output_transcript.delta') lastOutputAt = now();
  if (ev.type === 'response.event' && ev.event?.type === 'response.output_item.done' && ev.event.item?.type === 'function_call') {
    const it = ev.event.item;
    const call = { call_id: it.call_id, name: it.name, arguments: it.arguments, delegation_id: ev.delegation_id };
    pending.set(it.call_id, call);
    note('tool.call', call);
    void answer(call);
  }
  wake(ev);
});
ws.addEventListener('close', (e) => { closed = true; note('ws.close', { code: e.code, reason: e.reason }); wake(); });

const queue = [];
let mic;
function startMic() {
  let next = performance.now();
  const tick = () => {
    if (closed) return;
    const c = queue.length ? queue.shift() : Buffer.alloc(CHUNK_BYTES);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: c.toString('base64') }));
    next += CHUNK_MS; mic = setTimeout(tick, Math.max(0, next - performance.now()));
  };
  tick();
}
function say(pcm, file) {
  note('mic.utterance', { file: file.replace(/^.*\//, ''), ms: Math.round((pcm.length / (RATE * 2)) * 1000) });
  for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
    const c = pcm.subarray(i, i + CHUNK_BYTES);
    queue.push(c.length === CHUNK_BYTES ? c : Buffer.concat([c, Buffer.alloc(CHUNK_BYTES - c.length)]));
  }
}
async function quiet(quietMs, maxMs, label, since) {
  const end = now() + maxMs;
  while (!closed && now() < end) {
    const mark = Math.max(since, lastAnswerAt);
    if (lastOutputAt > mark && now() - lastOutputAt >= quietMs && pending.size === 0) return true;
    await sleep(100);
  }
  note('quiet.timeout', { label, maxMs });
  return false;
}
async function close() {
  clearTimeout(mic);
  const done = waitFor((e) => e.type === 'session.closed', 10_000, 'session.closed');
  send({ type: 'session.close' });
  await done;
  try { ws.close(1000); } catch {}
}

note('probe.start', { toggle: TOGGLE || 'none', tenant: TENANT, model: cfg.model, delegation_model: cfg.delegationModel, tools: tools.map((t) => t.name), node: process.version });
const killer = setTimeout(() => { note('probe.killed'); process.exit(2); }, HARD_CAP_MS + 20_000);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', () => reject(new Error('ws error'))); });
send({ type: 'session.start', event_id: `start_${LABEL}`, session });
const first = await waitFor((e) => e.type === 'session.started' || e.type === 'error', 10_000, 'session.started');
if (first?.type !== 'session.started') { note('result', { started: false, first: first?.type ?? null }); try { ws.close(1000); } catch {} clearTimeout(killer); process.exit(1); }
const cap = setTimeout(() => { note('hard.cap', { ms: HARD_CAP_MS }); void close(); }, HARD_CAP_MS);
startMic();
await sleep(600);
for (const file of wavs) {
  if (closed) break;
  say(readWav(file), file);
  while (queue.length && !closed) await sleep(CHUNK_MS);
  // Count only speech after the utterance went out: the previous answer may still be playing when it starts.
  await quiet(1500, 15_000, file.replace(/^.*\//, ''), now());
}
clearTimeout(cap);
if (!closed) await close();
clearTimeout(killer);
note('probe.end', { started });
process.exit(0);
