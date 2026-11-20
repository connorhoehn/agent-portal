// Milo rebuild probe: measures the target design's latency and tool-choice accuracy (audit 2026-11-19, section 4).
//   our transcription final  ->  ONE text-model call with function calling  ->  TTS of exactly the logged line
//
// Modes (run from middleware/ with npx tsx ../scripts/milo-probe/probe.mts <mode> ...):
//   text  --env <file> [--models a,b] [--reps n]   decide latency (b) and tool-choice accuracy (f), no audio
//   tts   --env <file> [--reps n]                  TTS time to first audio byte (c); bytes counted, never kept
//   live  --env <file> --clips <dir> --model m --tts m:voice [--per n]
//                                                  clips streamed in real time into the production transcriber (a),
//                                                  then decide + TTS (d), plus a decide on the provisional deltas (e)
// Output: JSON lines on stdout (timings, choices, transcripts of the input clips only). No key, no audio is ever written.
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { loadKey, readWav, pct, sleep } from '../voice-harness/lib.mts';
import { openOpenAiTranscriber, SegmentVad } from '../../middleware/src/lib/voice/openai-transcribe.ts';

const now = (): number => performance.now();
const args = process.argv.slice(2);
const mode = args[0];
const opt = (k: string, d = ''): string => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1]! : d; };
loadKey(opt('env'));
const BASE = 'https://api.openai.com/v1';
const auth = (): Record<string, string> => ({ Authorization: `Bearer ${process.env['OPENAI_API_KEY']}`, 'Content-Type': 'application/json' });
const out = (row: Record<string, unknown>): void => { process.stdout.write(JSON.stringify(row) + '\n'); };

// ---------- Decide: one streaming text call with tools ----------
type Role = 'candidate' | 'interviewer' | 'work';
const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const T = {
  time_left: fn('time_left', 'Say how much interview time is left (the server reads the clock).'),
  repeat_question: fn('repeat_question', 'Read the current interview question out again, word for word.'),
  introduce: fn('introduce', 'Milo introduces himself to the candidate (fixed text).'),
  pad_write: fn('pad_write', 'Change the shared code pad: add or edit code, test cases or notes.', { instruction: { type: 'string', description: 'What to change, in the asker\'s words.' } }, ['instruction']),
  stay_silent: fn('stay_silent', 'Say nothing: the speaker was not asking Milo for anything (talking about Milo, to someone else, thanking, or closing).'),
  cannot_help: fn('cannot_help', 'Politely decline: the request is not something this person may ask Milo for.'),
};
export const TOOLS: Record<Role, unknown[]> = {
  candidate: [T.time_left, T.repeat_question, T.stay_silent, T.cannot_help],
  interviewer: [T.time_left, T.repeat_question, T.introduce, T.pad_write, T.stay_silent, T.cannot_help],
  work: [T.time_left, T.pad_write, T.stay_silent],
};
const SYSTEM: Record<Role, string> = {
  candidate: 'You are Milo, a voice assistant in a technical interview. The speaker is the CANDIDATE. Pick exactly one tool. '
    + 'A candidate may only ask for the time left or for the question again; anything else addressed to you is cannot_help; '
    + 'if they are not asking you for anything, stay_silent.',
  interviewer: 'You are Milo, a voice assistant in a technical interview. The speaker is an INTERVIEWER. Pick exactly one tool '
    + 'for what they want from you. If they are not asking you for anything (talking about you, to someone else, thanking, '
    + 'or closing), stay_silent.',
  work: 'You are Milo, a voice assistant in a work meeting. If the speaker wants an action, call the tool. If they ask a '
    + 'question, answer in one short spoken sentence, no markdown. If they are not asking you anything, call stay_silent.',
};

interface Decision { model: string; tool: string | null; args: string; text: string; firstMs: number | null; doneMs: number; error?: string }

const REASONING: Record<string, string> = {};
function bodyFor(model: string, role: Role, sentence: string, context: string[]): Record<string, unknown> {
  const user = `${context.length ? `Recent lines:\n${context.join('\n')}\n\n` : ''}Speaker (${role === 'candidate' ? 'candidate' : 'interviewer'}): "${sentence}"`;
  const b: Record<string, unknown> = {
    model, stream: true, messages: [{ role: 'system', content: SYSTEM[role] }, { role: 'user', content: user }],
    tools: TOOLS[role], tool_choice: role === 'work' ? 'auto' : 'required', parallel_tool_calls: false,
  };
  if (/^(gpt-5|gpt-6|o\d)/.test(model)) { b['reasoning_effort'] = REASONING[model] ?? 'none'; b['max_completion_tokens'] = 400; } else b['max_tokens'] = 80;
  return b;
}

