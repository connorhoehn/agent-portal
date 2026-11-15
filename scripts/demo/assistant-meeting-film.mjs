#!/usr/bin/env node
// "Nova in the meeting": a demo film of the meeting assistant inside a call, recorded headless on the default mock world and
// edited with ffmpeg. One command records and composes:
//
//   node scripts/demo/nova-meeting-film.mjs --out <dir>
//
// It starts its own mock middleware (:3945) and portal (:5145), refuses ports already in use, signs three fictional people
// into one call on the Observability Platform initiative (the media server is stubbed exactly as
// scripts/journeys/meeting-assistant.mjs does, or, with --real-call, the call joins the local social profile's platform-api
// and media server and each camera is the person's portrait, as in --live below), records each person's browser at 1440x900
// with Playwright, and drives thirteen scenes at a brisk pace (waits where nothing changes play faster in the film). Every
// spoken line is synthesised with the provider's text-to-speech (one voice per person, one for Nova; the key from
// middleware/.env, each line cached in <dir>/tts-cache) before it is "heard": the line is handed to the mock transcript
// injector when the speech ends. It writes
// <dir>/timeline.json (scenes, shots, which views, speech and click times, each in wall-clock ms and in ms on each
// person's video), stops what it started, then runs scripts/demo/nova-film-compose.py to cut, caption and mix
// <dir>/nova-in-the-meeting.mp4. Nothing is injected into the product pages: captions, labels and click rings exist
// only in the edited video.
//
// Options: --record-only (no compose), --compose-only (reuse <dir>/timeline.json), --check (one frame per scene in <dir>/check), --max-minutes <n> (Nova's ceiling, so
// the "min left" mark shows by scene 11; default 14.5), --real-call (needs FILM_SOCIAL_SETTINGS, below). Env: FILM_OUT may stand in
// for --out; FILM_ENV_IS_COPY=1 says middleware/.env is a copy made for the run, removed once it has been read.
//
// What the mock world cannot say for itself: the scripted stand-in for the live model answers only fixed phrases
// (middleware/src/lib/meeting-assistant/scripted-session.ts). So the one spoken question with a free answer (scene 4)
// ends with the name ("..., Nova?"), which the detector treats as addressed with the request still to come; nothing
// follows, so the stand-in answers nothing, and the story's answer is posted through the mock-only assistant-message
// route, the same posting function the live session uses. Everything else is the product's own path: the budget read,
// the action cards, the named write, the decision watcher, voice, pause, extend, dismiss, minutes and delete.
//
// --live records a real call instead (it costs money: Nova is the provider's live model). The call joins the platform-api and
// media server of the local `social` compose profile; each person is a separate Chromium whose fake camera is their portrait
// (a still y4m) and whose fake microphone is a WAV of their lines, laid out on one schedule from the moment the three
// microphones are switched on together. Nova hears the call through the media server's taps; the people say the lines on
// time and the script waits for what Nova does. The decision check alone stays scripted (film-scripted-decisions.mjs, a
// preload of the film's own middleware). Nova's voice frames are kept from Vera's call socket with their arrival times, and
// the compose step places them. Work files go to <dir>/live; the film is <dir>/nova-in-the-meeting-live.mp4. --until <n>
// stops after scene n (a short check). It needs, in the environment: FILM_SOCIAL_SETTINGS (the social profile's
// .scratch/social-documents/settings.json), FILM_MEDIA_ADMIN_TOKEN and FILM_SINK_SECRET (the media node's ADMIN_TOKEN and
// LIVE_CAPTIONS_SHARED_SECRET), the provider key in middleware/.env, and optionally FILM_MEDIA_URL (http://127.0.0.1:3901),
// FILM_SINK_BASE_URL (http://127.0.0.1:3945, the origin the media node's LIVE_CAPTIONS_ORIGIN names), FILM_PLATFORM_PORT
// (23001), FILM_GATEWAY_PORT (28080), FILM_VIDEO_PUBLIC_URL (http://localhost:3901), FILM_DEADMAN_MS (20 minutes).
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag('--out') ?? process.env.FILM_OUT;
if (!OUT) { console.error('usage: nova-meeting-film.mjs --out <dir> [--live [--until <n>]] [--record-only | --compose-only] [--max-minutes <n>]'); process.exit(2); }
const LIVE = args.includes('--live');
/** The call joins the local social profile's platform-api and media server (portraits as cameras) instead of a stub: --live, or --real-call with the scripted Nova. */
const REAL_CALL = LIVE || args.includes('--real-call');
const UNTIL = Number(flag('--until') ?? 99);
/** Where this mode's work files go (the scripted film keeps its own in <dir>). */
const DIR = LIVE ? path.join(OUT, 'live') : OUT;
const FINAL = path.join(OUT, LIVE ? 'nova-in-the-meeting-live.mp4' : 'nova-in-the-meeting.mp4');
fs.mkdirSync(DIR, { recursive: true });
const COMPOSE = path.join(ROOT, 'scripts', 'demo', 'nova-film-compose.py');

function compose() {
  const r = spawn('python3', [COMPOSE, '--out', DIR, '--final', FINAL, ...(args.includes('--check') ? ['--check'] : [])], { stdio: 'inherit' });
  return new Promise((resolve) => r.on('exit', (c) => resolve(c ?? 1)));
}
if (args.includes('--compose-only')) process.exit(await compose());

const MW_PORT = 3945;
const PORTAL_PORT = 5145;
const PORTAL = `http://localhost:${PORTAL_PORT}`;
const MIDDLEWARE = `http://127.0.0.1:${MW_PORT}`;
// Live: about the take's listening plus two minutes (the server's own ceiling on what Nova can cost).
const MAX_MINUTES = Number(flag('--max-minutes') ?? (LIVE ? 8 : 14.5));
const INITIATIVE = '/iq/projects/p-observability';
const PRE_JOIN_KEY = 'orgiq.call-prejoin.v1';
const STAND_IN_SFU = 'http://meeting-assistant.test';

// ── The cast: fictional people of the mock world, each with a voice (and, live, the portrait the mock world gives them) ──
const CAST = {
  vera: { userId: 'u-vera', role: 'org-leader', name: 'Vera Green', label: 'Vera Green · org leader', voice: 'Samantha', personId: 'p-002' },
  nora: { userId: 'u-nora', role: 'sme', name: 'Nora DaSilva', label: 'Nora DaSilva · initiative owner', voice: 'Karen', personId: 'p-004' },
  eli: { userId: 'u-eli', role: 'sme', name: 'Eli Garcia', label: 'Eli Garcia · subject expert', voice: 'Daniel', personId: 'p-011' },
  layla: { userId: 'u-layla', role: 'sme', name: 'Layla Hassan', label: 'Layla Hassan · not in the call', voice: 'Tessa' },
  nova: { name: 'Nova', voice: 'Moira' },
};

// ── The story's words. The first line each person says becomes their sentence in the minutes' summary, so those come
// first and carry the topic. No "agreed", "let's go with", "I'll take" or "can you own" outside scenes 8 and 9 (the decision
// watcher's trigger), and "I'll" only where an action item is meant. ──
const SAY = {
  greet: ['vera', 'Thanks, both of you. I am bringing Nova in, so we get minutes out of this.'],
  s3a: ['vera', 'The ingest launch is on the twenty-first, and on-call is drowning in alerts.'],
  s3b: ['nora', 'Most of last week\'s pages came from two checks: disk space and deploy latency.'],
  s3c: ['eli', 'The deploy latency alert fires on every rollout, so people have learned to ignore it.'],
  s3d: ['vera', 'That is what worries me. A real page could get lost in that noise.'],
  s4q: ['vera', 'Before we change anything, how many of last week\'s pages were noise, Nova?'],
  s4r: ['nora', 'Two thirds. That matches what the night shift told me.'],
  s5q: ['nora', 'Nova, how much budget do I have left?'],
  s5r: ['nora', 'Good, there is room for the extra dashboards.'],
  s6q: ['vera', 'Nova, create a work item for raising the deploy latency alert threshold to five minutes.'],
  s7q: ['vera', 'Nova, create a work item for rewriting the paging runbook and assign it to Nora.'],
  s7r: ['nora', 'Happy to own that one.'],
  s8a: ['nora', 'Let\'s go with paging only on customer facing alerts until the launch.'],
  s8b: ['eli', 'Agreed. Everything else can wait for the morning review.'],
  s9a: ['vera', 'And let\'s go with muting the disk space alerts for all of launch week.'],
  s9b: ['nora', 'Sounds good to me.'],
  s9c: ['eli', 'I have to object to that one.'],
  s10q: ['vera', 'Nova, create a work item for a launch week on-call rota.'],
  s11a: ['eli', 'While it is paused: the vendor quote came in high, and I would rather keep that out of the minutes.'],
  s11b: ['eli', 'I\'ll draft the new paging thresholds by Thursday.'],
  s12a: ['vera', 'That is everything. Thanks, Nova.'],
};
const ANSWER_4 = 'Last week on-call got 64 pages. 41 of them were disk space or deploy latency alerts that cleared on their own within ten minutes.';
const OBJECTION_9 = 'Disk alerts caught the March outage. Mute them for a day, not a week.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class FilmFailure extends Error {}
const must = (cond, msg) => { if (!cond) throw new FilmFailure(msg); };

// ── The live take's words, on one schedule from the moment the three microphones open. Each line is [who, text, when], where
// `when` is the silence before it after the previous line ends, or [line id, seconds] after that line ends. The gaps leave Nova
// time to answer and the script time to click; the people never wait for Nova, so the gaps are generous and the edit cuts them.
// The scene 4 question is one the mock world can answer; the reactions fit any answer. No trigger words outside scenes 9 and 11. ──
const LIVE_SAY = {
  greet: ['vera', 'Thanks, both of you. I am bringing Nova in, so we get minutes out of this.', 3],
  s3a: ['vera', 'The ingest launch is on the twenty-first, and on-call is drowning in alerts.', 34],
  s3b: ['nora', 'Most of last week\'s pages came from two checks: disk space and deploy latency.', 1.6],
  s3c: ['eli', 'The deploy latency alert fires on every rollout, so people have learned to ignore it.', 1.6],
  s3d: ['vera', 'That is what worries me. A real page could get lost in that noise.', 1.6],
  s4q: ['vera', 'Nova, what is the status of the Observability Platform initiative?', 3],
  s4r: ['nora', 'Thanks, that helps.', 24],
  s5q: ['nora', 'Nova, how much budget do I have left this month?', 3],
  s5r: ['nora', 'Good to know.', 18],
  s6q: ['vera', 'Nova, create a work item for raising the deploy latency alert threshold to five minutes.', 4],
  s7q: ['vera', 'Nova, create a work item for rewriting the paging runbook and assign it to Nora.', 24],
  s7r: ['nora', 'Happy to own that one.', 14],
  s8a: ['nora', 'Let\'s go with paging only on customer facing alerts until the launch.', 20],
  s8b: ['eli', 'Agreed. Everything else can wait for the morning review.', 1.6],
  // Paused from here until s10b: the watcher posts at most one proposal in two minutes, so the pause covers that wait.
  s10a: ['eli', 'While it is paused: the vendor quote came in high, and I would rather keep that out of the minutes.', ['s8b', 70]],
  s10b: ['eli', 'I\'ll draft the new paging thresholds by Thursday.', ['s8b', 140]],
  s9a: ['vera', 'And let\'s go with muting the disk space alerts for all of launch week.', 4],
  s9b: ['nora', 'Sounds good to me.', 1.6],
  s9c: ['eli', 'I have to object to that one.', 16],
  s12a: ['vera', 'That is everything. Thanks, Nova.', 28],
};

