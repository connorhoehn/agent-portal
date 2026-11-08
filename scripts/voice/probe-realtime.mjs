#!/usr/bin/env node
// Probe the OpenAI Live (GPT-Live) API for the voice navigator (docs/voice-navigator-spec.md §1, §12 V1).
// Node 22+, built-in WebSocket and fetch, no dependencies.
//
//   node scripts/voice/probe-realtime.mjs <scenario> --wav-dir <dir> --out <file.jsonl>
//
// Scenarios (each is one billed session at most):
//   realtime-handshake  wss://api.openai.com/v1/realtime?model=<LIVE_MODEL>, no audio; records whether the
//                       older Realtime endpoint serves the Live model.
//   live-plain-tools    Live primary WebSocket, session.start with a top-level `tools` array and no delegation.
//   live-responses      Live primary WebSocket, Responses delegation with navigate + search_people functions;
//                       streams three utterances, answers each function call after TOOL_DELAY_MS, then tries
//                       session.thinking.append / instructions.append / commentary.append.
//   live-client         Live primary WebSocket, client delegation; answers session.delegation.created with
//                       session.commentary.append.
//   mint-webrtc         POST /v1/live/sessions with a synthetic SDP offer (what chatgpt-live-voice/server.mjs
//                       does), attaches a sideband, then POST /v1/live/sessions/{id}/hangup with the sideband still
//                       open so session.closed reports the billed seconds. MINT_RESTRICT=1 adds the
//                       session.client.data_channel allowlists P2 should send.
//
// Findings and the shapes P2/P3 build against: docs/voice-navigator-spec.md §1 ("The Live API, as V1 measured it").
//
// The key comes from OPENAI_API_KEY in the environment, else from OPENAI_API_KEY in middleware/.env (gitignored;
// the same file the middleware reads), and is never logged. Every logged object passes through redact():
// Authorization / client_secret / ephemeral* keys and any sk- value are replaced, audio payloads become {bytes}.
// Each line: { t (ms since probe start, monotonic), s (scenario), dir: in|out|http|note, type, ...event }.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

function keyFromMiddlewareEnv() {
  try {
    const f = new URL('../../middleware/.env', import.meta.url);
    const m = readFileSync(f, 'utf8').match(/^OPENAI_API_KEY=(.*)$/m);
    return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
  } catch { return ''; }
}
const KEY = process.env.OPENAI_API_KEY || keyFromMiddlewareEnv();
const MODEL = process.env.LIVE_MODEL || 'gpt-live-1';
const DELEGATION_MODEL = process.env.LIVE_DELEGATION_MODEL || 'gpt-6-luna';
const API = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const WSS = API.replace(/^http/, 'ws');
const TOOL_DELAY_MS = Number(process.env.TOOL_DELAY_MS || 3000);
const HARD_CAP_MS = 55_000; // every session is closed before a minute
const CHUNK_MS = 100; // microphone chunk size; 24 kHz PCM16 mono = 4800 bytes per 100 ms
const RATE = 24000;
const CHUNK_BYTES = (RATE * 2 * CHUNK_MS) / 1000;

const args = process.argv.slice(2);
const scenario = args[0];
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const WAV_DIR = opt('--wav-dir', '');
const OUT = opt('--out', '');
if (!KEY) { console.error('No key: set OPENAI_API_KEY or put it in middleware/.env'); process.exit(1); }
if (!scenario || !OUT) { console.error('usage: probe-realtime.mjs <scenario> --wav-dir <dir> --out <file.jsonl>'); process.exit(1); }

const T0 = performance.now();
const now = () => Math.round(performance.now() - T0);
const KEY_PREFIX = KEY.slice(0, 12);