export async function decide(model: string, role: Role, sentence: string, context: string[] = []): Promise<Decision> {
  const t0 = now();
  let res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: auth(), body: JSON.stringify(bodyFor(model, role, sentence, context)) });
  if (res.status === 400 && /^(gpt-5|gpt-6|o\d)/.test(model) && !REASONING[model]) {
    const msg = await res.text();
    if (/reasoning_effort/.test(msg)) { REASONING[model] = 'minimal'; return decide(model, role, sentence, context); }
    return { model, tool: null, args: '', text: '', firstMs: null, doneMs: now() - t0, error: msg.slice(0, 160) };
  }
  if (!res.ok || !res.body) return { model, tool: null, args: '', text: '', firstMs: null, doneMs: now() - t0, error: `${res.status} ${(await res.text()).slice(0, 160)}` };
  let tool: string | null = null; let argsS = ''; let text = ''; let firstMs: number | null = null;
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (data === '[DONE]') continue;
      let e: any; try { e = JSON.parse(data); } catch { continue; }
      const d = e.choices?.[0]?.delta; if (!d) continue;
      const tc = d.tool_calls?.[0];
      if (tc?.function?.name && !tool) { tool = tc.function.name; firstMs ??= now() - t0; }
      if (tc?.function?.arguments) argsS += tc.function.arguments;
      if (typeof d.content === 'string' && d.content) { text += d.content; firstMs ??= now() - t0; }
    }
  }
  return { model, tool, args: argsS, text, firstMs, doneMs: now() - t0 };
}

// ---------- Speak: streaming TTS, time to first audio byte ----------
export async function ttsFirstByte(spec: string, text: string): Promise<{ firstMs: number | null; doneMs: number; bytes: number; error?: string }> {
  const [model, voice] = spec.split(':');
  const t0 = now();
  const body: Record<string, unknown> = { model, voice, input: text, response_format: 'pcm' };
  if (model === 'gpt-4o-mini-tts' || model?.startsWith('gpt-4o-mini-tts')) body['stream_format'] = 'audio';
  const res = await fetch(`${BASE}/audio/speech`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });
  if (!res.ok || !res.body) return { firstMs: null, doneMs: now() - t0, bytes: 0, error: `${res.status} ${(await res.text()).slice(0, 160)}` };
  let firstMs: number | null = null; let bytes = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) { if (c.length && firstMs === null) firstMs = now() - t0; bytes += c.length; } // counted, discarded
  return { firstMs, doneMs: now() - t0, bytes };
}

// The server's line for a tool (what TTS would speak).
const LINE: Record<string, string> = {
  time_left: 'You have about twelve minutes left.',
  repeat_question: 'The question is: design a rate limiter for a public API.',
  introduce: 'Hi, I am Milo, the panel\'s AI support. I keep time and take notes.',
  pad_write: 'Done, I updated the pad.',
  cannot_help: 'Sorry, I can only tell you the time left or repeat the question.',
};

// ---------- (f) the audit's phrasings, with the right action ----------
const FOLLOW_CTX = ['Hugo (interviewer): Milo, add five test cases to the pad.', 'Milo: Done, I added five test cases.'];
type Case = { s: string; role: Role; ok: string[]; group: string; ctx?: string[] };
export const CASES: Case[] = [
  ...['Milo, how much time is left?', 'Milo, how many minutes do I have?', 'Hey Milo, what time is it?', 'Milo, how long until we finish?',
    'Milo, am I running out of time?', 'Do we have much time left, Milo?', 'Milo, how are we doing for time, roughly?',
    "Milo, what's the time remaining?", 'Milo, how much longer do I have?', 'Before I start drawing, roughly how much time is left, Milo?']
    .map((s) => ({ s, role: 'candidate' as Role, ok: ['time_left'], group: 'candidate time (10)' })),
  ...['Milo, can you read the question again?', 'Milo, what was the prompt again?', 'Milo, could you remind me what the question was?',
    'Milo, one more time please, the question?', 'Sorry Milo, I missed that, what am I supposed to design?']
    .map((s) => ({ s, role: 'candidate' as Role, ok: ['repeat_question'], group: 'candidate repeat (5)' })),
  ...['Milo, please introduce yourself to Mateo.', 'Milo, go ahead and introduce yourself.', 'Milo, say hi to Mateo.',
    'Milo, would you mind introducing yourself?', 'Milo, tell Mateo what you do.']
    .map((s) => ({ s, role: 'interviewer' as Role, ok: ['introduce'], group: 'lead intro (5)' })),
  { s: 'I liked how Milo kept time.', role: 'interviewer', ok: ['stay_silent'], group: 'mention vs address (5)' },
  { s: 'Milo should be able to help with that.', role: 'interviewer', ok: ['stay_silent'], group: 'mention vs address (5)' },
  { s: 'Milo will you add twelve test cases?', role: 'interviewer', ok: ['pad_write'], group: 'mention vs address (5)' },
  { s: 'Okay Milo thanks, that is enough.', role: 'interviewer', ok: ['stay_silent'], group: 'mention vs address (5)' },
  { s: 'Milo what do you think we have left?', role: 'interviewer', ok: ['time_left'], group: 'mention vs address (5)' },
  ...([
    ['Great. And can you read out the question once more?', ['repeat_question']],
    ['And how long is left now?', ['time_left']],
    ['Thanks. One more thing, add an import for heapq.', ['pad_write']],
    ["I'd also like twelve more test cases.", ['pad_write']],
    ['Perfect, same again but in Python.', ['pad_write']],
    ['Hmm, maybe make that five.', ['pad_write']],
    ['Mateo, go ahead.', ['stay_silent']],
    ["Let's move on.", ['stay_silent']],
    ['Actually scratch that.', ['pad_write', 'stay_silent']],
    ['You can stop there.', ['stay_silent']],
    ["That's enough, thank you.", ['stay_silent']],
    ['I think we need a few more of those.', ['pad_write']],
  ] as Array<[string, string[]]>).map(([s, ok]) => ({ s, role: 'interviewer' as Role, ok, group: 'follow-up, no name (12)', ctx: FOLLOW_CTX })),
  ...["Milo, what's the capital of Italy?", 'Milo, add a note that I prefer working in Python.', 'Can you remind me what a linked list is, Milo?',
    "What's the time complexity of binary search, Milo?", 'Milo, just tell me if my answer is right.']
    .map((s) => ({ s, role: 'candidate' as Role, ok: ['cannot_help'], group: 'candidate off-limits (5)' })),
];