// ── Speech: every line synthesised once, before the recording starts, so its length paces the scene. The voices are the
// provider's text-to-speech (one voice per person, and one for the scripted Nova); the key is read from middleware/.env and never
// printed. Each line is kept in <out>/tts-cache by a hash of its voice and words, so a retake costs nothing; the cost of new lines
// (an estimate from the audio's length) is added to <out>/tts-cache/cost.json. Every clip is 48 kHz mono PCM WAV with its
// leading and trailing silence trimmed, so it can be laid into a microphone file and the lines follow each other briskly. ──
const TTS_VOICE = { vera: 'shimmer', nora: 'coral', eli: 'ash', layla: 'ballad', nova: 'sage' };
const TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1-hd'];
const TTS_STYLE = 'Speak naturally and briskly, like a colleague in a work meeting: conversational, clear, not theatrical.';
const TTS_CACHE = path.join(OUT, 'tts-cache');
const AUDIO = path.join(DIR, 'audio');
fs.mkdirSync(AUDIO, { recursive: true });
fs.mkdirSync(TTS_CACHE, { recursive: true });
let ttsKey;
function providerKey() {
  if (ttsKey !== undefined) return ttsKey;
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, 'middleware', '.env'), 'utf8'); } catch { /* none */ }
  const m = /^OPENAI_API_KEY=(.*)$/m.exec(text);
  ttsKey = m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null;
  return ttsKey;
}
const ttsCost = { file: path.join(TTS_CACHE, 'cost.json'), usd: 0, lines: 0 };
try { Object.assign(ttsCost, JSON.parse(fs.readFileSync(ttsCost.file, 'utf8')), { file: ttsCost.file }); } catch { /* first run */ }
async function speechFile(who, text) {
  const voice = TTS_VOICE[who];
  const cached = path.join(TTS_CACHE, `${createHash('sha256').update(`${voice}\n${text}`).digest('hex').slice(0, 24)}.wav`);
  if (fs.existsSync(cached)) return cached;
  const key = providerKey();
  if (!key) { console.error('film: the speech voices need OPENAI_API_KEY in middleware/.env (copy it for the run)'); process.exit(2); }
  for (const model of TTS_MODELS) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, voice, input: text, response_format: 'wav', ...(model.startsWith('gpt-') ? { instructions: TTS_STYLE } : {}) }),
    });
    if (!res.ok) { console.log(`  speech: ${model} answered ${res.status}${model === TTS_MODELS.at(-1) ? '' : '; trying the next model'}`); continue; }
    const raw = `${cached}.raw.wav`;
    fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-af',
      'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse',
      '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', cached]);
    fs.rmSync(raw, { force: true });
    const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', cached]).toString().trim());
    // gpt-4o-mini-tts: about $0.015 a minute of speech; tts-1-hd: $30 per million characters.
    ttsCost.usd += model.startsWith('gpt-') ? (secs / 60) * 0.015 : (text.length / 1e6) * 30;
    ttsCost.lines += 1;
    fs.writeFileSync(ttsCost.file, JSON.stringify({ usd: Number(ttsCost.usd.toFixed(4)), lines: ttsCost.lines }));
    return cached;
  }
  console.error('film: the speech provider refused every model; nothing was recorded');
  process.exit(2);
}
let clipNo = 0;
/** One spoken clip, copied out of the cache into this take's audio folder. */
async function synth(who, text) {
  clipNo += 1;
  const file = path.join(AUDIO, `${String(clipNo).padStart(3, '0')}-${who}.wav`);
  fs.copyFileSync(await speechFile(who, text), file);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
  return { file: path.relative(DIR, file), durMs: Math.round(dur * 1000) };
}
const CLIPS = {};
if (!LIVE) for (const [id, [who, text]] of Object.entries(SAY)) CLIPS[id] = { who, text, ...await synth(who, text) };

// ── Live: each line's place on the schedule, each person's microphone file (their lines with silence between, then a long
// silence, as Chromium loops the file) and camera file (their portrait, a still repeated) ──
const LINE = {};
const LIVE_MEDIA = {};
const RATE = 48000;
/** The samples of a 16-bit PCM WAV (its `data` chunk). */
function wavData(file) {
  const b = fs.readFileSync(file);
  for (let o = 12; o + 8 <= b.length;) {
    const id = b.toString('ascii', o, o + 4), len = b.readUInt32LE(o + 4);
    if (id === 'data') return b.subarray(o + 8, o + 8 + len);
    o += 8 + len + (len % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}
function wavFile(file, pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}
let prevEnd = 0;
if (LIVE) {
  for (const [id, [who, text, when]] of Object.entries(LIVE_SAY)) {
    const c = await synth(who, text);
    const startMs = Math.round(Array.isArray(when) ? LINE[when[0]].startMs + LINE[when[0]].durMs + when[1] * 1000 : prevEnd + when * 1000);
    LINE[id] = { who, text, ...c, startMs };
    prevEnd = startMs + c.durMs;
  }
}
if (REAL_CALL) {
  const MEDIA = path.join(DIR, 'media');
  fs.mkdirSync(MEDIA, { recursive: true });
  const photos = process.env.FILM_PHOTOS ?? path.join(ROOT, 'portal', 'public', 'avatars', 'photos');
  const totalMs = prevEnd + 10 * 60_000;
  for (const key of ['vera', 'nora', 'eli']) {
    let wav = null;
    if (LIVE) {
      const pcm = Buffer.alloc(Math.ceil((totalMs / 1000) * RATE) * 2);
      for (const l of Object.values(LINE).filter((x) => x.who === key)) wavData(path.join(DIR, l.file)).copy(pcm, Math.round((l.startMs / 1000) * RATE) * 2);
      wav = path.join(MEDIA, `${key}.wav`);
      wavFile(wav, pcm);
    }
    const y4m = path.join(MEDIA, `${key}.y4m`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-loop', '1', '-i', path.join(photos, `${CAST[key].personId}.jpg`), '-frames:v', '15', '-r', '15',
      '-vf', 'scale=640:640,crop=640:480:0:50,format=yuv420p', '-f', 'yuv4mpegpipe', y4m]);
    LIVE_MEDIA[key] = { wav, y4m };
  }
  if (LIVE) console.log(`film --live: ${Object.keys(LINE).length} lines over ${(prevEnd / 1000).toFixed(0)} s from the microphones opening`);
}
console.log(`film: speech ready (new lines so far cost about $${ttsCost.usd.toFixed(3)} in all, ${ttsCost.lines} lines)`);
// The scripted Nova needs no provider key: a copy made only for the speech goes before the server starts.
if (!LIVE && process.env.FILM_ENV_IS_COPY === '1') { providerKey(); fs.rmSync(path.join(ROOT, 'middleware', '.env'), { force: true }); }

// ── The stack: its own mock middleware and portal, as scripts/journeys/run-demo-moments.mjs starts them ──
const answers = (port, host) => new Promise((resolve) => {
  const sock = net.connect({ port, host });
  sock.setTimeout(1000);
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('timeout', () => { sock.destroy(); resolve(false); });
  sock.once('error', () => resolve(false));
});
const portFree = async (port) => !(await answers(port, '127.0.0.1')) && !(await answers(port, '::1'));
function devMockEnv() {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'middleware', 'package.json'), 'utf8')).scripts['dev:mock'];
  const env = {};
  for (const tok of script.split(/\s+/)) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(tok); if (!m) break; env[m[1]] = m[2]; }
  return env;
}
const started = [];
function start(name, cmd, argv, cwd, env, log) {
  const out = fs.openSync(log, 'w');
  const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out], detached: true });
  started.push({ name, child });
}
function stopAll() { for (const { child } of started.splice(0)) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } } }
process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('SIGTERM', () => { stopAll(); process.exit(143); });
async function waitUp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not yet */ } await sleep(1000); }
  return false;
}

for (const [port, what] of [[MW_PORT, 'middleware'], [PORTAL_PORT, 'portal']]) {
  if (!(await portFree(port))) { console.error(`port ${port} (${what}) is in use; nothing was started.`); process.exit(2); }
}
/**
 * Live: the social profile's middleware settings (scripts/social-documents.mjs `middlewareEnv`, with this middleware's port), Nova
 * on the provider's live session hearing the media server's taps, the dead-man preload and the film's scripted decision check.
 */
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`film: set ${k} for a real call (see the header)`); process.exit(2); } return v; };
function liveEnv() {
  if (UNTIL > 0 && !fs.existsSync(path.join(ROOT, 'middleware', '.env'))) { console.error('film --live: middleware/.env (the provider key) is missing'); process.exit(2); }
  const deadman = path.join(ROOT, 'scripts', 'meeting-assistant', 'lib', 'deadman.cjs');
  const preload = path.join(ROOT, 'scripts', 'demo', 'film-scripted-decisions.mjs');
  return {
    MEETING_ASSISTANT_LIVE: '1',
    MEETING_ASSISTANT_MEDIA_URL: process.env.FILM_MEDIA_URL || 'http://127.0.0.1:3901',
    MEETING_ASSISTANT_MEDIA_ADMIN_TOKEN: need('FILM_MEDIA_ADMIN_TOKEN'),
    MEETING_ASSISTANT_SINK_BASE_URL: process.env.FILM_SINK_BASE_URL || `http://127.0.0.1:${MW_PORT}`,
    MEETING_ASSISTANT_SINK_SECRET: need('FILM_SINK_SECRET'),
    NODE_OPTIONS: `--require ${deadman} --import ${pathToFileURL(preload).href}`,
    MA_DEADMAN_MS: process.env.FILM_DEADMAN_MS || String(20 * 60_000),
    FILM_DECISION_MODULE: path.join(ROOT, 'middleware', 'src', 'lib', 'meeting-assistant', 'decision-model.ts'),
  };
}
/** The social profile's middleware settings (scripts/social-documents.mjs `middlewareEnv`, with this middleware's port). */
function socialEnv() {
  const saved = JSON.parse(fs.readFileSync(need('FILM_SOCIAL_SETTINGS'), 'utf8'));
  const platformPort = process.env.FILM_PLATFORM_PORT || '23001', gatewayPort = process.env.FILM_GATEWAY_PORT || '28080';
  return {
    INSECURE_DEV_MODE: 'true',
    DOCUMENT_GRANT_ISSUER: saved.issuer, DOCUMENT_GRANT_KEY_ID: saved.keyId, DOCUMENT_GRANT_PRIVATE_KEY: saved.privateKey, DOCUMENT_POLICY_SECRET: saved.policySecret,
    DOCUMENT_GATEWAY_PUBLIC_URL: `ws://127.0.0.1:${gatewayPort}`, DOCUMENT_GATEWAY_INTERNAL_URL: `ws://127.0.0.1:${gatewayPort}`,
    DOCUMENT_PLATFORM_INTERNAL_URL: `http://127.0.0.1:${platformPort}`,
    REALTIME_GATEWAY_URL: `http://localhost:${MW_PORT}`, REALTIME_PLATFORM_PUBLIC_URL: `http://localhost:${platformPort}`,
    REALTIME_VIDEO_PUBLIC_URL: process.env.FILM_VIDEO_PUBLIC_URL || 'http://localhost:3901',
    DOCUMENT_COMMENT_IMPORT_TABLE: 'document-comments', DOCUMENT_COMMENT_IMPORT_DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
    SOCIAL_CHAT_DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
  };
}
const WORK = path.join(DIR, 'work');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
start('middleware', process.execPath, [path.join(ROOT, 'middleware', 'node_modules', '.bin', 'tsx'), 'src/index.ts'], path.join(ROOT, 'middleware'), {
  ...devMockEnv(), PORT: String(MW_PORT), VOICE_LOG_DIR: path.join(WORK, 'voice-log'), MOCK_PERSIST_PAIRINGS: '0',
  MEETING_ASSISTANT_ENABLED: 'true', MEETING_ASSISTANT_MAX_MINUTES: String(MAX_MINUTES),
  ...(REAL_CALL ? socialEnv() : {}),
  ...(LIVE ? liveEnv() : { MOCK_VOICE: '1' }),
}, path.join(WORK, 'middleware.log'));
start('portal', process.execPath, [path.join(ROOT, 'scripts', 'journeys', 'journey-vite.mjs'), '--port', String(PORTAL_PORT)], path.join(ROOT, 'portal'), {
  VITE_GATEWAY_URL: `http://localhost:${MW_PORT}`, API_PROXY_TARGET: `http://127.0.0.1:${MW_PORT}`,
}, path.join(WORK, 'portal.log'));
console.log(`film: middleware :${MW_PORT}, portal :${PORTAL_PORT}`);
const mwUp = await waitUp(`${MIDDLEWARE}/api/health`, 180_000);
// The server reads middleware/.env once at start; a copy made for the take (FILM_ENV_IS_COPY=1) goes as soon as it has.
if (LIVE && process.env.FILM_ENV_IS_COPY === '1') fs.rmSync(path.join(ROOT, 'middleware', '.env'), { force: true });
if (!(mwUp && await waitUp(`${PORTAL}/`, 180_000))) {
  console.error('film: the stack did not come up; see work/middleware.log and work/portal.log');
  stopAll();
  process.exit(2);
}

