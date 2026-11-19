#!/usr/bin/env -S npx tsx
// The hands-free voice gate. Plays the plan's scenario set and scores it against the plan's thresholds (gate-spec.mts).
//
//   cd middleware && npx tsx ../scripts/voice-harness/gate.mts --driver fake                         scripted, no key, instant
//   cd middleware && npx tsx ../scripts/voice-harness/gate.mts --driver direct --clips <dir> --env-file <path> --out <rows.jsonl>
//        [--only id,id] [--ledger <spend.json>] [--cap 1] [--yes]                                     live, probe-style baseline
//   cd middleware && npx tsx ../scripts/voice-harness/gate.mts --driver runtime --clips <dir> --env-file <path> --require-all --yes
//                                                                                                     live, the real HandsfreeRun
// Drivers: fake = gate-port-fake.mts (the plan's ideal behaviour; proves the harness); direct = gate-port-direct.mts (one Live
// session + a transcription stream per person + a small router: the BASELINE the runtime must beat); runtime = gate-port-runtime.mts.
// Without --yes a live run only prints its plan and cost estimate. The cost is about $0.7 a full direct run (one live session
// per scenario at $0.05/min plus $0.017/min per transcribed person); --cap (default 1 USD) refuses to start past the ledger.
// Exit code: 0 = gate ok, 1 = a check failed (or, with --require-all, was skipped), 2 = could not run.
// Clips: make-clips.py from lines.json (24 kHz PCM16 WAV + clips.json), kept outside the repo; Milo's audio is never kept.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { realClock, virtualClock } from './gate-clock.mjs';
import { playScenario, type GatePort } from './gate-player.mjs';
import { fakePort } from './gate-port-fake.mjs';
import { formatChecks, gateScenarios, scoreGate, type RunObs, type ScenarioSpec } from './gate-spec.mjs';

const args = process.argv.slice(2);
const opt = (n: string, d = ''): string => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? d) : d; };
const flag = (n: string): boolean => args.includes(n);
const driver = opt('--driver', 'fake');
const USD_LIVE = 0.05; const USD_TX = 0.017; // middleware/src/lib/voice/config.ts; gpt-live-transcribe model page
const INSTRUCTIONS = [
  'You are Milo, a voice assistant listening in on a meeting.',
  'Answer only when someone speaks to you by name, or asks a follow-up question right after you answered them.',
  'Answer in one short sentence. When people talk to each other, stay silent.',
].join(' ');

interface Ledger { liveSeconds: number; transcribeSeconds: number; runs: Array<Record<string, unknown>> }
const ledgerPath = opt('--ledger');
const readLedger = (): Ledger => (ledgerPath && existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger : { liveSeconds: 0, transcribeSeconds: 0, runs: [] });
const spentUsd = (l: Ledger): number => (l.liveSeconds / 60) * USD_LIVE + (l.transcribeSeconds / 60) * USD_TX;

function planSeconds(sc: ScenarioSpec, clipSeconds: (id: string) => number): number {
  return sc.steps.reduce((a, s) => a + s.gapMs / 1000 + (s.clip ? clipSeconds(s.clip) : 0) + (s.expect === 'silent' ? 0.5 : 4), 4);
}

