#!/usr/bin/env node
// Probe which voices the OpenAI Live API (gpt-live-1) offers the voice navigator, and what a style instruction does
// (docs/voice-navigator-spec.md §1, "Voices (verified 8 November 2026)"). Node 22+, no dependencies.
//
//   node scripts/voice/probe-voices.mjs http   --out <file.jsonl>
//       Free: GET the candidate voice-listing paths, then validate every voice name with session.start on the primary
//       WebSocket and a made-up model (see validateName: the voice is checked before the model, so nothing starts).
//       --names a,b,voice_x limits the list; voice_… ids are sent as { id }.
//   node scripts/voice/probe-voices.mjs design --out <file.jsonl> --name <n> --prompt <voice description>
//       Free: POST /v1/audio/voices { type: 'prompt', name, prompt, model: 'auto' } (prompt-to-voice). Text only;
//       never pass a real person's audio or name.
//   node scripts/voice/probe-voices.mjs say    --out <file.jsonl> --voice <name|voice_id> --style none|northlondon|rp
//       --wav <utterance.wav> --save <reply.wav> [--label <s>] [--voice-desc <text>]
//       One billed session over the primary WebSocket: client delegation, the same base instructions plus the style
//       line, speaks the utterance once, waits for the reply to finish, closes. The reply's output-audio frames
//       (PCM16 24 kHz mono) are written to --save, trimmed to the voiced span with 300 ms of margin.
//
// The key comes from OPENAI_API_KEY, else middleware/.env, and is never logged: every line passes the same redaction
// as probe-realtime.mjs (Authorization / client_secret / ephemeral* keys and any sk- value replaced, audio payloads
// become { bytes, rms }), and a line containing the key's prefix throws instead of being written.
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

function keyFromMiddlewareEnv() {
  try {
    const m = readFileSync(new URL('../../middleware/.env', import.meta.url), 'utf8').match(/^OPENAI_API_KEY=(.*)$/m);
    return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : '';
  } catch { return ''; }
}
const KEY = process.env.OPENAI_API_KEY || keyFromMiddlewareEnv();
const MODEL = process.env.LIVE_MODEL || 'gpt-live-1';
const API = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const WSS = API.replace(/^http/, 'ws');
const RATE = 24000, CHUNK_MS = 100, CHUNK_BYTES = (RATE * 2 * CHUNK_MS) / 1000;
const HARD_CAP_MS = 35_000;

const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt('--out', '');
if (!KEY) { console.error('No key: set OPENAI_API_KEY or put it in middleware/.env'); process.exit(1); }
if (!mode || !OUT) { console.error('usage: probe-voices.mjs http|design|say --out <file.jsonl> ...'); process.exit(1); }
const STYLE = opt('--style', 'none');
const VOICE = opt('--voice', 'marin');
const LABEL = opt('--label', mode === 'say' ? `voices-${VOICE.startsWith('voice_') ? 'designed' : VOICE}-${STYLE}` : `voices-${mode}`);

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
    if (k === 'sdp') return { bytes: v.length };
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
const auth = { Authorization: `Bearer ${KEY}` };
async function http(method, p, body) {
  const r = await fetch(`${API}${p}`, { method, headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 300) }; }
  return { status: r.status, body: j };
}