const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const playwright = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

// ── The timeline the compose step reads ──
const timeline = { size: { width: 1440, height: 900 }, cast: {}, videos: {}, scenes: [], speech: [], clicks: [], holds: [] };
for (const [k, c] of Object.entries(CAST)) timeline.cast[k] = { name: c.name, label: c.label ?? c.name, voice: c.voice };
let scene = null;
function beginScene(n, title, caption) { scene = { n, title, caption, shots: [] }; timeline.scenes.push(scene); console.log(`scene ${n}: ${title}`); }
/**
 * Ends the running shot (if any) and starts one with these views from now, or from `at` when the moment worth showing began
 * a little earlier than the script noticed it (the recordings run on, so a shot may start in the past after a skip).
 * `views`: [{ v: video id, crop?: name }].
 */
function cut(layout, views, { at } = {}) {
  const now = Date.now();
  const last = scene.shots.at(-1);
  if (last && last.to === null) last.to = now;
  const from = at !== undefined ? Math.max(at, last ? last.to : at) : now;
  scene.shots.push({ layout, views, from, to: null });
}
/** Ends the running shot without starting another: what follows until the next cut is left out of the film. */
function skip() { const last = scene.shots.at(-1); if (last && last.to === null) last.to = Date.now(); }
function endScene() { skip(); scene = null; }
/**
 * A pause for the viewer: an important state stays 1.5 to 2.5 s (the scenes ask for more or less; short settles pass through).
 */
function hold(ms = 2000) {
  const d = ms <= 1200 ? ms : Math.min(2500, Math.max(1500, Math.round(ms * 0.5)));
  // The edit plays a hold as recorded and speeds up other unchanged stretches, so each one is noted.
  if (scene) timeline.holds.push([Date.now(), Date.now() + d]);
  return sleep(d);
}
/** Plays what follows at `factor` times speed in the film: a wait where nothing changes on screen. normal() ends it. */
function brisk(factor = 3) { const last = scene.shots.at(-1); cut(last.layout, last.views); scene.shots.at(-1).speed = factor; }
function normal() { const last = scene.shots.at(-1); cut(last.layout, last.views); }

const BROWSER_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({ args: BROWSER_ARGS });
/** Live: one Chromium per person in the call, as the fake camera and microphone files are per process. */
const ownBrowsers = [];
const RAW = path.join(DIR, 'raw');
fs.rmSync(RAW, { recursive: true, force: true });
let callId = null;
const pageErrors = [];

// ── Live: Nova's voice as Vera's browser receives it, each 100 ms frame with its arrival time (the compose step places it) ──
const novaAudio = LIVE ? fs.createWriteStream(path.join(DIR, 'nova-audio.jsonl')) : null;
const live = { events: [], late: [], audio: null, novaFrames: 0, spend: null, transcript: null, microphones: {} };
function keepNovaVoice(page) {
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string' || !payload.includes('assistant-audio')) return;
    let f; try { f = JSON.parse(payload); } catch { return; }
    if (f?.type !== 'assistant-audio' || typeof f.data?.pcm !== 'string') return;
    live.novaFrames += 1;
    novaAudio.write(`${JSON.stringify({ atMs: Date.now(), runId: f.data.runId, seq: f.data.seq, sampleRate: f.data.sampleRate, last: f.data.last === true, pcm: f.data.pcm })}\n`);
  }));
}

/**
 * A signed-in person with their own recorded browser (one video per page, keyed `who` or `who-2`...). `nav` opens a page at
 * once: a page that waits blank paints nothing, and its video starts only at its first frame.
 */
async function person(key, { call = true, video = key, nav = null } = {}) {
  const who = CAST[key];
  const dir = path.join(RAW, video);
  let b = browser;
  if (REAL_CALL && call && LIVE_MEDIA[key]) {
    const m = LIVE_MEDIA[key];
    b = await chromium.launch({ args: [...BROWSER_ARGS, `--use-file-for-fake-video-capture=${m.y4m}`, ...(m.wav ? [`--use-file-for-fake-audio-capture=${m.wav}`] : [])] });
    ownBrowsers.push(b);
  }
  const context = await b.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } } });
  const login = await context.request.post(`${PORTAL}/api/session/login`, { data: { userId: who.userId } });
  must(login.status() === 200, `login ${who.userId}: ${login.status()}`);
  const role = await context.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: who.role } });
  must(role.status() === 200, `role ${who.role}: ${role.status()}`);
  if (call && REAL_CALL) {
    // Camera on at the join, microphone off: live, the three microphones open together later, so the three files share one clock;
    // with the scripted Nova they stay off (the lines reach it through the mock transcript, and the soundtrack carries them).
    await context.addInitScript(([k]) => localStorage.setItem(k, JSON.stringify({ micOn: false, cameraOn: true, remember: true })), [PRE_JOIN_KEY]);
    // Notes when each capture opens (the microphone file plays from its first sample then); it changes nothing else.
    await context.addInitScript(() => {
      const md = navigator.mediaDevices;
      if (!md?.getUserMedia) return;
      const original = md.getUserMedia.bind(md);
      window.__filmCaptures = [];
      md.getUserMedia = async (c) => {
        const rec = { calledAt: Date.now(), audio: Boolean(c?.audio), video: Boolean(c?.video), openedAt: null };
        window.__filmCaptures.push(rec);
        const stream = await original(c);
        rec.openedAt = Date.now();
        return stream;
      };
    });
  } else if (call) {
    await context.addInitScript(([k]) => localStorage.setItem(k, JSON.stringify({ micOn: false, cameraOn: false, remember: true })), [PRE_JOIN_KEY]);
    await context.route('**/api/session/realtime-token', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), platformApiUrl: STAND_IN_SFU, videoUrl: null } });
    });
    await context.route(`${STAND_IN_SFU}/**`, (route) => {
      const p = new URL(route.request().url()).pathname;
      return route.fulfill({ json: p.endsWith('/join') ? { participantId: `participant-${who.userId}`, token: null } : p.endsWith('/end') ? { ok: true } : { sessionId: 'film-signalling-only' } });
    });
  }
  const page = await context.newPage();
  timeline.videos[video] = { who: key, startMs: Date.now(), file: null };
  page.on('pageerror', (e) => pageErrors.push(`${video}: ${e.message}`));
  page.on('request', (rq) => { const m = /\/api\/calls\/([^/]+)\/chat(?:\?|$)/.exec(new URL(rq.url()).pathname + new URL(rq.url()).search); if (m && !callId) callId = decodeURIComponent(m[1]); });
  if (LIVE && key === 'vera') keepNovaVoice(page);
  const p = { key, who, video, context, page, api: context.request };
  p.videoPath = page.video()?.path();
  if (nav) await page.goto(`${PORTAL}${nav}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return p;
}

// ── Helpers shared with the walk's setup (no assertions beyond what the story needs to go on) ──
const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new FilmFailure(`${what} never happened`); await sleep(300); }
};
const asApi = (rest) => `${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/${rest}`;
const chatMessages = async (p) => (await (await p.api.get(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/chat?limit=100`)).json()).messages ?? [];
const novaOf = async (p, kind) => (await chatMessages(p)).filter((m) => m.metadata?.kind === kind);
const stateOf = async (p) => (await (await p.api.get(asApi('state'))).json());
const proposalsOf = async (p) => (await (await p.api.get(asApi('proposals'))).json()).proposals ?? [];
const markText = async (p) => (await p.page.getByTestId('nova-mark').first().innerText().catch(() => '')).trim();
const waitMark = (p, re, ms = 20000) => waitFor(async () => re.test(await markText(p)), ms, `${p.key}'s mark reading ${re}`);
async function devPost(route, body) {
  const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  must(res.status < 300, `the dev route ${route} answered ${res.status}`);
  return res.json().catch(() => ({}));
}
const inject = (userId, text) => devPost('transcript-lines', { userId, text });