async function main(): Promise<number> {
  const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
  const scenarios = gateScenarios().filter((s) => !only || only.has(s.id));
  if (scenarios.length === 0) throw new Error('no scenario matches --only');
  const out = opt('--out');
  const row = (r: Record<string, unknown>): void => { if (out) writeFileSync(out, JSON.stringify(r) + '\n', { flag: 'a' }); };
  const runs: RunObs[] = [];

  if (driver === 'fake') {
    for (const sc of scenarios) {
      const clips: Record<string, Buffer> = {};
      for (const s of sc.steps) if (s.clip) clips[s.clip] = Buffer.alloc(4_800 * 20);
      runs.push(await playScenario(sc, fakePort(), { clips, clock: virtualClock(), instructions: INSTRUCTIONS }));
    }
  } else if (driver === 'direct' || driver === 'runtime') {
    const clipsDir = opt('--clips'); const envFile = opt('--env-file');
    if (!clipsDir || !envFile) throw new Error('--clips and --env-file are needed for a live driver');
    const index = JSON.parse(readFileSync(`${clipsDir}/clips.json`, 'utf8')) as Record<string, { seconds: number }>;
    const missing = [...new Set(scenarios.flatMap((s) => s.steps.flatMap((x) => (x.clip && !index[x.clip] ? [x.clip] : []))))];
    if (missing.length > 0) throw new Error(`clips missing in ${clipsDir}: ${missing.join(', ')} (run make-clips.py)`);
    const runnable = scenarios.filter((s) => !(driver === 'direct' && s.runtimeOnly));
    const estimate = runnable.reduce((a, s) => a + (planSeconds(s, (id) => index[id]!.seconds) / 60) * (USD_LIVE + USD_TX * s.speakers.length), 0);
    const before = readLedger(); const cap = Number(opt('--cap', '1'));
    console.log(`gate ${driver}: ${runnable.length} scenarios, estimate $${estimate.toFixed(2)}; spent so far $${spentUsd(before).toFixed(2)} of $${cap}`);
    if (spentUsd(before) + estimate > cap) { console.log('CAP: refusing to start'); return 2; }
    if (!flag('--yes')) { console.log('dry: pass --yes to run'); return 2; }
    const { readWav } = await import('./lib.mjs');
    for (const sc of scenarios) {
      if (driver === 'direct' && sc.runtimeOnly) {
        runs.push({ scenario: sc.id, steps: sc.steps.map((s, i) => emptyStep(i, s)), skipped: 'needs the runtime (rules, admission, fixed lines)', errors: [] });
        continue;
      }
      const clips: Record<string, Buffer> = {};
      for (const s of sc.steps) if (s.clip) clips[s.clip] ??= readWav(`${clipsDir}/${s.clip}.wav`);
      let port: GatePort;
      try {
        if (driver === 'direct') port = (await import('./gate-port-direct.mjs')).directPort({ envFile });
        else port = await (await import('./gate-port-runtime.mjs')).runtimePort({ envFile });
      } catch (e) {
        runs.push({ scenario: sc.id, steps: sc.steps.map((s, i) => emptyStep(i, s)), skipped: (e as Error).message, errors: [] });
        continue;
      }
      console.log(`running ${sc.id} (${sc.steps.length} steps)...`);
      const r = await playScenario(sc, port, { clips, clock: realClock, instructions: INSTRUCTIONS, maxMs: 300_000 });
      runs.push(r);
      const l = readLedger(); l.liveSeconds += r.billedLiveSeconds ?? 0; l.transcribeSeconds += r.txSeconds ?? 0; l.runs.push({ gate: sc.id, driver, live: r.billedLiveSeconds, tx: r.txSeconds, at: new Date().toISOString() });
      if (ledgerPath) writeFileSync(ledgerPath, JSON.stringify(l, null, 1));
    }
  } else throw new Error(`unknown driver ${driver}`);

  for (const r of runs) {
    for (const s of r.steps) row({ k: 'step', driver, scenario: r.scenario, ...s });
    if (r.errors.length) row({ k: 'errors', scenario: r.scenario, errors: r.errors });
  }
  const res = scoreGate(runs, { requireAll: flag('--require-all') });
  for (const c of res.checks) row({ k: 'check', driver, ...c });
  row({ k: 'summary', driver, pass: res.pass, fail: res.fail, skipped: res.skipped, ok: res.ok, spentUsd: Number(spentUsd(readLedger()).toFixed(3)) });
  console.log(formatChecks(res));
  for (const r of runs) if (r.errors.length) console.log(`${r.scenario}: ${r.errors.slice(0, 3).join(' | ')}`);
  return res.ok ? 0 : 1;
}

function emptyStep(i: number, s: ScenarioSpec['steps'][number]): RunObs['steps'][number] {
  return { i, clip: s.clip, speaker: s.speaker, expect: s.expect, speechEndMs: null, firstVoiceMs: null, lastVoiceMs: null, fixedVoice: false, strayRuns: 0, routed: {}, mixed: false, text: '', toolCalls: [], relaySilentMs: null, triggers: 0, noReply: false, ...(s.barge ? { barge: s.barge } : {}) };
}

main().then((code) => process.exit(code), (e: Error) => { console.error('FAILED', e.message); process.exit(2); });