// ---------- http: listings and free name validation ----------
// The 31 names in the Live reference's audio.output.voice enum (developers.openai.com/api/reference/resources/live,
// read 8 November 2026), plus Realtime/TTS names that are not in it and one made-up name.
const LIVE_ENUM = ['alloy', 'ash', 'ballad', 'beacon', 'bossa', 'brise', 'cedar', 'cinder', 'coral', 'delta', 'echo', 'flitz', 'gleam', 'harema', 'juni', 'marin', 'meridian', 'nira', 'noeul', 'nuri', 'quartz', 'ripple', 'sage', 'shida', 'shimmer', 'sillage', 'stone', 'tempo', 'verse', 'vesper', 'willow'];
const NOT_IN_ENUM = ['fable', 'onyx', 'nova', 'zzprobe', 'Marin', 'voice_00000000000000000000000000000000'];
// Free name check over the primary WebSocket (measured 8 November 2026): session.start validates the schema, then the
// voice, then the model. An unknown voice is refused with error { code: 'forbidden', message: 'Voice session access
// denied.' } whatever the model; a voice that passes moves on to the model, and the made-up model VALIDATE_MODEL is
// refused with code 'invalid_model' before anything starts. So 'invalid_model' = the voice was accepted, nothing billed.
// (A bad delegation model is NOT checked at start: that session starts and bills; never use it as the trap.)
const VALIDATE_MODEL = 'gpt-live-zz-voice-probe';
async function validateName(voice) {
  const voiceField = voice.startsWith('voice_') ? { id: voice } : voice;
  const ws = new WebSocket(`${WSS}/live/sessions`, { headers: auth });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
  const ev = await new Promise((resolve) => {
    ws.addEventListener('message', ({ data }) => resolve(JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))));
    ws.send(JSON.stringify({ type: 'session.start', event_id: `validate_${voice}`, session: { model: VALIDATE_MODEL, instructions: 'probe', audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: voiceField } } } }));
    setTimeout(() => resolve({ type: 'timeout' }), 8000);
  });
  if (ev.type === 'session.started') { ws.send(JSON.stringify({ type: 'session.close' })); await sleep(1500); note('unexpected.started', { voice }); }
  try { ws.close(1000); } catch {}
  const code = ev.error?.code ?? null;
  const verdict = code === 'invalid_model' ? 'accepted' : code === 'forbidden' || ev.error?.param === 'session.audio.output.voice' ? 'refused' : `unclear:${ev.type}:${code}`;
  log('in', { type: 'voice.validate', voice, voice_field: voiceField, verdict, answer: ev });
  return verdict;
}
async function startOnce(label, session) {
  const ws = new WebSocket(`${WSS}/live/sessions`, { headers: auth });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
  const ev = await new Promise((resolve) => {
    ws.addEventListener('message', ({ data }) => resolve(JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))));
    ws.send(JSON.stringify({ type: 'session.start', event_id: `param_${label}`, session }));
    setTimeout(() => resolve({ type: 'timeout' }), 8000);
  });
  if (ev.type === 'session.started') { ws.send(JSON.stringify({ type: 'session.close' })); await sleep(1500); }
  try { ws.close(1000); } catch {}
  log('in', { type: 'param.check', label, answer: ev });
  return ev.error?.code || ev.type;
}
async function httpMode() {
  const saved = []; // the organisation's saved custom voices, from GET /audio/voices
  for (const p of ['/live/voices', '/audio/voices', '/voices', '/audio/voices?limit=5', '/audio/consent_phrases', '/audio/voice_consents']) {
    const r = await http('GET', p);
    log('http', { type: 'get', path: p, status: r.status, body: r.body });
    if (p === '/audio/voices' && Array.isArray(r.body?.data)) saved.push(...r.body.data.map((v) => v.id));
  }
  const results = {};
  const names = opt('--names', '') ? opt('--names').split(',') : [...LIVE_ENUM, ...NOT_IN_ENUM, ...saved];
  for (const v of names) results[v] = await validateName(v);
  note('result', { voices: results });
  // Rate controls: the reference documents none; check that the obvious names are refused (schema stage, free).
  const trap = (session) => ({ model: VALIDATE_MODEL, instructions: 'probe', audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: 'marin' } }, ...session });
  for (const [label, session] of [
    ['audio.output.speed', trap({ audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: 'marin', speed: 1.2 } } })],
    ['session.speed', trap({ speed: 1.2 })],
  ]) results[label] = await startOnce(label, session);
  console.log(JSON.stringify(results, null, 1));
}

// ---------- design: prompt-to-voice ----------
async function designMode() {
  const body = { type: 'prompt', name: opt('--name', 'probe voice'), prompt: opt('--prompt', ''), model: 'auto' };
  if (!body.prompt) { console.error('--prompt is required'); process.exit(1); }
  log('http', { type: 'request', method: 'POST', path: '/audio/voices', body });
  const r = await http('POST', '/audio/voices', body);
  log('http', { type: 'response', status: r.status, body: r.body });
  console.log(JSON.stringify({ status: r.status, id: r.body?.id ?? null, error: r.body?.error?.message ?? null }));
}