/** A person speaks: the speech starts now and lasts its clip; the line is "heard" (injected) when it ends. */
async function speak(p, id, { heard = true, after = 250 } = {}) {
  const c = CLIPS[id];
  must(c && c.who === p.key, `line ${id} is not ${p.key}'s`);
  timeline.speech.push({ who: p.key, text: c.text, file: c.file, atMs: Date.now(), durMs: c.durMs, heard });
  await sleep(c.durMs);
  if (heard) await inject(p.who.userId, c.text);
  await sleep(Math.min(after, 600));
}
/** Nova speaks aloud (only once its voice is on in the product): the clip starts when the words reach the chat. */
async function novaSpeaks(text, atMs) {
  const c = await synth('nova', text);
  timeline.speech.push({ who: 'nova', text, file: c.file, atMs, durMs: c.durMs, heard: false });
  return c.durMs;
}
/** Shows the viewer what is about to be clicked: scroll into view, hover, a ring in the edited video, then the click. */
async function press(p, locator, { lead = 700, click = true } = {}) {
  const el = locator.first();
  await el.waitFor({ state: 'visible', timeout: 30000 });
  await el.scrollIntoViewIfNeeded().catch(() => undefined);
  await el.hover().catch(() => undefined);
  const box = await el.boundingBox();
  if (box) timeline.clicks.push({ video: p.video, atMs: Date.now(), leadMs: lead, box: [box.x, box.y, box.width, box.height].map(Math.round) });
  await sleep(lead);
  if (click) await el.click();
}
/** Notes in the page the moment its Nova mark first reads "Nova is speaking" (the browser and this script share one clock). */
async function watchSpeaking(p) {
  await p.page.evaluate(() => {
    window.__novaSpeakingAt = null;
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="nova-mark"]');
      if (el && window.__novaSpeakingAt === null && /Nova is speaking/.test(el.innerText || '')) window.__novaSpeakingAt = Date.now();
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
async function menu(p, item) {
  await press(p, p.page.getByTestId('nova-mark'), { lead: 550 });
  await press(p, p.page.getByRole('menuitem', { name: item }), { lead: 650 });
}
async function openChat(p) {
  if (await p.page.getByTestId('huddle-thread').isVisible().catch(() => false)) return;
  await press(p, p.page.getByTestId('shell-call-dock-chat'), { lead: 600 });
  await p.page.getByTestId('huddle-thread').waitFor({ timeout: 20000 });
}
const proposalCard = (p, id) => p.page.locator(`[data-testid="assistant-proposal-card"][data-proposal-id="${id}"]`).last();
const cardState = (p, id, state) => waitFor(async () => (await proposalCard(p, id).getAttribute('data-state')) === state, 25000, `${p.key}: the proposal card reading ${state}`);
const deckOf = (p) => p.page.getByTestId('nova-proposal-ask');
const deckButton = (p, re) => deckOf(p).getByRole('button', { name: re });
/** Scrolls the call chat to its newest message, as a person following the conversation would. */
async function scrollChatToEnd(p) {
  await p.page.evaluate(() => {
    const el = document.querySelector('[data-testid="huddle-thread"]');
    if (!el) return;
    const up = []; for (let n = el.parentElement, i = 0; n && i < 3; n = n.parentElement, i += 1) up.push(n);
    for (const n of [el, ...el.querySelectorAll('*'), ...up]) {
      if (n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) n.scrollTop = n.scrollHeight;
    }
  }).catch(() => undefined);
}
/** While the call runs, every seated person keeps their chat at the newest message (a deck prompt opening shrinks the pane). */
const following = new Set();
const follower = setInterval(() => { for (const p of following) void scrollChatToEnd(p); }, 700);
/** Puts away a deck prompt the person does not answer now (its Hide control, else Esc inside it). */
async function hidePrompt(p) {
  const hide = p.page.getByRole('button', { name: /^Hide$/ }).first();
  if (await hide.isVisible().catch(() => false)) { await hide.click().catch(() => undefined); await sleep(600); return; }
  const deck = p.page.getByTestId('nova-proposal-ask');
  if (await deck.isVisible().catch(() => false)) { await deck.getByRole('button').first().focus().catch(() => undefined); await p.page.keyboard.press('Escape'); await sleep(600); }
}
/** Moves within the app as a link does, without a reload: a reload takes the person out of the call. */
async function goInApp(p, href) {
  await p.page.evaluate((h) => { window.history.pushState({}, '', h); window.dispatchEvent(new PopStateEvent('popstate')); }, href);
}
async function shotPng(p, name) { await p.page.screenshot({ path: path.join(DIR, 'shots', `${name}-${p.video}.png`) }).catch(() => undefined); }
fs.mkdirSync(path.join(DIR, 'shots'), { recursive: true });

const V = (v, crop) => (crop ? { v, crop } : { v });
let vera, nora, eli, layla;
let exitCode = 0;
async function scriptedFilm() {
  const reset = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  must(reset.status === 200, `mock reset answered ${reset.status}`);

  // ── Before the film: everyone signed in, on the initiative page ──
  // Everyone's browser is open from the start, so every recording runs before the shots that show it.
  vera = await person('vera', { nav: INITIATIVE });
  nora = await person('nora', { nav: INITIATIVE });
  eli = await person('eli', { nav: INITIATIVE });
  for (const p of [vera, nora, eli]) await p.page.getByTestId('initiative-header').waitFor({ timeout: 60000 });
  const me = await (await vera.api.get(`${PORTAL}/api/session/me`)).json();
  must(me.meetingAssistant === true, 'the assistant is not advertised (MEETING_ASSISTANT_ENABLED)');
  await sleep(2500);

  // ── 1. The call ──
  beginScene(1, 'The call', 'Vera, Nora and Eli meet in a call on the Observability Platform initiative. Vera invites Nova from the call bar.');
  cut('full', [V('vera')]);
  await hold(2500);
  await press(vera, vera.page.getByTestId('initiative-start-call'));
  await Promise.all([accept(nora), accept(eli)]);
  for (const p of [vera, nora, eli]) await p.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
  await waitFor(async () => callId, 15000, 'the call id on the wire');
  skip();
  await openChat(nora); await openChat(eli);
  following.add(nora); following.add(eli);
  if (REAL_CALL) for (const p of [vera, nora, eli]) await waitFor(async () => (await cameras(p)) >= 3, 60000, `${p.key} seeing three cameras`);
  await sleep(2000);
  cut('full', [V('vera')]);
  await openChat(vera);
  following.add(vera);
  await hold(1500);
  // On the real call each call card shows its viewer's own camera (the others fold into a count at this width): three portraits.
  if (REAL_CALL) { cut('rows3', [V('vera', 'callcard'), V('nora', 'callcard'), V('eli', 'callcard')]); await hold(4000); cut('full', [V('vera')]); }
  await speak(vera, 'greet', { heard: false, after: 500 });
  await press(vera, vera.page.getByTestId('nova-invite'));
  await waitMark(vera, /^Nova is listening/);
  await hold(3500);
  await shotPng(vera, 's01');
  endScene();

  // ── 2. Everyone is told ──
  beginScene(2, 'Everyone is told', 'Nora and Eli see the transcription notice. Nova cannot hear them until each of them acknowledges it.');
  await nora.page.getByTestId('nova-notice').waitFor({ timeout: 20000 });
  await eli.page.getByTestId('nova-notice').waitFor({ timeout: 20000 });
  cut('rows2', [V('nora', 'bottom'), V('eli', 'bottom')]);
  await hold(4500);
  await press(nora, nora.page.getByTestId('nova-notice-acknowledge'));
  await waitMark(nora, /^Nova is listening/);
  await hold(1200);
  await press(eli, eli.page.getByTestId('nova-notice-acknowledge'));
  await waitMark(eli, /^Nova is listening/);
  await hold(3000);
  endScene();

  // ── 3. Nova listens ──
  beginScene(3, 'Nova listens', 'The team talks. Nova keeps a transcript with each speaker\'s name (it shows on the meeting page afterwards) and stays quiet: nobody has asked it anything.');
  cut(REAL_CALL ? 'rows3' : 'full', REAL_CALL ? [V('vera', 'callcard'), V('nora', 'callcard'), V('eli', 'callcard')] : [V('eli')]);
  await hold(800);
  await speak(vera, 's3a');
  await speak(nora, 's3b');
  await speak(eli, 's3c');
  await speak(vera, 's3d', { after: 1500 });
  endScene();

  // ── 4. A question, answered in the call chat ──
  beginScene(4, 'Ask Nova', 'Vera asks Nova a question aloud. The answer appears in the call chat for everyone, labelled with who asked.');
  cut('split', [V('vera', 'chat-top'), V('nora', 'chat-top')]);
  await hold(800);
  await speak(vera, 's4q', { after: 0 });
  brisk();
  await sleep(1800);
  await devPost('assistant-messages', { kind: 'reply', text: ANSWER_4, askedBy: CAST.vera.userId, askedByName: CAST.vera.name });
  await waitFor(async () => /Asked by Vera/.test(await nora.page.getByTestId('huddle-thread').innerText()), 15000, 'the answer on Nora\'s screen');
  normal();
  await hold(4500);
  await speak(nora, 's4r', { after: 2000 });
  await shotPng(nora, 's04');
  endScene();

  // ── 5. A private answer ──
  beginScene(5, 'Only for the asker', 'Nora asks about her own budget. Only Nora sees the answer; the others see that it was answered privately.');
  cut('full', [V('nora', 'chat-top')]);
  await hold(600);
  await speak(nora, 's5q', { after: 0 });
  brisk();
  await nora.page.getByText(/only you can see this/i).first().waitFor({ timeout: 30000 });
  normal();
  await hold(800);
  await shotPng(nora, 's05');
  await hold(3400);
  await waitFor(async () => /Answered privately for Nora/.test(await vera.page.getByTestId('huddle-thread').innerText()), 15000, 'the fixed line on Vera\'s screen');
  cut('split', [V('nora', 'chat-top'), V('vera', 'chat-top')]);
  await hold(3500);
  await speak(nora, 's5r', { after: 1200 });
  endScene();

  // ── 6. An action only the asker confirms ──
  beginScene(6, 'An action card', 'Vera asks for a work item. Nova shows a card that only Vera can confirm; Nora sees it waiting, with no buttons.');
  cut('split', [V('vera', 'chat-pane'), V('nora', 'chat-pane')]);
  await hold(600);
  await speak(vera, 's6q', { after: 0 });
  brisk();
  const card6 = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => /deploy latency/.test(m.metadata.summary ?? '')), 25000, 'the action card');
  const veraCard6 = vera.page.getByTestId('assistant-action-card').filter({ hasText: /deploy latency/ }).last();
  const noraCard6 = nora.page.getByTestId('assistant-action-card').filter({ hasText: /deploy latency/ }).last();
  await veraCard6.waitFor({ timeout: 20000 }); await noraCard6.waitFor({ timeout: 20000 });
  normal();
  await hold(4500);
  await shotPng(vera, 's06a');
  await press(vera, veraCard6.getByTestId('assistant-action-confirm'));
  brisk();
  await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card6.metadata.actionId && m.metadata.status === 'done'), 30000, 'the card going to done');
  await waitFor(async () => /Done/.test(await noraCard6.getByTestId('assistant-action-status').innerText()), 15000, 'Nora\'s card reading done');
  normal();
  await hold(4000);
  await shotPng(vera, 's06b');
  endScene();

  // ── 7. A write that names someone else ──
  beginScene(7, 'A write that needs Nora', 'Vera asks for a work item assigned to Nora. It becomes a proposal that needs Nora\'s consent; once she gives it, Vera\'s browser runs it.');
  cut('split', [V('vera', 'chat-end'), V('nora', 'chat-end')]);
  await hold(600);
  await speak(vera, 's7q', { after: 0 });
  brisk();
  const p7 = await waitFor(async () => (await proposalsOf(vera)).find((p) => p.source === 'asked' && /paging runbook/i.test(p.statement)), 25000, 'the asked proposal');
  await proposalCard(nora, p7.id).waitFor({ timeout: 20000 });
  for (const p of [vera, nora]) await deckOf(p).filter({ hasText: /paging runbook/i }).waitFor({ timeout: 20000 });
  cut('split', [V('vera', 'chat-deck'), V('nora', 'chat-deck')]);
  await hold(4000);
  cut('full', [V('nora', 'lower')]);
  await hold(2500);
  await shotPng(nora, 's07a');
  await speak(nora, 's7r', { after: 300 });
  await press(nora, deckButton(nora, /^\s*1?\s*Consent\b/));
  await waitFor(async () => (await proposalsOf(nora)).find((p) => p.id === p7.id)?.responses?.length >= 1, 15000, 'Nora\'s consent');
  await hold(1200);
  cut('full', [V('vera', 'lower')]);
  await deckOf(vera).filter({ hasText: /paging runbook/i }).waitFor({ timeout: 20000 });
  await hold(2200);
  await shotPng(vera, 's07b');
  await press(vera, deckButton(vera, /^\s*1?\s*Consent\b/));
  brisk();
  await cardState(vera, p7.id, 'done');
  await sleep(800);
  cut('split', [V('vera', 'chat-end'), V('nora', 'chat-end')]);
  await hold(4000);
  await shotPng(vera, 's07c');
  endScene();

  // ── 8. Nova notices a decision ──
  beginScene(8, 'A decision, noticed', 'Nobody asks Nova anything. When the team agrees, a silent proposal appears at the next pause, and each person is asked in their own prompt.');
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')]);
  await hold(600);
  await speak(nora, 's8a');
  await speak(eli, 's8b', { after: 2500 });
  // The watcher waits for six quiet seconds; most of that pause is cut, and the film picks up just before the card arrives.
  skip();
  const p8 = await waitFor(async () => (await proposalsOf(vera)).find((p) => p.source === 'watcher' && p.state === 'open'), 45000, 'the watcher\'s proposal');
  const p8At = Date.now();
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')], { at: p8At - 1500 });
  await proposalCard(vera, p8.id).waitFor({ timeout: 20000 });
  for (const p of [vera, nora, eli]) await deckOf(p).filter({ hasText: p8.statement }).waitFor({ timeout: 20000 });
  cut('split', [V('vera', 'chat-deck'), V('eli', 'chat-deck')]);
  await hold(3500);
  cut('rows3', [V('vera', 'deck'), V('nora', 'deck'), V('eli', 'deck')]);
  await hold(4000);
  await shotPng(vera, 's08a'); await shotPng(nora, 's08a'); await shotPng(eli, 's08a');
  await press(vera, deckButton(vera, /^\s*1?\s*Consent\b/));
  await waitFor(async () => (await proposalsOf(vera)).find((p) => p.id === p8.id)?.responses?.length >= 1, 15000, 'Vera\'s consent');
  await hold(1500);
  await press(nora, deckButton(nora, /Consent and record/));
  await cardState(nora, p8.id, 'done');
  await waitFor(async () => (await proposalCard(nora, p8.id).getByTestId('assistant-proposal-result-link').count()) > 0, 15000, 'the link to the decision');
  await sleep(800);
  cut('split', [V('vera', 'chat-end'), V('nora', 'chat-end')]);
  await hold(4000);
  cut('full', [V('nora')]);
  await press(nora, proposalCard(nora, p8.id).getByTestId('assistant-proposal-result-link'));
  await waitFor(async () => /Agreed in a call by/.test(await nora.page.locator('body').innerText()), 30000, 'the decision page saying "Agreed in a call by"');
  await nora.page.getByText(/Agreed in a call by/).first().scrollIntoViewIfNeeded().catch(() => undefined);
  await hold(5000);
  await shotPng(nora, 's08b');
  endScene();
  await nora.page.goBack({ waitUntil: 'domcontentloaded' });
  await nora.page.getByTestId('initiative-header').waitFor({ timeout: 30000 });
  await openChat(nora);

  // ── 9. An objection (the watcher posts at most one proposal in two minutes: wait out of frame) ──
  while (Date.now() - p8At < 2 * 60_000 + 3000) await sleep(1000);
  beginScene(9, 'An objection', 'A second proposal. Eli objects with a reason everyone in the call can see, and the proposal stops.');
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')]);
  await hold(600);
  await speak(vera, 's9a');
  await speak(nora, 's9b', { after: 2500 });
  skip();
  const p9 = await waitFor(async () => (await proposalsOf(vera)).find((p) => p.source === 'watcher' && p.state === 'open' && p.id !== p8.id), 45000, 'the second proposal');
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')], { at: Date.now() - 1500 });
  await proposalCard(eli, p9.id).waitFor({ timeout: 20000 });
  for (const p of [vera, eli]) await deckOf(p).filter({ hasText: p9.statement }).waitFor({ timeout: 20000 });
  cut('split', [V('vera', 'chat-deck'), V('eli', 'chat-deck')]);
  await hold(3500);
  cut('full', [V('eli', 'lower')]);
  await hold(1500);
  await speak(eli, 's9c', { after: 300 });
  await press(eli, deckButton(eli, /Object/));
  const input = deckOf(eli).getByRole('textbox');
  await input.waitFor({ timeout: 10000 });
  await hold(1200);
  await input.pressSequentially(OBJECTION_9, { delay: 18 });
  await hold(1500);
  await shotPng(eli, 's09a');
  await input.press('Enter');
  for (const p of [vera, nora, eli]) await cardState(p, p9.id, 'objected');
  await sleep(800);
  cut('split', [V('vera', 'chat-deck'), V('nora', 'chat-deck')]);
  await hold(5000);
  await shotPng(nora, 's09b');
  endScene();
  // Nobody else answers the objected proposal: its deck prompt is put away for everyone (Esc), so the footer is quiet again.
  for (const p of [vera, nora, eli]) {
    if (await deckOf(p).isVisible().catch(() => false)) { await deckOf(p).getByRole('button').first().focus().catch(() => undefined); await p.page.keyboard.press('Escape'); }
  }
  await sleep(1000);

  // ── 10. Nova's voice ──
  beginScene(10, 'Nova\'s voice', 'Vera turns Nova\'s voice on for the call. Nora mutes it for herself; for everyone else, Nova now answers aloud.');
  cut('full', [V('vera', 'corner')]);
  await hold(1200);
  await menu(vera, "Turn Nova's voice on");
  await waitFor(async () => (await vera.page.getByTestId('nova-mark').first().getAttribute('data-voice')) === 'true', 15000, 'voice on');
  await hold(3000);
  await waitFor(async () => (await nora.page.getByTestId('nova-mark').first().getAttribute('data-voice')) === 'true', 15000, 'voice on for Nora');
  cut('full', [V('nora', 'corner')]);
  await hold(800);
  await menu(nora, 'Mute Nova for me');
  await waitFor(async () => (await nora.page.getByTestId('nova-mark').first().getAttribute('data-voice-muted')) === 'true', 8000, 'Nora\'s mute');
  await hold(1500);
  // The mute is per browser and changes no words on the mark: her menu now offers to unmute.
  await press(nora, nora.page.getByTestId('nova-mark'), { lead: 700 });
  await press(nora, nora.page.getByRole('menuitem', { name: 'Unmute Nova for me' }), { lead: 2200, click: false });
  await nora.page.keyboard.press('Escape');
  await nora.page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await hold(800);
  await shotPng(nora, 's10a');
  cut('rows2', [V('vera', 'mark-chat'), V('nora', 'mark-chat')]);
  await hold(800);
  const repliesBefore = (await novaOf(vera, 'assistant-reply')).length;
  await watchSpeaking(vera);
  await speak(vera, 's10q', { after: 0 });
  const reply10 = await waitFor(async () => (await novaOf(vera, 'assistant-reply')).slice(repliesBefore).find((m) => /confirm/i.test(m.message)), 25000, 'Nova\'s spoken reply');
  // Nova's voice starts when the mark says it is speaking (the mock voice is a short tone, so the mark holds about a second);
  // a ring in the edit draws the eye to the mark for that moment.
  const speakingAt = await waitFor(() => vera.page.evaluate(() => window.__novaSpeakingAt), 5000, 'the speaking mark').catch(() => null);
  if (!speakingAt) console.log('  WARN: the mark never read "Nova is speaking"');
  const markBox = await vera.page.getByTestId('nova-mark').first().boundingBox();
  if (speakingAt && markBox) timeline.clicks.push({ video: 'vera', atMs: speakingAt - 150, leadMs: 1600, box: [markBox.x, markBox.y, markBox.width, markBox.height].map(Math.round) });
  const spoken = await novaSpeaks(reply10.message, speakingAt ?? Date.now());
  await shotPng(vera, 's10b');
  await sleep(Math.max(1500, spoken + 500));
  const card10 = vera.page.getByTestId('assistant-action-card').filter({ hasText: /on-call rota/ }).last();
  await press(vera, card10.getByTestId('assistant-action-confirm'));
  await waitFor(async () => /Done/.test(await card10.getByTestId('assistant-action-status').innerText()), 30000, 'the rota card going to done');
  await hold(3000);
  endScene();

  // ── 11. Pause, resume, time left ──
  beginScene(11, 'Pause and time left', 'Anyone can pause Nova; nothing is heard or kept while it is paused. Near its time limit the mark shows the time left, and Vera extends it.');
  cut('full', [V('eli', 'corner')]);
  await hold(1000);
  await menu(eli, 'Pause Nova');
  await waitMark(eli, /^Nova is paused/); await waitMark(vera, /^Nova is paused/);
  await hold(2000);
  await speak(eli, 's11a', { after: 1200 });
  await shotPng(eli, 's11a');
  await menu(eli, 'Resume Nova');
  await waitMark(eli, /^Nova is listening/); await waitMark(vera, /^Nova is listening/);
  await hold(1000);
  await speak(eli, 's11b', { after: 1200 });
  const state11 = await stateOf(vera);
  console.log(`  scene 11 state: listening ${state11.listeningSeconds}s of ${state11.ceilingSeconds}s`);
  cut('full', [V('vera', 'corner')]);
  const left = await waitFor(async () => /min left/.test(await markText(vera)), 20000, 'the time-left mark').catch(() => null);
  if (!left) console.log('  WARN: the mark shows no time left; adjust --max-minutes');
  await hold(3000);
  await shotPng(vera, 's11b');
  await menu(vera, 'Extend time');
  await waitFor(async () => !/min left/.test(await markText(vera)), 15000, 'the extension').catch(() => console.log('  WARN: the mark still shows time left after the extension'));
  await hold(3500);
  endScene();

  // ── 12. The minutes ──
  beginScene(12, 'The minutes', 'Vera dismisses Nova. Nova leaves its minutes: a summary, the proposals, the action items, and the transcript by speaker.');
  cut('full', [V('vera')]);
  await hold(800);
  await speak(vera, 's12a', { after: 400 });
  await menu(vera, 'Dismiss Nova');
  brisk();
  await vera.page.getByTestId('nova-left').waitFor({ timeout: 20000 });
  const link = vera.page.getByTestId('assistant-notice-meeting-link').last();
  await link.waitFor({ state: 'visible', timeout: 30000 });
  normal();
  await hold(4000);
  await shotPng(vera, 's12a');
  await press(vera, link);
  await vera.page.getByTestId('meeting-page').waitFor({ timeout: 30000 });
  await vera.page.getByTestId('meeting-summary').waitFor({ timeout: 30000 });
  // The objected proposal still asks Vera on this page; she puts the prompt away before reading (out of frame).
  skip();
  following.delete(vera);
  await sleep(1500);
  await hidePrompt(vera);
  cut('full', [V('vera', 'meeting')]);
  await hold(4500);
  await shotPng(vera, 's12b');
  for (const id of ['meeting-proposals', 'meeting-action-items']) {
    const el = vera.page.getByTestId(id).first();
    if (await el.count()) { await el.evaluate((n) => n.scrollIntoView({ behavior: 'smooth', block: 'start' })); await hold(4000); }
  }
  await vera.page.getByText('By speaker').first().evaluate((n) => n.scrollIntoView({ behavior: 'smooth', block: 'start' })).catch(() => undefined);
  await hold(5000);
  await shotPng(vera, 's12c');
  await vera.page.mouse.move(500, 300);
  await vera.page.mouse.wheel(0, 300);
  await hold(3500);
  skip();
  await goInApp(vera, '/iq/meetings');
  await vera.page.getByTestId('iq-meetings-table').waitFor({ timeout: 30000 });
  await sleep(1200);
  cut('full', [V('vera')]);
  await hold(4000);
  await shotPng(vera, 's12d');
  endScene();

  // ── 13. Who can see it, and deleting it ──
  layla = await person('layla', { call: false });
  beginScene(13, 'Who can see it', 'Layla was not in the call, so the meeting is not there for her. Vera deletes the record, and Nova\'s messages in the call chat are blanked.');
  cut('full', [V('layla', 'notfound')]);
  await layla.page.goto(`${PORTAL}/iq/meetings/${encodeURIComponent(callId)}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await layla.page.getByTestId('meeting-not-found').waitFor({ timeout: 30000 });
  await hold(4500);
  await shotPng(layla, 's13a');
  await goInApp(vera, `/iq/meetings/${encodeURIComponent(callId)}`);
  await vera.page.getByTestId('meeting-actions').waitFor({ timeout: 30000 });
  await sleep(1500);
  await hidePrompt(vera);
  cut('full', [V('vera')]);
  await hold(1200);
  await press(vera, vera.page.getByTestId('meeting-actions')); // Delete is in the header's menu
  await press(vera, vera.page.getByTestId('meeting-delete'));
  const confirmDelete = vera.page.getByRole('button', { name: /Delete the record/ }).last();
  await confirmDelete.waitFor({ timeout: 15000 });
  await hold(3000);
  await shotPng(vera, 's13b');
  await press(vera, confirmDelete);
  // Nova's messages are blanked one by one before the page moves on (about 20 s on the real call's chat store): played fast.
  brisk(4);
  await vera.page.waitForURL(/\/iq\/meetings$/, { timeout: 90000 });
  normal();
  await hold(3000);
  skip();
  await waitFor(async () => !/Answered privately|deploy latency/.test(await nora.page.getByTestId('huddle-thread').innerText()), 60000, 'Nova\'s words leaving Nora\'s chat');
  cut('full', [V('nora', 'chat-end')]);
  await hold(6000);
  await shotPng(nora, 's13c');
  endScene();

  // Leave the call before the browsers close, so the videos end on a quiet page.
  for (const p of [eli, nora, vera]) await p.page.getByTestId('call-dock-leave').first().click({ timeout: 5000 }).catch(() => undefined);
  await sleep(1500);
}

// ── The live take: the same story on a real call, with the provider's live model as Nova ──
const micAt = {};
const lineStart = (id) => micAt[LINE[id].who] + LINE[id].startMs;
const lineEnd = (id) => lineStart(id) + LINE[id].durMs;
function note(what, data) {
  live.events.push({ atMs: Date.now(), what, ...(data ? { data } : {}) });
  console.log(`  [live] ${what}${data ? ` ${JSON.stringify(data).slice(0, 240)}` : ''}`);
}
/** Waits for a moment of the schedule; says so when the script gets there after it (what was meant to come first ran late). */
async function until(t, what) {
  const d = t - Date.now();
  if (d > 0) return sleep(d);
  if (d < -1000) { live.late.push({ what, ms: -d }); console.log(`  WARN: ${what}: ${(-d / 1000).toFixed(1)} s late`); }
  return undefined;
}
const msUntil = (t, min = 3000) => Math.max(min, t - Date.now());
const cameras = (p) => p.page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.videoWidth > 0 && v.readyState >= 2).length);
const micButton = (p) => p.page.locator('[data-testid="shell-call-dock"] [data-testid$="-mic"], [data-testid="call-dock-mic"]').first();
/** Takes the ring; with no ring (not invited by it), joins from the footer's huddle button. */
async function accept(p) {
  try { await p.page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 25000 }); } catch {
    await p.page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' }).click({ timeout: 15000 });
    note(`${p.key} joined from the footer`);
  }
}
/** The audio side's counters for the call (chunks taken, mixed, dropped; who they came from). */
async function sinkCounters() {
  try { const j = await (await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/assistant-audio`)).json(); delete j.token; return j; } catch { return null; }
}
/** A ring in the edit on Nova's mark from the moment it read "Nova is speaking" (watchSpeaking must have been called first). */
async function ringSpeaking(p) {
  const at = await p.page.evaluate(() => { const t = window.__novaSpeakingAt; window.__novaSpeakingAt = null; return t; }).catch(() => null);
  const box = await p.page.getByTestId('nova-mark').first().boundingBox().catch(() => null);
  if (at && box) timeline.clicks.push({ video: p.video, atMs: at - 150, leadMs: 1600, box: [box.x, box.y, box.width, box.height].map(Math.round) });
  return at;
}
let novaIn = false;
async function readSpend() {
  const st = await stateOf(vera).catch(() => null);
  let mine = [];
  for (let i = 0; i < 20 && !mine.length; i += 1) {
    const all = (await (await vera.api.get(`${PORTAL}/api/spend/entries?groupBy=source&key=meeting_assistant&period=month&limit=50`)).json().catch(() => ({}))).entries ?? [];
    mine = all.filter((e) => String(e.sourceId ?? '').startsWith(`ma:${callId}`));
    if (!mine.length) await sleep(500);
  }
  live.spend = { listeningSeconds: st?.listeningSeconds ?? null, entries: mine.map((e) => ({ sourceId: e.sourceId, seconds: e.seconds ?? e.quantity, costUsd: e.costUsd ?? e.amountUsd ?? e.usd, basis: e.basis })) };
  note('spend', live.spend);
}
async function keepTranscript() {
  const lines = (await (await vera.api.get(asApi('transcript?limit=500'))).json().catch(() => ({}))).lines ?? [];
  live.transcript = lines.map((l) => ({ userId: l.userId ?? null, speakers: l.speakers ?? null, startMs: l.startMs ?? null, endMs: l.endMs ?? null, at: l.at ?? null, text: l.text }));
  live.chat = (await chatMessages(vera).catch(() => [])).filter((m) => m.metadata?.kind?.startsWith('assistant-')).map((m) => ({ kind: m.metadata.kind, askedBy: m.metadata.askedBy ?? null, at: m.createdAt ?? m.timestamp ?? null, text: String(m.message ?? m.metadata.summary ?? '').slice(0, 160) }));
  note('transcript', { lines: lines.length, byUser: lines.reduce((m, l) => ({ ...m, [l.userId ?? 'none']: (m[l.userId ?? 'none'] ?? 0) + 1 }), {}) });
}