async function textMode(): Promise<void> {
  const models = opt('models', 'gpt-4.1-mini,gpt-4o-mini,gpt-5.4-nano,gpt-5.4-mini,gpt-5-nano,gpt-5.6-luna,gpt-6-luna').split(',');
  const reps = Number(opt('reps', '1'));
  for (const m of models) {
    const w = await decide(m, 'candidate', 'Milo, how much time is left?'); // warm the connection
    if (w.error) { out({ kind: 'text', model: m, error: w.error }); continue; }
    for (let r = 0; r < reps; r += 1) for (const c of CASES) {
      const d = await decide(m, c.role, c.s, c.ctx ?? []);
      out({ kind: 'text', model: m, group: c.group, s: c.s, ok: c.ok.includes(d.tool ?? ''), tool: d.tool, args: d.args.slice(0, 80), firstMs: Math.round(d.firstMs ?? -1), doneMs: Math.round(d.doneMs), error: d.error });
    }
    // free-answer path (work policy, text allowed)
    for (const q of ["Milo, what's the capital of France?", 'Milo, how many legs does a spider have?', 'Milo, what does CPU stand for?', "Milo, what's seven times eight?", 'Milo, which planet is closest to the sun?']) {
      const d = await decide(m, 'work', q);
      out({ kind: 'text-free', model: m, s: q, tool: d.tool, text: d.text.slice(0, 120), firstMs: Math.round(d.firstMs ?? -1), doneMs: Math.round(d.doneMs), error: d.error });
    }
  }
}

async function ttsMode(): Promise<void> {
  const specs = opt('specs', 'tts-1:alloy,tts-1-hd:alloy,gpt-4o-mini-tts:alloy,gpt-4o-mini-tts:cedar').split(',');
  const reps = Number(opt('reps', '20'));
  for (const s of specs) {
    await ttsFirstByte(s, 'Warm up.');
    for (let r = 0; r < reps; r += 1) {
      const x = await ttsFirstByte(s, LINE['time_left']!);
      out({ kind: 'tts', spec: s, firstMs: Math.round(x.firstMs ?? -1), doneMs: Math.round(x.doneMs), bytes: x.bytes, error: x.error });
    }
  }
}