// ---------- logging with redaction ----------
const SECRET_KEYS = /^(authorization|client_secret|ephemeral.*|api_key|secret|password)$/i;
const AUDIO_KEYS = new Set(['audio', 'delta']);
function redact(v, keyName = '', parentType = '') {
  if (typeof v === 'string') {
    if (SECRET_KEYS.test(keyName)) return '[redacted]';
    if (v.includes(KEY_PREFIX) || /sk-[A-Za-z0-9_-]{8,}/.test(v)) return '[redacted sk-]';
    if (keyName === 'sdp') return { bytes: v.length, m_lines: v.split(/\r?\n/).filter((l) => l.startsWith('m=')) };
    if (AUDIO_KEYS.has(keyName) && /audio/.test(parentType)) return { bytes: Buffer.byteLength(v, 'base64'), rms: rms(v) };
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, keyName, parentType));
  if (v && typeof v === 'object') {
    const out = {};
    const t = typeof v.type === 'string' ? v.type : parentType;
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(x, k, t);
    return out;
  }
  return v;
}
// RMS of a base64 PCM16LE chunk, 0..1; > VOICED counts as speech (output audio streams continuously, silence included).
const VOICED = 0.01;
function rms(b64) {
  const b = Buffer.from(b64, 'base64');
  let sum = 0;
  const n = Math.floor(b.length / 2);
  for (let i = 0; i < n; i++) { const x = b.readInt16LE(i * 2) / 32768; sum += x * x; }
  return n ? Math.round(Math.sqrt(sum / n) * 10000) / 10000 : 0;
}
function log(dir, ev, extra = {}) {
  const line = JSON.stringify({ t: now(), s: scenario, dir, ...extra, ...redact(ev) });
  if (line.includes(KEY_PREFIX)) throw new Error('refusing to log a line containing the key');
  appendFileSync(OUT, line + '\n');
  return line;
}
const note = (type, data = {}) => log('note', { type, ...data });

// ---------- audio ----------
function readWav(file) {
  const b = readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV`);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt or data chunk`);
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) throw new Error(`${file}: need PCM16 mono 24 kHz, got ${JSON.stringify(fmt)}`);
  return data;
}
function utterance(n) {
  const f = path.join(WAV_DIR, `voicenav-probe-u${n}-v1.wav`);
  if (!existsSync(f)) throw new Error(`missing ${f}`);
  return readWav(f);
}
const SILENCE = Buffer.alloc(CHUNK_BYTES);