async function liveFilm() {
  const reset = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  must(reset.status === 200, `mock reset answered ${reset.status}`);
  vera = await person('vera', { nav: INITIATIVE });
  nora = await person('nora', { nav: INITIATIVE });
  eli = await person('eli', { nav: INITIATIVE });
  for (const p of [vera, nora, eli]) await p.page.getByTestId('initiative-header').waitFor({ timeout: 60000 });
  const me = await (await vera.api.get(`${PORTAL}/api/session/me`)).json();
  must(me.meetingAssistant === true, 'the assistant is not advertised (MEETING_ASSISTANT_ENABLED)');
  await sleep(2500);

  // ── 1. The call, through the media server ──
  beginScene(1, 'The call', 'Vera, Nora and Eli meet in a call on the Observability Platform initiative, through the local media server; each camera shows the person\'s portrait. They switch their microphones on, and Vera invites Nova.');
  cut('full', [V('vera')]);
  await hold(2500);
  await press(vera, vera.page.getByTestId('initiative-start-call'));
  await Promise.all([accept(nora), accept(eli)]);
  for (const p of [vera, nora, eli]) await p.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
  await waitFor(async () => callId, 15000, 'the call id on the wire');
  for (const p of [vera, nora, eli]) await waitFor(async () => (await cameras(p)) >= 3, 60000, `${p.key} seeing three cameras`);
  note('call connected', { callId, cameras: await cameras(vera) });
  skip();
  for (const p of [vera, nora, eli]) { await openChat(p); following.add(p); }
  await sleep(1500);
  cut('full', [V('vera')]);
  await hold(2500);
  await shotPng(vera, 's01a');
  // Each call card shows its viewer's own camera (the others' tiles fold into a count at this width): three portraits.
  cut('rows3', [V('vera', 'callcard'), V('nora', 'callcard'), V('eli', 'callcard')]);
  await hold(3000);
  // The three microphones open together: each file plays from its first sample from then, so the lines keep one schedule.
  const veraMic = micButton(vera);
  await veraMic.hover().catch(() => undefined);
  const micBox = await veraMic.boundingBox();
  if (micBox) timeline.clicks.push({ video: 'vera', atMs: Date.now(), leadMs: 900, box: [micBox.x, micBox.y, micBox.width, micBox.height].map(Math.round) });
  await sleep(900);
  await Promise.all([vera, nora, eli].map((p) => micButton(p).click()));
  for (const p of [vera, nora, eli]) {
    micAt[p.key] = await waitFor(() => p.page.evaluate(() => (window.__filmCaptures ?? []).find((c) => c.audio && c.openedAt)?.openedAt ?? null), 15000, `${p.key}'s microphone opening`);
  }
  live.microphones = { ...micAt };
  note('microphones open', { spreadMs: Math.max(...Object.values(micAt)) - Math.min(...Object.values(micAt)) });
  await hold(2000);
  cut('full', [V('vera')]);
  for (const [id, l] of Object.entries(LINE)) {
    timeline.speech.push({ who: l.who, text: l.text, file: l.file, atMs: micAt[l.who] + l.startMs, durMs: l.durMs, heard: !['greet', 's10a'].includes(id), line: id });
  }
  if (UNTIL <= 0) { await hold(3000); await shotPng(vera, 's01-mics'); endScene(); return; } // --until 0: the call alone, no Nova, no cost
  const poll = setInterval(async () => { const c = await sinkCounters(); if (c) live.audio = c; }, 10_000);
  try {
    await until(lineEnd('greet') + 500, 'the invite');
    await press(vera, vera.page.getByTestId('nova-invite'));
    novaIn = true;
    await waitMark(vera, /^Nova is listening/, 30000);
    note('Nova is listening');
    await hold(2000);
    await shotPng(vera, 's01b');
    endScene();
    if (UNTIL <= 1) return;
    await liveScenes();
  } finally {
    clearInterval(poll);
  }
}