// ---------- live: clips in real time through the production transcriber ----------
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
async function liveMode(): Promise<void> {
  const dir = opt('clips'); const model = opt('model', 'gpt-4.1-mini'); const ttsSpec = opt('tts', 'gpt-4o-mini-tts:alloy');
  const per = Number(opt('per', '20'));
  const meta = JSON.parse(readFileSync(`${dir}/clips.json`, 'utf8')) as Record<string, { who: string; text: string }>;
  const pick = (ids: string[]): string[] => Array.from({ length: per }, (_, i) => ids[i % ids.length]!);
  const cases: Array<{ id: string; case: string; role: Role }> = [
    ...pick(['iv01', 'cf04', 'cf05', 'ct01', 'ct02', 'ct03', 'cf01', 'cf03']).map((id) => ({ id, case: 'server line (time left)', role: 'interviewer' as Role })),
    ...pick(['q01', 'q03', 'q04', 'q05', 'q06', 'q07', 'q08', 'q09', 'q10', 'q12', 'q13', 'q14', 'q15', 'q16', 'q17', 'q18', 'q19', 'q20', 'q21', 'q22']).map((id) => ({ id, case: 'free answer', role: 'work' as Role })),
    ...pick(['ct01', 'ct02', 'ct03', 'cf01', 'cf03', 'h04', 'cr01', 'cr02', 'qc01', 't02', 'n03', 'n05']).map((id) => ({ id, case: 'candidate forced choice', role: 'candidate' as Role })),
  ];
  let commitAt: number | null = null;
  const tr = await openOpenAiTranscriber({ keywords: ['Milo'], log: (r) => { if (r['event'] === 'transcribe-commit') commitAt = now(); } });
  let deltas = ''; let lastDeltaAt = 0; let final: { text: string; at: number } | null = null;
  tr.on('delta', (e: any) => { deltas += e.delta; lastDeltaAt = now(); });
  tr.on('final', (e: any) => { final = { text: e.text, at: now() }; });
  await decide(model, 'candidate', 'Milo, how much time is left?'); await ttsFirstByte(ttsSpec, 'Warm up.');
  const silence = Buffer.alloc(48 * 20);
  for (const c of cases) {
    const pcm = readWav(`${dir}/${c.id}.wav`);
    // speech end in clip ms, by the same check the stream uses
    const v = new SegmentVad(600, 15_000); const segs = [...v.push(pcm), ...v.push(Buffer.alloc(48 * 1200))];
    const endMs = segs.length ? segs[segs.length - 1]![1] : pcm.length / 48;
    deltas = ''; final = null; commitAt = null; lastDeltaAt = 0;
    const snaps: Record<string, string> = {};
    const t0 = now(); const frames = Math.ceil(pcm.length / 960);
    let provisional: Promise<{ d: Decision; startAt: number; text: string }> | null = null;
    for (let k = 0; k < frames + 75; k += 1) { // clip + 1.5 s of quiet, 20 ms frames in real time
      await sleep(t0 + (k + 1) * 20 - now());
      tr.append(k < frames ? pcm.subarray(k * 960, Math.min(pcm.length, (k + 1) * 960)) : silence);
      const tms = (k + 1) * 20;
      for (const off of [0, 300]) if (tms === Math.ceil((endMs + off) / 20) * 20) snaps[`at+${off}`] = deltas;
      if (commitAt !== null && !provisional) { const text = deltas; const startAt = now(); provisional = decide(model, c.role, text).then((d) => ({ d, startAt, text })); }
    }
    const speechEnd = t0 + endMs;
    const deadline = now() + 6000; while (!final && now() < deadline) await sleep(10);
    const fin = final as { text: string; at: number } | null;
    if (!fin) { out({ kind: 'live', id: c.id, case: c.case, error: 'no final' }); continue; }
    const d = await decide(model, c.role, fin.text);
    const decidedAt = fin.at + (d.doneMs);
    const line = d.tool ? LINE[d.tool] ?? '' : d.text;
    let ttsFirst: number | null = null;
    if (line && d.tool !== 'stay_silent') { const tt = await ttsFirstByte(ttsSpec, line); ttsFirst = tt.firstMs; }
    const p = provisional ? await provisional : null;
    out({
      kind: 'live', id: c.id, case: c.case, said: meta[c.id]?.text, heard: fin.text,
      finalMs: Math.round(fin.at - speechEnd), commitMs: commitAt !== null ? Math.round((commitAt as number) - speechEnd) : null,
      lastDeltaMs: lastDeltaAt ? Math.round(lastDeltaAt - speechEnd) : null,
      deltasEqFinalAtEnd: norm(snaps['at+0'] ?? '') === norm(fin.text), deltasEqFinalAt300: norm(snaps['at+300'] ?? '') === norm(fin.text),
      deltasEqFinalAtCommit: p ? norm(p.text) === norm(fin.text) : null,
      tool: d.tool, decideFirstMs: Math.round(d.firstMs ?? -1), decideDoneMs: Math.round(d.doneMs), ttsFirstMs: ttsFirst === null ? null : Math.round(ttsFirst),
      totalMs: ttsFirst === null ? null : Math.round(decidedAt + ttsFirst - speechEnd),
      provTool: p?.d.tool ?? null, provSame: p ? p.d.tool === d.tool : null,
      provTotalMs: p && ttsFirst !== null ? Math.round(p.startAt + p.d.doneMs + ttsFirst - speechEnd) : null,
    });
    await sleep(300);
  }
  await tr.close();
}

if (mode === 'text') await textMode();
else if (mode === 'tts') await ttsMode();
else if (mode === 'live') await liveMode();
else { console.error('mode: text | tts | live'); process.exit(2); }
export { pct };
