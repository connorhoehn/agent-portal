#!/usr/bin/env node
// A stand-in for the media server's per-participant taps (live-video-streaming `webhook-pcm`, `perParticipant: true`), for the meeting
// assistant's PCM sink (middleware/src/routes/meeting-assistant-sink.ts). It posts what the real taps post, and nothing else:
//
//   POST <base>/api/internal/meeting-assistant/pcm/<sink token>      application/octet-stream, 200 ms of 16 kHz mono s16le PCM
//   X-Tap-Id  X-Channel-Arn  X-Participant-Id  X-Producer-Id  X-Sample-Rate: 16000  X-Encoding: pcm_s16le  X-Channels: 1
//
// Like a tap it is fire and forget: each chunk is posted without waiting for the one before, the answer is only counted, and a
// 404 (a dead token) does not stop it. Chunks go out at real-time pace, one every 200 ms per speaker, from each entry's `atMs`.
//
//   node scripts/meeting-assistant/tap-sim.mjs --base http://127.0.0.1:3953 --token <sink token> --channel <arn> --timeline timeline.json
//     timeline.json: [ { "participantId": "u-vera-lq1", "wav": "vera-1.wav", "atMs": 0 }, ... ]   (wav paths relative to the timeline file;
//                    16-bit PCM, any rate or channel count: it is mixed down and resampled to 16 kHz mono here)
//     --speed 1   pace multiplier (1 = real time); --quiet
//
// Audio is read from the WAV files you name and sent to the address you name. Nothing is written, and the token is never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CHUNK_MS = 200;
const RATE = 16_000;
const CHUNK_SAMPLES = (RATE * CHUNK_MS) / 1000;

/** 16-bit PCM WAV -> Int16Array of 16 kHz mono samples. */
export function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV file`);
  let fmt = null, data = null;
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString('ascii', at, at + 4), size = b.readUInt32LE(at + 4), body = at + 8;
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') { data = b.subarray(body, Math.min(b.length, body + size)); break; }
    at = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file}: no fmt or data chunk`);
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`${file}: need 16-bit PCM (got format ${fmt.format}, ${fmt.bits} bits)`);
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) { let sum = 0; for (let c = 0; c < fmt.channels; c += 1) sum += data.readInt16LE((i * fmt.channels + c) * 2); mono[i] = sum / fmt.channels; }
  if (fmt.rate === RATE) return Int16Array.from(mono, Math.round);
  const out = new Int16Array(Math.floor((frames * RATE) / fmt.rate));
  const step = fmt.rate / RATE;
  for (let j = 0; j < out.length; j += 1) {
    const x = j * step, i = Math.floor(x), f = x - i;
    out[j] = Math.round(mono[i] * (1 - f) + (mono[Math.min(i + 1, frames - 1)] ?? 0) * f);
  }
  return out;
}

const toPcm = (samples) => { const b = Buffer.allocUnsafe(samples.length * 2); samples.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };

/**
 * Play the timeline against a sink. Resolves with counts once the last chunk's answer is in:
 * { sent, answers: { '204': n, '404': n, ... }, failed }. `fetchImpl` and `now`/`sleep` are injectable for tests.
 */
export async function runTapSim({ base, token, channel, timeline, dir = '.', speed = 1, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => performance.now(), onChunk } = {}) {
  if (!base || !token || !channel || !Array.isArray(timeline)) throw new Error('base, token, channel and timeline are required');
  const url = `${String(base).replace(/\/+$/, '')}/api/internal/meeting-assistant/pcm/${encodeURIComponent(token)}`;
  const plan = [];
  for (const entry of timeline) {
    const samples = readWav(path.resolve(dir, entry.wav));
    for (let i = 0, k = 0; i < samples.length; i += CHUNK_SAMPLES, k += 1) {
      const part = samples.subarray(i, i + CHUNK_SAMPLES);
      plan.push({ at: (entry.atMs ?? 0) + k * CHUNK_MS, participantId: entry.participantId, pcm: toPcm(part) });
    }
  }
  plan.sort((a, b) => a.at - b.at);
  const answers = {}; let sent = 0, failed = 0;
  const pending = [];
  const t0 = now();
  for (const chunk of plan) {
    const wait = chunk.at / speed - (now() - t0);
    if (wait > 0) await sleep(wait);
    sent += 1;
    onChunk?.(chunk.participantId, chunk.at);
    pending.push(fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream', 'X-Tap-Id': 'tap-sim', 'X-Channel-Arn': channel, 'X-Participant-Id': chunk.participantId,
        'X-Producer-Id': `producer-${chunk.participantId}`, 'X-Sample-Rate': String(RATE), 'X-Encoding': 'pcm_s16le', 'X-Channels': '1',
      },
      body: chunk.pcm,
    }).then(async (res) => { await res.arrayBuffer().catch(() => undefined); answers[res.status] = (answers[res.status] ?? 0) + 1; }, () => { failed += 1; }));
  }
  await Promise.all(pending);
  return { sent, answers, failed };
}

// ── command line ──
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href || process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const timelineFile = flag('--timeline');
  const base = flag('--base') ?? 'http://127.0.0.1:3953';
  const token = flag('--token') ?? process.env.TAP_SIM_TOKEN;
  const channel = flag('--channel');
  if (!timelineFile || !token || !channel) {
    console.error('usage: tap-sim.mjs --base <url> --token <sink token> --channel <arn> --timeline <timeline.json> [--speed 1]  (the token may come from TAP_SIM_TOKEN)');
    process.exit(2);
  }
  const timeline = JSON.parse(fs.readFileSync(timelineFile, 'utf8'));
  const speed = Number(flag('--speed') ?? '1') || 1;
  const result = await runTapSim({ base, token, channel, timeline, dir: path.dirname(path.resolve(timelineFile)), speed });
  console.log(`tap-sim: sent ${result.sent} chunks; answers ${JSON.stringify(result.answers)}; failed ${result.failed}`);
  process.exit(result.failed ? 1 : 0);
}