// ---------- live primary websocket session ----------
class Live {
  constructor(url, headers) {
    this.queue = [];
    this.waiters = [];
    this.lastOutputAt = 0;
    this.lastInputAt = 0;
    this.started = false;
    this.closed = false;
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${KEY}`, ...headers } });
    note('ws.connecting', { url });
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => { note('ws.open'); resolve(); });
      this.ws.addEventListener('error', (e) => { note('ws.error', { message: e?.message || String(e?.error || 'error') }); reject(new Error('ws error')); });
    });
    this.ws.addEventListener('close', (e) => { this.closed = true; note('ws.close', { code: e.code, reason: e.reason }); this.stopMic(); this.wake(); });
    this.ws.addEventListener('message', ({ data }) => {
      let ev;
      try { ev = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { note('ws.raw', { bytes: String(data).length }); return; }
      log('in', ev);
      if (ev.type === 'session.started') this.started = true;
      if (ev.type === 'session.output_transcript.delta' || (ev.type === 'session.output_audio.delta' && rms(ev.delta) > VOICED)) this.lastOutputAt = now();
      if (ev.type === 'session.input_transcript.delta') this.lastInputAt = now();
      this.onEvent?.(ev);
      this.wake(ev);
    });
  }
  send(ev) {
    if (this.ws.readyState !== WebSocket.OPEN) { note('send.dropped', { event_type: ev.type }); return; }
    this.ws.send(JSON.stringify(ev));
    log('out', ev);
  }
  wake(ev) { for (const w of [...this.waiters]) if (!ev || w.pred(ev)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(ev ?? null); } }
  waitFor(pred, ms, label) {
    return new Promise((resolve) => {
      if (this.closed) return resolve(null);
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); note('wait.timeout', { label, ms }); resolve(null); } }, ms);
    });
  }
  // Continuous microphone: utterances when queued, silence otherwise, paced in real time.
  startMic() {
    let next = performance.now();
    const tick = () => {
      if (this.closed) return;
      const chunk = this.queue.length ? this.queue.shift() : SILENCE;
      this.send({ type: 'session.input_audio.append', audio: chunk.toString('base64') });
      next += CHUNK_MS;
      this.mic = setTimeout(tick, Math.max(0, next - performance.now()));
    };
    tick();
  }
  stopMic() { clearTimeout(this.mic); }
  say(pcm, label) {
    note('mic.utterance', { label, ms: Math.round((pcm.length / (RATE * 2)) * 1000) });
    for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
      const c = pcm.subarray(i, i + CHUNK_BYTES);
      this.queue.push(c.length === CHUNK_BYTES ? c : Buffer.concat([c, Buffer.alloc(CHUNK_BYTES - c.length)]));
    }
  }
  async utteranceDone() { while (this.queue.length && !this.closed) await sleep(CHUNK_MS); }
  // Wait until the assistant has been quiet for `quietMs` (bounded by maxMs).
  // Only output after `since` and after the last tool answer counts, so a previous turn's speech never ends the wait.
  async quiet(quietMs, maxMs, label, since = now()) {
    const end = now() + maxMs;
    while (!this.closed && now() < end) {
      const mark = Math.max(since, this.lastAnswerAt || 0);
      if (this.lastOutputAt > mark && now() - this.lastOutputAt >= quietMs && this.pendingCalls() === 0) return true;
      await sleep(100);
    }
    note('quiet.timeout', { label, maxMs });
    return false;
  }
  pendingCalls() { return this.pending ? this.pending.size : 0; }
  async close() {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.stopMic();
    const closedEv = this.waitFor((e) => e.type === 'session.closed', 15_000, 'session.closed');
    this.send({ type: 'session.close' });
    await closedEv;
    try { this.ws.close(1000); } catch {}
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tool catalogue used by the probe ----------
const ROUTES = ['/iq/search', '/iq/local-compute', '/iq/projects', '/access/requests'];
const FUNCTIONS = [
  {
    type: 'function',
    name: 'navigate',
    description: 'Open a portal page in the user\'s browser tab. /iq/search is search, /iq/local-compute is the Computer Lab, /iq/projects is initiatives, /access/requests is access requests.',
    parameters: { type: 'object', properties: { route: { type: 'string', enum: ROUTES } }, required: ['route'], additionalProperties: false },
    strict: true,
  },
  {
    type: 'function',
    name: 'search_people',
    description: 'Search the organisation\'s people directory (skills, experts, owners). Returns the top matches with title and team.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    strict: true,
  },
];
const LIVE_INSTRUCTIONS = 'You are a friendly voice assistant. Keep answers short and conversational. You help the user move around the OrgIQ portal. Delegate to the backend whenever the user asks to open a page, search, or look someone up; the backend can open pages and search people. Never invent results.';
const BACKEND_INSTRUCTIONS = 'You run portal actions for a voice assistant. Use navigate to open pages (search is /iq/search, the computer lab is /iq/local-compute). Use search_people to find people by skill. Call the tool directly without asking follow-up questions, then summarise the result in one short sentence.';

// Fake tool results, clearly marked as probe data.
function runTool(name, argsJson) {
  let a = {};
  try { a = JSON.parse(argsJson || '{}'); } catch {}
  if (name === 'navigate') return { ok: true, route: a.route ?? null, note: 'probe: page opened' };
  if (name === 'search_people') {
    return {
      ok: true, query: a.query ?? null, note: 'probe data, not real people',
      results: [
        { name: 'Priya Natarajan', title: 'Staff platform engineer', team: 'Platform', why: 'Kubernetes operators, most recent activity yesterday' },
        { name: 'Diego Alvarez', title: 'SRE lead', team: 'Reliability', why: 'EKS upgrades last week' },
        { name: 'Mei Chen', title: 'Senior engineer', team: 'Developer experience', why: 'Helm charts and cluster tooling' },
      ],
    };
  }
  return { ok: false, error: `unknown tool ${name}` };
}

// ---------- scenarios ----------
async function realtimeHandshake() {
  const url = `${WSS}/realtime?model=${encodeURIComponent(MODEL)}`;
  const s = new Live(url, {});
  try { await s.opened; } catch { note('result', { realtime_endpoint: 'handshake failed' }); return; }
  const first = await s.waitFor(() => true, 5000, 'first event');
  note('result', { realtime_endpoint: first ? first.type : 'no event in 5 s', code: first?.error?.code ?? null });
  // Never stream audio here; close at once.
  try { s.ws.close(1000); } catch {}
  await sleep(500);
}

async function livePlainTools() {
  const s = new Live(`${WSS}/live/sessions`, {});
  await s.opened;
  s.send({ type: 'session.start', event_id: 'start_plain', session: { model: MODEL, instructions: LIVE_INSTRUCTIONS, audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: 'marin' } }, tools: FUNCTIONS } });
  const ev = await s.waitFor((e) => e.type === 'session.started' || e.type === 'error', 8000, 'start');
  note('result', { plain_tools_shape: ev ? ev.type : 'no answer', code: ev?.error?.code ?? null, message: ev?.error?.message ?? null });
  if (ev?.type === 'session.started') await s.close();
  else { try { s.ws.close(1000); } catch {} await sleep(500); }
}

async function liveResponses() {
  const s = new Live(`${WSS}/live/sessions`, {});
  s.pending = new Map(); // call_id -> { name, arguments, delegation_id, at }
  const callStats = []; // per call: deltas seen between the call and our answer
  let window = null;
  s.onEvent = (ev) => {
    if (window && /output_(audio|transcript)\.delta$/.test(ev.type)) {
      window[ev.type.endsWith('audio.delta') ? 'audio' : 'transcript']++;
      if (ev.type.endsWith('audio.delta') && rms(ev.delta) > VOICED) window.voiced++;
      if (ev.type.endsWith('transcript.delta')) window.text += ev.delta ?? '';
    }
    if (window && !/delta$/.test(ev.type)) window.other.push(ev.type === 'response.event' ? `response.event/${ev.event?.type}` : ev.type);
    if (ev.type === 'response.event' && ev.event?.type === 'response.output_item.done' && ev.event.item?.type === 'function_call') {
      const it = ev.event.item;
      s.pending.set(it.call_id, { name: it.name, arguments: it.arguments, delegation_id: ev.delegation_id, at: now() });
      note('tool.call', { call_id: it.call_id, name: it.name, arguments: it.arguments, delegation_id: ev.delegation_id });
      window = { call_id: it.call_id, name: it.name, from: now(), audio: 0, voiced: 0, transcript: 0, text: '', other: [] };
      setTimeout(() => answer(it.call_id), TOOL_DELAY_MS);
    }
  };
  function answer(callId) {
    const c = s.pending.get(callId);
    if (!c) return;
    if (window && window.call_id === callId) { callStats.push({ ...window, to: now() }); note('tool.window', { ...window, to: now(), ms: now() - window.from }); window = null; }
    s.send({ type: 'response.item.create', event_id: `tool_result_${callId}`, item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(runTool(c.name, c.arguments)) } });
    s.pending.delete(callId);
    s.lastAnswerAt = now();
    const sameDelegation = [...s.pending.values()].some((p) => p.delegation_id === c.delegation_id);
    if (!sameDelegation) s.send({ type: 'response.create', event_id: `continue_${callId}` });
  }

  await s.opened;
  s.send({
    type: 'session.start',
    event_id: 'start_responses',
    session: {
      model: MODEL,
      instructions: LIVE_INSTRUCTIONS,
      audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: 'marin' } },
      delegation: { type: 'responses', responses: { model: DELEGATION_MODEL, instructions: BACKEND_INSTRUCTIONS, tools: FUNCTIONS, tool_choice: 'auto', parallel_tool_calls: false } },
    },
  });
  const started = await s.waitFor((e) => e.type === 'session.started' || e.type === 'error', 10_000, 'session.started');
  if (started?.type !== 'session.started') { note('result', { responses_shape: started?.type ?? 'no answer' }); try { s.ws.close(1000); } catch {} return; }
  const cap = setTimeout(() => { note('hard.cap'); s.close(); }, HARD_CAP_MS);
  s.startMic();
  await sleep(600);
  // Turn 1: small talk that should not need a tool.
  s.say(utterance(1), 'Hey, I want to do search.'); await s.utteranceDone();
  await s.quiet(1200, 8000, 'turn 1');
  // Turn 2: a search, expect search_people (and maybe navigate).
  s.say(utterance(2), 'Find me the latest Kubernetes experts.'); await s.utteranceDone();
  await s.waitFor((e) => e.type === 'response.event' && e.event?.type === 'response.output_item.done' && e.event.item?.type === 'function_call', 10_000, 'turn 2 call');
  await s.quiet(1500, 14_000, 'turn 2');
  // Turn 3: navigation.
  s.say(utterance(3), 'Open the computer lab.'); await s.utteranceDone();
  await s.waitFor((e) => e.type === 'response.event' && e.event?.type === 'response.output_item.done' && e.event.item?.type === 'function_call', 8000, 'turn 3 call');
  await s.quiet(1500, 10_000, 'turn 3');
  // Mid-session context.
  s.send({ type: 'session.thinking.append', event_id: 'think_1', delegation_id: null, content: 'The Computer Lab page is now open in the user\'s tab.' });
  s.send({ type: 'session.instructions.append', event_id: 'instr_1', delegation_id: null, content: 'From now on, end each reply by asking whether the user needs anything else.' });
  s.send({ type: 'session.commentary.append', event_id: 'comm_1', delegation_id: null, content: 'The page finished loading; there are two computers running.' });
  s.send({ type: 'session.thinking.append', event_id: 'think_bad', delegation_id: 'item_probe_not_a_real_delegation', content: 'Probe: non-null delegation id under Responses delegation.' });
  await s.quiet(1200, 7000, 'context appends');
  note('result', { tool_windows: callStats.map(({ call_id, name, audio, voiced, transcript, text, other, from, to }) => ({ call_id, name, ms: to - from, audio_chunks: audio, voiced_chunks: voiced, transcript_deltas: transcript, text, other })) });
  clearTimeout(cap);
  await s.close();
}

async function liveClient() {
  const s = new Live(`${WSS}/live/sessions`, {});
  s.pending = new Map(); // open client delegations
  let delegations = 0;
  let win = null;
  const windows = [];
  const CLIENT_DELAY_MS = Number(process.env.CLIENT_DELAY_MS || 5000);
  s.onEvent = (ev) => {
    if (win && ev.type === 'session.output_audio.delta') { win.audio++; if (rms(ev.delta) > VOICED) win.voiced++; }
    if (win && ev.type === 'session.output_transcript.delta') win.text += ev.delta ?? '';
    if (ev.type === 'session.delegation.created' && ev.delegation?.target === 'client') {
      delegations++;
      const id = ev.delegation.id;
      win = { delegation_id: id, from: now(), audio: 0, voiced: 0, text: '' };
      s.pending.set(id, now());
      setTimeout(() => {
        if (win) { windows.push({ ...win, ms: now() - win.from }); note('delegation.window', { ...win, ms: now() - win.from }); win = null; }
        s.pending.delete(id);
        s.lastAnswerAt = now();
        s.send({ type: 'session.commentary.append', event_id: `client_result_${delegations}`, delegation_id: id, content: delegations === 1 ? 'Done: the Computer Lab is open. Two computers are running. Ask whether to start another one.' : 'Done: started a computer for the Alpha initiative.' });
      }, CLIENT_DELAY_MS);
    }
  };
  await s.opened;
  s.send({ type: 'session.start', event_id: 'start_client', session: { model: MODEL, instructions: LIVE_INSTRUCTIONS.replace('the backend can open pages and search people', 'the application can open pages, search people and start computers'), audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: 'marin' } }, delegation: { type: 'client' } } });
  const started = await s.waitFor((e) => e.type === 'session.started' || e.type === 'error', 10_000, 'session.started');
  if (started?.type !== 'session.started') { note('result', { client_shape: started?.type ?? 'no answer' }); try { s.ws.close(1000); } catch {} return; }
  const cap = setTimeout(() => { note('hard.cap'); s.close(); }, 40_000);
  s.startMic();
  await sleep(600);
  s.say(utterance(3), 'Open the computer lab.'); await s.utteranceDone();
  await s.waitFor((e) => e.type === 'session.delegation.created', 8000, 'delegation');
  await s.quiet(1500, 10_000, 'client turn 1');
  s.say(utterance(4), 'Yes.'); await s.utteranceDone();
  await s.quiet(1500, 8000, 'client turn 2');
  note('result', { client_delegations: delegations, windows });
  clearTimeout(cap);
  await s.close();
}

function syntheticOffer() {
  const ufrag = randomBytes(3).toString('hex');
  const pwd = randomBytes(12).toString('hex');
  const fp = [...randomBytes(32)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const media = (mid) => [`a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, 'a=ice-options:trickle', `a=fingerprint:sha-256 ${fp}`, 'a=setup:actpass', `a=mid:${mid}`];
  return [
    'v=0', `o=- ${BigInt('0x' + randomBytes(7).toString('hex'))} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0 1', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS probe',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 0.0.0.0', ...media(0), 'a=sendrecv', 'a=msid:probe mic', 'a=rtcp-mux', 'a=rtpmap:111 opus/48000/2', 'a=rtcp-fb:111 transport-cc', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=ssrc:1001 cname:probe',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', ...media(1), 'a=sctp-port:5000', 'a=max-message-size:262144', '',
  ].join('\r\n');
}

async function mintWebrtc() {
  // Exactly the body chatgpt-live-voice/server.mjs sends, plus the delegation it adds when LIVE_DELEGATION_MODEL is set.
  const body = {
    session: {
      model: MODEL,
      instructions: LIVE_INSTRUCTIONS,
      audio: { output: { voice: 'marin' } },
      delegation: { type: 'responses', responses: { model: DELEGATION_MODEL, tools: FUNCTIONS, tool_choice: 'auto' } },
    },
    transport: { type: 'webrtc', sdp: syntheticOffer() },
  };
  if (process.env.MINT_RESTRICT === '1') {
    // What P2 should send: the browser may answer tools, mute and hang up, but not session.update (which could swap
    // the backend model or tool list) or session.instructions.append.
    body.session.client = {
      data_channel: {
        allowed_client_events: ['session.close', 'session.input_audio.mute', 'session.input_audio.unmute', 'response.item.create', 'response.create', 'session.thinking.append', 'session.commentary.append'],
        allowed_server_events: [
          ...['session.started', 'session.closed', 'session.usage.updated', 'session.input_transcript.delta', 'session.output_transcript.delta', 'session.delegation.created', 'session.input_audio.muted', 'session.input_audio.unmuted', 'session.thinking.appended', 'session.commentary.appended', 'error', 'info'].map((type) => ({ type })),
          ...['response.created', 'response.output_item.done', 'response.completed', 'response.failed'].map((response_event) => ({ type: 'response.event', response_event })),
        ],
      },
    };
  }
  log('http', { type: 'request', method: 'POST', path: '/live/sessions', body });
  const r = await fetch(`${API}/live/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 500) }; }
  const headers = Object.fromEntries([...r.headers].filter(([k]) => /^(content-type|openai-|x-request-id|location)/i.test(k)));
  log('http', { type: 'response', status: r.status, headers, body: j });
  const id = j?.session?.id;
  if (!id) return;
  // A sideband can attach by session id; see what it says before the media ever connects.
  // Keep it open across the hangup to see session.closed (reason, usage) for a session whose media never connected.
  const sb = new Live(`${WSS}/live/sessions/${encodeURIComponent(id)}/attach`, {});
  try { await sb.opened; await sb.waitFor(() => false, 2500, 'sideband events'); } catch {}
  const closedEv = sb.waitFor((e) => e.type === 'session.closed', 6000, 'sideband session.closed');
  const h = await fetch(`${API}/live/sessions/${encodeURIComponent(id)}/hangup`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` } });
  const ht = await h.text();
  let hj; try { hj = JSON.parse(ht || '{}'); } catch { hj = { raw: ht.slice(0, 500) }; }
  log('http', { type: 'hangup', status: h.status, body: hj });
  await closedEv;
  try { sb.ws.close(1000); } catch {}
  await sleep(300);
}

const SCENARIOS = { 'realtime-handshake': realtimeHandshake, 'live-plain-tools': livePlainTools, 'live-responses': liveResponses, 'live-client': liveClient, 'mint-webrtc': mintWebrtc };
if (!SCENARIOS[scenario]) { console.error(`unknown scenario ${scenario}; one of ${Object.keys(SCENARIOS).join(', ')}`); process.exit(1); }
note('probe.start', { model: MODEL, delegation_model: DELEGATION_MODEL, node: process.version });
const killer = setTimeout(() => { note('probe.killed', { after_ms: 70_000 }); process.exit(2); }, 70_000);
try { await SCENARIOS[scenario](); } catch (e) { note('probe.error', { message: e.message }); process.exitCode = 1; }
clearTimeout(killer);
note('probe.end');
process.exit(process.exitCode ?? 0);