async function liveScenes() {
  // ── 2. Everyone is told ──
  beginScene(2, 'Everyone is told', 'Nora and Eli see the transcription notice. Nova cannot hear them until each of them acknowledges it.');
  await nora.page.getByTestId('nova-notice').waitFor({ timeout: 20000 });
  await eli.page.getByTestId('nova-notice').waitFor({ timeout: 20000 });
  cut('rows2', [V('nora', 'bottom'), V('eli', 'bottom')]);
  await hold(3000);
  await press(nora, nora.page.getByTestId('nova-notice-acknowledge'));
  await waitMark(nora, /^Nova is listening/);
  await hold(1000);
  await press(eli, eli.page.getByTestId('nova-notice-acknowledge'));
  await waitMark(eli, /^Nova is listening/);
  await hold(2000);
  endScene();
  if (UNTIL <= 2) return;

  // ── 3. Nova's voice, on early so it is heard from here on ──
  beginScene(3, 'Nova\'s voice', 'Vera turns Nova\'s voice on for the call. Nora mutes it for herself; for everyone else, Nova now answers aloud as well as in the chat.');
  cut('full', [V('vera', 'corner')]);
  await hold(800);
  await menu(vera, "Turn Nova's voice on");
  await waitFor(async () => (await vera.page.getByTestId('nova-mark').first().getAttribute('data-voice')) === 'true', 15000, 'voice on');
  await hold(1800);
  await waitFor(async () => (await nora.page.getByTestId('nova-mark').first().getAttribute('data-voice')) === 'true', 15000, 'voice on for Nora');
  cut('full', [V('nora', 'corner')]);
  await hold(600);
  await menu(nora, 'Mute Nova for me');
  await waitFor(async () => (await nora.page.getByTestId('nova-mark').first().getAttribute('data-voice-muted')) === 'true', 8000, 'Nora\'s mute');
  await hold(1000);
  await press(nora, nora.page.getByTestId('nova-mark'), { lead: 600 });
  await press(nora, nora.page.getByRole('menuitem', { name: 'Unmute Nova for me' }), { lead: 1800, click: false });
  await nora.page.keyboard.press('Escape');
  await nora.page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await hold(600);
  endScene();
  if (UNTIL <= 3) return;

  // ── 4. Nova listens ──
  beginScene(4, 'Nova listens', 'The team talks. Nova hears each person through the media server and keeps a transcript with each speaker\'s name (it shows on the meeting page afterwards). Nobody has asked it anything, so it stays quiet.');
  const quietBefore = (await chatMessages(vera)).filter((m) => m.metadata?.kind?.startsWith('assistant-')).length;
  await until(lineStart('s3a') - 1200, 'the talk');
  cut('full', [V('vera')]);
  await until(lineEnd('s3d') + 2000, 'the end of the talk');
  note('scene 4 quiet', { novaMessages: (await chatMessages(vera)).filter((m) => m.metadata?.kind?.startsWith('assistant-')).length - quietBefore });
  endScene();
  if (UNTIL <= 4) return;

  // ── 5. A question, answered aloud and in the call chat ──
  beginScene(5, 'Ask Nova', 'Vera asks Nova a question aloud. Nova looks it up and answers aloud and in the call chat, labelled with who asked.');
  const replies5 = (await novaOf(vera, 'assistant-reply')).length;
  await watchSpeaking(vera);
  await until(lineStart('s4q') - 800, 'the question');
  cut('split', [V('vera', 'chat-top'), V('nora', 'chat-top')]);
  const reply5 = await waitFor(async () => (await novaOf(vera, 'assistant-reply')).slice(replies5).find((m) => m.metadata?.askedBy === CAST.vera.userId), msUntil(lineStart('s4r') + 6000), 'Nova\'s answer to Vera').catch(() => null);
  note('scene 5 answer', { text: reply5?.message ?? null });
  await sleep(1500);
  note('scene 5 spoke', { at: await ringSpeaking(vera) });
  await shotPng(nora, 's05');
  await until(lineEnd('s4r') + 1500, 'the end of the answer');
  endScene();
  if (UNTIL <= 5) return;

  // ── 6. A private answer ──
  beginScene(6, 'Only for the asker', 'Nora asks about her own budget. Only Nora sees the answer; the others see that it was answered privately.');
  await until(lineStart('s5q') - 800, 'the budget question');
  cut('full', [V('nora', 'chat-mid')]);
  const private6 = await nora.page.getByText(/only you can see this/i).first().waitFor({ timeout: msUntil(lineStart('s5r') + 4000) }).then(() => true, () => false);
  const fixed6 = await waitFor(async () => /Answered privately for Nora/.test(await vera.page.getByTestId('huddle-thread').innerText()), 6000, 'the fixed line').catch(() => false);
  note('scene 6', { privateAnswer: private6, othersSeeFixedLine: Boolean(fixed6) });
  await hold(1500);
  await shotPng(nora, 's06');
  cut('split', [V('nora', 'chat-mid'), V('vera', 'chat-mid')]);
  await until(lineEnd('s5r') + 1200, 'the end of the budget scene');
  endScene();
  if (UNTIL <= 6) return;

  // ── 7. An action only the asker confirms ──
  beginScene(7, 'An action card', 'Vera asks for a work item. Nova shows a card that only Vera can confirm; Nora sees it waiting, with no buttons.');
  const actions7 = (await novaOf(vera, 'assistant-action')).map((m) => m.metadata.actionId);
  await until(lineStart('s6q') - 800, 'the work item request');
  cut('split', [V('vera', 'chat-mid'), V('nora', 'chat-mid')]);
  const card7 = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => !actions7.includes(m.metadata.actionId)), msUntil(lineEnd('s6q') + 20000), 'the action card').catch(() => null);
  note('scene 7 card', card7 ? { summary: card7.metadata.summary, askedBy: card7.metadata.askedBy } : { none: true });
  if (card7) {
    const word = /latency|threshold|deploy/i;
    const veraCard = vera.page.getByTestId('assistant-action-card').filter({ hasText: word }).last();
    const noraCard = nora.page.getByTestId('assistant-action-card').filter({ hasText: word }).last();
    await veraCard.waitFor({ timeout: 20000 }); await noraCard.waitFor({ timeout: 20000 });
    await hold(3000);
    await shotPng(vera, 's07a');
    await press(vera, veraCard.getByTestId('assistant-action-confirm'));
    await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card7.metadata.actionId && m.metadata.status === 'done'), 30000, 'the card going to done');
    await waitFor(async () => /Done/.test(await noraCard.getByTestId('assistant-action-status').innerText()), 15000, 'Nora\'s card reading done').catch(() => undefined);
    note('scene 7 done');
    await hold(2500);
  }
  endScene();
  if (UNTIL <= 7) return;

  // ── 8. A write that names someone else ──
  beginScene(8, 'A write that needs Nora', 'Vera asks for a work item assigned to Nora. It becomes a proposal that needs Nora\'s consent; once she gives it, Vera\'s browser runs it.');
  const proposals8 = (await proposalsOf(vera)).map((p) => p.id);
  const actions8 = (await novaOf(vera, 'assistant-action')).map((m) => m.metadata.actionId);
  await until(lineStart('s7q') - 800, 'the runbook request');
  cut('split', [V('vera', 'chat-end'), V('nora', 'chat-end')]);
  const got8 = await waitFor(async () => {
    const pr = (await proposalsOf(vera)).find((p) => !proposals8.includes(p.id) && p.source === 'asked');
    if (pr) return { proposal: pr };
    const ac = (await novaOf(vera, 'assistant-action')).find((m) => !actions8.includes(m.metadata.actionId));
    return ac ? { action: ac } : null;
  }, msUntil(lineEnd('s7q') + 22000), 'the runbook request\'s outcome').catch(() => null);
  note('scene 8', got8?.proposal ? { proposal: got8.proposal.statement, named: got8.proposal.named } : got8?.action ? { action: got8.action.metadata.summary } : { none: true });
  if (got8?.proposal) {
    const p7 = got8.proposal;
    await proposalCard(nora, p7.id).waitFor({ timeout: 20000 });
    for (const p of [vera, nora]) await deckOf(p).waitFor({ timeout: 20000 });
    cut('split', [V('vera', 'chat-deck'), V('nora', 'chat-deck')]);
    await until(lineStart('s7r') - 2200, 'Nora\'s answer');
    cut('full', [V('nora', 'lower')]);
    await shotPng(nora, 's08a');
    await until(lineEnd('s7r') + 300, 'Nora\'s consent');
    await press(nora, deckButton(nora, /^\s*1?\s*Consent\b/));
    await waitFor(async () => (await proposalsOf(nora)).find((p) => p.id === p7.id)?.responses?.length >= 1, 15000, 'Nora\'s consent');
    await hold(1200);
    cut('full', [V('vera', 'lower')]);
    await deckOf(vera).waitFor({ timeout: 20000 });
    await hold(1500);
    await press(vera, deckButton(vera, /^\s*1?\s*Consent\b/));
    await cardState(vera, p7.id, 'done');
    note('scene 8 done');
    await sleep(800);
    cut('split', [V('vera', 'chat-end'), V('nora', 'chat-end')]);
    await hold(3500);
  } else if (got8?.action) {
    const card = vera.page.getByTestId('assistant-action-card').filter({ hasText: /runbook/i }).last();
    await card.waitFor({ timeout: 20000 });
    await hold(2500);
    await press(vera, card.getByTestId('assistant-action-confirm'));
    await hold(3000);
  }
  endScene();
  if (UNTIL <= 8) return;

  // ── 9. Nova notices a decision ──
  beginScene(9, 'A decision, noticed', 'Nobody asks Nova anything. When the team agrees, a silent proposal appears at the next pause, and each person is asked in their own prompt.');
  const before9 = (await proposalsOf(vera)).map((p) => p.id);
  await until(lineStart('s8a') - 800, 'the decision talk');
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')]);
  await until(lineEnd('s8b') + 2500, 'the end of the decision talk');
  skip();
  let p8 = await waitFor(async () => (await proposalsOf(vera)).find((p) => !before9.includes(p.id) && p.source === 'watcher'), 40000, 'the watcher\'s proposal').catch(() => null);
  if (!p8) {
    live.decisionFallback = true;
    note('scene 9: no watcher proposal; the dev route creates it');
    p8 = (await devPost('assistant-proposals', { statement: 'Page only on customer facing alerts until the launch', outcome: { kind: 'decision' }, executor: CAST.nora.userId })).proposal;
  }
  const p8At = Date.now();
  note('scene 9 proposal', { statement: p8.statement, source: p8.source, executor: p8.executor });
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')], { at: p8At - 1500 });
  await proposalCard(vera, p8.id).waitFor({ timeout: 20000 });
  for (const p of [vera, nora, eli]) await deckOf(p).waitFor({ timeout: 20000 });
  cut('split', [V('vera', 'chat-deck'), V('eli', 'chat-deck')]);
  await hold(3000);
  cut('rows3', [V('vera', 'deck'), V('nora', 'deck'), V('eli', 'deck')]);
  await hold(3500);
  await shotPng(vera, 's09a');
  await press(vera, deckButton(vera, /^\s*1?\s*Consent\b/));
  await waitFor(async () => (await proposalsOf(vera)).find((p) => p.id === p8.id)?.responses?.length >= 1, 15000, 'Vera\'s consent');
  await hold(1200);
  const executor = [vera, nora, eli].find((p) => p.who.userId === p8.executor) ?? nora;
  await press(executor, deckButton(executor, /Consent and record/));
  await cardState(executor, p8.id, 'done');
  await waitFor(async () => (await proposalCard(executor, p8.id).getByTestId('assistant-proposal-result-link').count()) > 0, 15000, 'the link to the decision');
  note('scene 9 done');
  await sleep(800);
  cut('split', [V('vera', 'chat-end'), V(executor.key, 'chat-end')]);
  await hold(3500);
  cut('full', [V(executor.key)]);
  await press(executor, proposalCard(executor, p8.id).getByTestId('assistant-proposal-result-link'));
  await waitFor(async () => /Agreed in a call by/.test(await executor.page.locator('body').innerText()), 30000, 'the decision page saying "Agreed in a call by"');
  await executor.page.getByText(/Agreed in a call by/).first().scrollIntoViewIfNeeded().catch(() => undefined);
  await hold(4500);
  await shotPng(executor, 's09b');
  endScene();
  await executor.page.goBack({ waitUntil: 'domcontentloaded' });
  await executor.page.getByTestId('initiative-header').waitFor({ timeout: 30000 });
  await openChat(executor);
  for (const p of [vera, nora, eli]) await hidePrompt(p);
  if (UNTIL <= 9) return;

  // ── 10. Pause (it also covers the watcher's two minutes between proposals) ──
  beginScene(10, 'Pause', 'Eli pauses Nova. Nothing is heard or kept while it is paused, so his aside about the vendor quote never reaches Nova or the minutes. Then he resumes it.');
  cut('full', [V('eli', 'corner')]);
  await hold(800);
  await menu(eli, 'Pause Nova');
  await waitMark(eli, /^Nova is paused/); await waitMark(vera, /^Nova is paused/);
  note('paused', { beforeAsideMs: lineStart('s10a') - Date.now() });
  if (Date.now() > lineStart('s10a') - 300) console.log('  WARN: paused after the aside began: Nova may have heard it');
  await until(lineEnd('s10a') + 1200, 'the end of the aside');
  await shotPng(eli, 's10a');
  skip();
  await until(Math.max(lineStart('s10b') - 6500, p8At + 95_000), 'the resume');
  cut('full', [V('eli', 'corner')]);
  await menu(eli, 'Resume Nova');
  await waitMark(eli, /^Nova is listening/, 30000); await waitMark(vera, /^Nova is listening/, 30000);
  note('resumed', { beforeLineMs: lineStart('s10b') - Date.now(), sinceProposalMs: Date.now() - p8At });
  await until(lineEnd('s10b') + 1200, 'the end of Eli\'s action item');
  endScene();
  if (UNTIL <= 10) return;

  // ── 11. An objection ──
  beginScene(11, 'An objection', 'A second proposal. Eli objects with a reason everyone in the call can see, and the proposal stops.');
  await until(lineStart('s9a') - 800, 'the second decision talk');
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')]);
  await until(lineEnd('s9b') + 2500, 'the end of the second decision talk');
  skip();
  let p9 = await waitFor(async () => (await proposalsOf(vera)).find((p) => p.source === 'watcher' && p.state === 'open' && p.id !== p8.id), 40000, 'the second proposal').catch(() => null);
  if (!p9) {
    live.objectionFallback = true;
    note('scene 11: no watcher proposal; the dev route creates it');
    p9 = (await devPost('assistant-proposals', { statement: 'Mute the disk space alerts for all of launch week', outcome: { kind: 'decision' }, executor: CAST.vera.userId })).proposal;
  }
  note('scene 11 proposal', { statement: p9.statement, source: p9.source, sinceFirstMs: Date.now() - p8At });
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')], { at: Date.now() - 1500 });
  await proposalCard(eli, p9.id).waitFor({ timeout: 20000 });
  for (const p of [vera, eli]) await deckOf(p).waitFor({ timeout: 20000 });
  cut('split', [V('vera', 'chat-deck'), V('eli', 'chat-deck')]);
  await until(lineStart('s9c') - 1500, 'Eli\'s objection');
  cut('full', [V('eli', 'lower')]);
  await until(lineEnd('s9c') + 300, 'the objection button');
  await press(eli, deckButton(eli, /Object/));
  const input = deckOf(eli).getByRole('textbox');
  await input.waitFor({ timeout: 10000 });
  await hold(800);
  await input.pressSequentially(OBJECTION_9, { delay: 35 });
  await hold(1000);
  await shotPng(eli, 's11a');
  await input.press('Enter');
  for (const p of [vera, nora, eli]) await cardState(p, p9.id, 'objected');
  note('scene 11 objected');
  await sleep(800);
  cut('split', [V('vera', 'chat-deck'), V('nora', 'chat-deck')]);
  await hold(3500);
  endScene();
  for (const p of [vera, nora, eli]) {
    if (await deckOf(p).isVisible().catch(() => false)) { await deckOf(p).getByRole('button').first().focus().catch(() => undefined); await p.page.keyboard.press('Escape'); }
  }
  if (UNTIL <= 11) return;

  // ── 12. Time left ──
  beginScene(12, 'Time left', 'Nova\'s mark shows the time left on its listening limit. Vera extends it.');
  cut('full', [V('vera', 'corner')]);
  await waitFor(async () => /min left/.test(await markText(vera)), 6000, 'the time-left mark').catch(() => undefined);
  note('time left', { mark: await markText(vera) });
  await hold(2500);
  await shotPng(vera, 's12');
  await menu(vera, 'Extend time');
  await waitFor(async () => !/min left/.test(await markText(vera)), 15000, 'the extension').catch(() => console.log('  WARN: the mark still shows time left after the extension'));
  await hold(2500);
  endScene();
  if (UNTIL <= 12) return;

  // ── 13. The minutes ──
  beginScene(13, 'The minutes', 'Vera thanks Nova and dismisses it. Nova leaves its minutes: a summary, the proposals, the action items, and the transcript by speaker.');
  const replies13 = (await novaOf(vera, 'assistant-reply')).length;
  await until(lineStart('s12a') - 800, 'the goodbye');
  cut('full', [V('vera')]);
  await until(lineEnd('s12a'), 'the end of the goodbye');
  const thanks = await waitFor(async () => (await novaOf(vera, 'assistant-reply')).slice(replies13)[0], 7000, 'a reply to the thanks').catch(() => null);
  note('scene 13 reply', { text: thanks?.message ?? null });
  await hold(thanks ? 3500 : 800);
  live.audio = (await sinkCounters()) ?? live.audio;
  note('sink counters', live.audio);
  await keepTranscript();
  await menu(vera, 'Dismiss Nova');
  novaIn = false;
  await vera.page.getByTestId('nova-left').waitFor({ timeout: 20000 });
  await readSpend();
  const link = vera.page.getByTestId('assistant-notice-meeting-link').last();
  await link.waitFor({ state: 'visible', timeout: 30000 });
  await hold(3500);
  await shotPng(vera, 's13a');
  await press(vera, link);
  await vera.page.getByTestId('meeting-page').waitFor({ timeout: 30000 });
  await vera.page.getByTestId('meeting-summary').waitFor({ timeout: 30000 });
  skip();
  following.delete(vera);
  await sleep(1500);
  await hidePrompt(vera);
  cut('full', [V('vera', 'meeting')]);
  await hold(4500);
  await shotPng(vera, 's13b');
  for (const id of ['meeting-proposals', 'meeting-action-items']) {
    const el = vera.page.getByTestId(id).first();
    if (await el.count()) { await el.evaluate((n) => n.scrollIntoView({ behavior: 'smooth', block: 'start' })); await hold(4000); }
  }
  await vera.page.getByText('By speaker').first().evaluate((n) => n.scrollIntoView({ behavior: 'smooth', block: 'start' })).catch(() => undefined);
  await hold(5000);
  await shotPng(vera, 's13c');
  await vera.page.mouse.move(500, 300);
  await vera.page.mouse.wheel(0, 300);
  await hold(3500);
  endScene();
  if (UNTIL <= 13) return;

  // ── 14. Who can see it, and deleting it ──
  layla = await person('layla', { call: false });
  beginScene(14, 'Who can see it', 'Layla was not in the call, so the meeting is not there for her. Vera deletes the record, and Nova\'s messages in the call chat are blanked.');
  cut('full', [V('layla', 'notfound')]);
  await layla.page.goto(`${PORTAL}/iq/meetings/${encodeURIComponent(callId)}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await layla.page.getByTestId('meeting-not-found').waitFor({ timeout: 30000 });
  await hold(4500);
  await shotPng(layla, 's14a');
  skip();
  await vera.page.getByTestId('meeting-actions').scrollIntoViewIfNeeded().catch(() => undefined);
  await sleep(800);
  await hidePrompt(vera);
  cut('full', [V('vera')]);
  await hold(1200);
  await press(vera, vera.page.getByTestId('meeting-actions')); // Delete is in the header's menu
  await press(vera, vera.page.getByTestId('meeting-delete'));
  const confirmDelete = vera.page.getByRole('button', { name: /Delete the record/ }).last();
  await confirmDelete.waitFor({ timeout: 15000 });
  await hold(3000);
  await press(vera, confirmDelete);
  await vera.page.waitForURL(/\/iq\/meetings$/, { timeout: 20000 });
  await hold(3000);
  await waitFor(async () => !/Answered privately/.test(await nora.page.getByTestId('huddle-thread').innerText()), 30000, 'Nova\'s words leaving Nora\'s chat').catch(() => undefined);
  cut('full', [V('nora', 'chat-end')]);
  await hold(6000);
  await shotPng(nora, 's14b');
  endScene();
  for (const p of [eli, nora, vera]) await p.page.getByTestId('call-dock-leave').first().click({ timeout: 5000 }).catch(() => undefined);
  await sleep(1500);
}

try {
  await (LIVE ? liveFilm() : scriptedFilm());
} catch (e) {
  exitCode = 1;
  console.error(`film: ${e instanceof FilmFailure ? e.message : e.stack}`);
  if (scene) { skip(); console.error(`  (in scene ${scene.n})`); }
} finally {
  clearInterval(follower);
  if (REAL_CALL && !LIVE) {
    timeline.cards = {
      close: { title: 'Nova', eyebrow: 'A real call through the local media server; Nova\'s side scripted on the mock world: fictional people and data, synthetic voices', text: 'Hears the call, answers in the chat or aloud, asks before it writes, notices what the team agrees, and leaves minutes only the people in the call can read.' },
    };
  }
  if (LIVE) {
    // Nova still in the call (a failure, or --until): dismissed, so nothing more is billed, and what it cost read back.
    if (novaIn && vera && callId) {
      novaIn = false;
      await keepTranscript().catch(() => undefined);
      live.audio = (await sinkCounters()) ?? live.audio;
      const r = await vera.api.post(asApi('dismiss')).catch(() => null);
      note('dismissed at the end', { status: r?.status() ?? null });
      await readSpend().catch(() => undefined);
    }
    // A second audio capture would restart that person's microphone file and break the schedule: counted for the record.
    for (const p of [vera, nora, eli].filter(Boolean)) {
      live.microphones[`${p.key}Captures`] = await p.page.evaluate(() => (window.__filmCaptures ?? []).map((c) => `${c.audio ? 'a' : ''}${c.video ? 'v' : ''}@${c.openedAt}`)).catch(() => null);
    }
    await new Promise((r) => novaAudio.end(r));
    timeline.live = live;
    timeline.cards = {
      open: { title: 'Nova in the meeting', eyebrow: 'Observability Platform · a live call with Vera, Nora and Eli', text: 'A real call through the local media server, with the live model as Nova: it hears everyone, answers when asked, acts only with consent, and leaves minutes behind.' },
      close: { title: 'Nova', eyebrow: 'Recorded live on the mock world: fictional people and data, synthetic voices', text: 'Hears the call, answers in the chat or aloud, asks before it writes, notices what the team agrees, and leaves minutes only the people in the call can read.' },
    };
  }
  // Each video's clock: its recorder writes frames until its page has finished closing, so its first frame was `duration` before
  // that. A page's video starts at its first painted frame, which trails the page's creation when the page waits blank (pages are
  // navigated at once for that reason); it never starts before the page existed.
  for (const p of [vera, nora, eli, layla].filter(Boolean)) {
    await p.page.close().catch(() => undefined);
    const closedAt = Date.now();
    await p.context.close().catch(() => undefined);
    const rec = timeline.videos[p.video];
    rec.file = p.videoPath ? path.relative(DIR, await p.videoPath) : null;
    if (!rec.file) continue;
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path.join(DIR, rec.file)]).toString().trim());
    const firstFrame = Math.round(closedAt - dur * 1000);
    rec.createdMs = rec.startMs;
    if (Number.isFinite(firstFrame) && firstFrame > rec.startMs && firstFrame <= rec.startMs + 10_000) rec.startMs = firstFrame;
    console.log(`  video ${p.video}: first frame ${rec.startMs - rec.createdMs} ms after the page was created`);
  }
  for (const b of ownBrowsers) await b.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  stopAll();
}
if (pageErrors.length) console.log(`page errors: ${pageErrors.slice(0, 5).join(' | ')}`);
// Each shot's span on each video it shows, in ms from that video's first frame.
for (const s of timeline.scenes) for (const sh of s.shots) {
  sh.onVideo = Object.fromEntries(sh.views.map(({ v }) => [v, [sh.from - timeline.videos[v].startMs, sh.to - timeline.videos[v].startMs]]));
}
fs.writeFileSync(path.join(DIR, 'timeline.json'), JSON.stringify(timeline, null, 2));
console.log(`film: timeline written (${timeline.scenes.length} scenes, ${timeline.speech.length} spoken clips)`);
if (exitCode || args.includes('--record-only')) process.exit(exitCode);
process.exit(await compose());