// ---------- say: one session, one spoken reply ----------
const BASE_INSTRUCTIONS = 'You are the voice assistant for the OrgIQ portal. You never delegate and never wait for anyone: answer the user yourself, straight away. When the user speaks, greet them, tell them in two or three short sentences what you can help with (finding people and experts, opening pages, starting computers in the Computer Lab), then ask what they would like to search for.';
const STYLES = {
  none: '',
  northlondon: 'Speak with a young north London accent, Highgate register, relaxed Gen Z phrasing, short sentences.',
  rp: 'Speak in Received Pronunciation.',
};
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
function wavFile(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function sayMode() {
  if (!(STYLE in STYLES)) { console.error(`--style one of ${Object.keys(STYLES).join(', ')}`); process.exit(1); }
  const wav = opt('--wav', ''), save = opt('--save', '');
  if (!wav || !save) { console.error('--wav and --save are required'); process.exit(1); }
  const utter = readWav(wav);
  const voiceField = VOICE.startsWith('voice_') ? { id: VOICE } : VOICE;
  const instructions = [BASE_INSTRUCTIONS, opt('--voice-desc', ''), STYLES[STYLE]].filter(Boolean).join(' ');
  const frames = []; // { pcm, voiced }
  let transcript = '', inputTranscript = '', closed = false, lastVoicedAt = 0, lastTranscriptAt = 0, started = null, final = null;
  const ws = new WebSocket(`${WSS}/live/sessions`, { headers: auth });
  const waiters = [];
  const wake = (ev) => { for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); } };
  const waitFor = (pred, ms) => new Promise((resolve) => { const w = { pred, resolve }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms); });
  const send = (ev) => { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(ev)); log('out', ev); } };
  ws.addEventListener('message', ({ data }) => {
    const ev = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    log('in', ev);
    if (ev.type === 'session.started') started = ev;
    if (ev.type === 'session.output_audio.delta') { const pcm = Buffer.from(ev.delta, 'base64'); const voiced = rms(ev.delta) > 0.01; frames.push({ pcm, voiced }); if (voiced) lastVoicedAt = now(); }
    if (ev.type === 'session.output_transcript.delta') { transcript += ev.delta ?? ''; lastTranscriptAt = now(); }
    if (ev.type === 'session.input_transcript.delta') inputTranscript += ev.delta ?? '';
    if (ev.type === 'session.closed') final = ev;
    // Client delegation is the default when delegation is omitted; answer one if the voice opens it anyway.
    if (ev.type === 'session.delegation.created') send({ type: 'session.commentary.append', event_id: 'probe_no_delegation', delegation_id: ev.delegation?.id, content: 'There is nothing to look up; answer the user yourself.' });
    wake(ev);
  });
  ws.addEventListener('close', (e) => { closed = true; note('ws.close', { code: e.code }); wake({ type: '__closed' }); });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws error'))); });
  send({ type: 'session.start', event_id: 'start_voices', session: { model: MODEL, instructions, audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: voiceField } } } });
  const st = await waitFor((e) => e.type === 'session.started' || e.type === 'error' || e.type === '__closed', 10_000);
  if (st?.type !== 'session.started') { note('result', { started: false, answer: st?.type ?? 'none', error: st?.error ?? null }); try { ws.close(1000); } catch {} return; }
  note('session.config', { voice: started.session?.audio?.output?.voice ?? null, instructions_chars: instructions.length, style: STYLE });
  // Microphone: 600 ms silence, the utterance, then silence until the reply is over.
  const queue = [];
  for (let i = 0; i < 6; i++) queue.push(Buffer.alloc(CHUNK_BYTES));
  for (let i = 0; i < utter.length; i += CHUNK_BYTES) { const c = utter.subarray(i, i + CHUNK_BYTES); queue.push(c.length === CHUNK_BYTES ? c : Buffer.concat([c, Buffer.alloc(CHUNK_BYTES - c.length)])); }
  const utterEnd = queue.length * CHUNK_MS;
  let next = performance.now(), mic;
  const tick = () => { if (closed) return; send({ type: 'session.input_audio.append', audio: (queue.shift() ?? Buffer.alloc(CHUNK_BYTES)).toString('base64') }); next += CHUNK_MS; mic = setTimeout(tick, Math.max(0, next - performance.now())); };
  const micStart = now();
  tick();
  const cap = now() + HARD_CAP_MS;
  // Done when the reply has started and both voiced audio and transcript have been quiet for 2 s.
  while (!closed && now() < cap) {
    await sleep(100);
    const lastOut = Math.max(lastVoicedAt, lastTranscriptAt);
    if (now() > micStart + utterEnd && lastOut > micStart + utterEnd - 500 && now() - lastOut > 2000) break;
  }
  clearTimeout(mic);
  const closedEv = waitFor((e) => e.type === 'session.closed' || e.type === '__closed', 10_000);
  send({ type: 'session.close', event_id: 'close_voices' });
  await closedEv;
  try { ws.close(1000); } catch {}
  // Trim the reply audio to the voiced span (+300 ms) and save it.
  const first = frames.findIndex((f) => f.voiced), last = frames.length - 1 - [...frames].reverse().findIndex((f) => f.voiced);
  const span = first >= 0 ? frames.slice(Math.max(0, first - 3), Math.min(frames.length, last + 4)) : [];
  const pcm = Buffer.concat(span.map((f) => f.pcm));
  mkdirSync(path.dirname(save), { recursive: true });
  writeFileSync(save, wavFile(pcm));
  const result = { voice: VOICE, style: STYLE, input_transcript: inputTranscript, output_transcript: transcript, reply_audio_s: Math.round((pcm.length / (RATE * 2)) * 10) / 10, output_frames: frames.length, voiced_frames: frames.filter((f) => f.voiced).length, saved: path.basename(save), closed_reason: final?.reason ?? null, billed_seconds: final?.usage?.seconds ?? null };
  note('result', result);
  console.log(JSON.stringify(result));
}

const MODES = { http: httpMode, design: designMode, say: sayMode };
if (!MODES[mode]) { console.error(`unknown mode ${mode}`); process.exit(1); }
note('probe.start', { mode, model: MODEL, node: process.version });
const killer = setTimeout(() => { note('probe.killed', { after_ms: 90_000 }); process.exit(2); }, 90_000);
try { await MODES[mode](); } catch (e) { note('probe.error', { message: e.message }); console.error(e.message); process.exitCode = 1; }
clearTimeout(killer);
note('probe.end');
process.exit(process.exitCode ?? 0);
