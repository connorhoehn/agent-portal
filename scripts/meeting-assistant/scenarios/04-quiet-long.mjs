// quiet-long: ten minutes (--minutes) of ordinary meeting talk among three people, about 80 lines, nobody asking Nova anything. The
// lines include the word without a request (a story about asking Nova, a place called Nova Scotia at the start of a sentence, the word
// "innovation", a colleague named Nora being asked a question). Voice is on. Nova must say nothing, call no tool and relay no voice;
// attribution is measured line by line; one addressed request at the end is answered.
// The fake provider also makes two UNPROMPTED remarks during the quiet part (voice first, as the real one did): the voice gate must
// withhold both. The final request is answered in the real provider's order (the answer's first frame before the request's own
// transcript), so the gate's hold must cover it, and the answer is still heard.
import { synth, msOf, findAllSaid, PEOPLE } from '../lib/harness.mjs';

const TOPICS = ['the reminder emails', 'the calendar sync', 'the onboarding checklist', 'the invite links', 'the time zone picker', 'the mobile layout', 'the sign-in page', 'the weekly digest', 'the search filters', 'the export to spreadsheets', 'the dark theme', 'the release notes'];
const TEMPLATES = [
  (t) => `I think ${t} is in decent shape for the next release.`,
  (t) => `Did anyone test ${t} on the older phones?`,
  (t) => `We still owe the team a short note about ${t}.`,
  (t) => `Honestly ${t} feels slower than it did last week.`,
  (t) => `Let me check what the support queue says about ${t}.`,
  (t) => `The customers who asked for ${t} will be pleased.`,
];
// Lines that use the word without addressing Nova, each placed once in a while.
const TRICKY = [
  'I asked Nova about it yesterday and the answer was a bit long.',
  'Nova Scotia has the best lobster I have ever eaten.',
  'Our innovation week starts on Monday, so keep the afternoon free.',
  'Nora, what do you think about the reminder wording?',
  'My cousin said Nova is a nice name for a cat.',
  'Honestly the innovation budget is smaller than last quarter.',
  'Nora, can you share the notes from the last review?',
  'We talked about Nova yesterday but nobody wrote it down.',
];
const WHO = ['vera', 'nora', 'mia'];

function lines(count) {
  const base = [];
  for (let i = 0; i < 80; i += 1) {
    if (i % 10 === 3) base.push({ text: TRICKY[(i - 3) / 10], tricky: true });
    else base.push({ text: TEMPLATES[i % TEMPLATES.length](TOPICS[(i * 5) % TOPICS.length]) });
  }
  // A short run samples the long one evenly (offset 3, so the tricky lines are the ones kept).
  const picked = count >= 80 ? base : Array.from({ length: count }, (_, k) => base[Math.min(79, Math.floor((k * 80) / count) + 3)]);
  return picked.map((l, i) => ({ ...l, who: WHO[(i * 7 + (l.text.startsWith('Nora,') ? 1 : 0)) % 3] }))
    // A person asked a question is answered by someone else: the speaker of "Nora, ..." is never Nora.
    .map((l) => (l.text.startsWith('Nora,') && l.who === 'nora' ? { ...l, who: 'mia' } : l));
}

export default {
  order: 4, id: 'quiet-long',
  limitSeconds: ({ minutes } = {}) => Math.round((minutes ?? 10) * 60) + 90,
  title: 'ten quiet minutes: nothing from Nova, attribution measured, one request at the end answered',
  async run(ctx) {
    const { r } = ctx;
    const minutes = ctx.minutes ?? 10;
    // Speech is made BEFORE Nova is invited: making eighty lines takes minutes, and Nova's listening ceiling (the scenario's limit)
    // runs from the invite, so making them after it left Nova at its ceiling before the final request (paid run, 14 November).
    const plan = lines(Math.max(4, Math.round(8 * minutes)));
    const synthed = plan.map((l) => ({ ...l, ms: msOf(synth(l.text, { voice: PEOPLE[l.who].voice, dir: ctx.world.dir }).pcm) }));
    synth('Nova, what is two plus two?', { voice: PEOPLE.vera.voice, dir: ctx.world.dir });
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'], voice: true });
    for (const k of WHO) ctx.lane(k);
    const talk = synthed.reduce((n, l) => n + l.ms, 0);
    const budgetMs = Math.max(0, minutes * 60_000 - 20_000 - talk);
    const gap = Math.max(1300, Math.round(budgetMs / synthed.length));
    ctx.at(500);
    // Two ordinary lines (a third and two thirds of the way in) after which the model speaks though nobody asked it to.
    const remarkAt = new Set([Math.floor(synthed.length / 3), Math.floor((2 * synthed.length) / 3)]);
    const REMARKS = [{ text: 'That sounds like a sensible plan to me.', frames: 15 }, { text: 'I can help with that whenever you are ready, just let me know.', frames: 25 }];
    const placed = synthed.map((l, i) => ({ ...l, ev: ctx.next(l.who, l.text, { gap, ...(remarkAt.has(i) ? { dry: { remark: REMARKS[[...remarkAt].indexOf(i)] } } : {}) }) }));
    const finalReq = ctx.next('vera', 'Nova, what is two plus two?', { gap: 4000, dry: { reply: { text: 'Two plus two is four.', frames: 12 }, audioFirstMs: 600 } });
    // When the answer's first frame reaches Vera's socket (against when the provider voiced it: what the gate's hold cost).
    let firstHeardAt = 0;
    p.vera.audioHook = () => { if (!firstHeardAt) firstHeardAt = Date.now(); };
    r.note(`${placed.length} lines, ${Math.round(finalReq.endMs / 1000)} s of talk, gap ${gap} ms`);
    ctx.begin();
    // The quiet part is judged at the moment the final request begins, before it can change anything.
    await ctx.until(finalReq.atMs - 200);
    const quietMsgs = (await call.novaMessages(p.vera)).filter((m) => m.metadata?.kind !== 'assistant-notice');
    const quietState = await call.state();
    const quietFrames = Object.values(p).reduce((n, x) => n + x.audioFrames, 0);
    const seenCalls = ctx.world.provider?.seen.calls.length ?? 0;
    await ctx.until(finalReq.endMs + 9000);
    const finalState = await call.state();
    const finalFrames = p.vera.audioFrames;
    await ctx.world.stopLanes();
    await ctx.debug();

    r.expect('Nova posted nothing to the call chat during the quiet talk (notices aside)', quietMsgs.length === 0, quietMsgs.map((m) => String(m.message).slice(0, 50)).join(' | '));
    r.expect('no tool call was made or refused', seenCalls === 0 && quietState?.refusedCalls === 0, `provider calls ${seenCalls}, refusedCalls ${quietState?.refusedCalls}`);
    r.expect('no voice frame was relayed to anyone', quietFrames === 0 && quietState?.voiceFramesRelayed === 0, `${quietFrames} frames at the sockets, relayed ${quietState?.voiceFramesRelayed}`);
    r.expect('the fake provider made its two unprompted remarks, and the voice gate withheld both', (ctx.world.provider?.seen.remarks ?? 0) >= 2 && (quietState?.voiceUtterancesWithheld ?? 0) >= 2,
      `remarks ${ctx.world.provider?.seen.remarks}, utterances withheld ${quietState?.voiceUtterancesWithheld} (${quietState?.voiceFramesWithheld} frames)`);
    r.expect('no request was counted from talk that never asked Nova anything', quietState?.counters?.requests === 0, `requests ${quietState?.counters?.requests}, pending ${JSON.stringify((quietState?.pendingRequests ?? []).map((q) => q.text.slice(0, 30)))}`);
    r.expect('the audio side is clean: nothing unmapped, nothing unacknowledged, nothing late', await (async () => {
      const a = await call.audio(); const c = a?.counters ?? {}; return (c.unmappedChunks ?? 0) === 0 && (c.unackedChunks ?? 0) === 0 && (c.lateChunks ?? 0) === 0 && (c.overrunChunks ?? 0) === 0;
    })(), JSON.stringify((await call.audio())?.counters));

    const stored = await call.transcript();
    let right = 0, missing = 0, two = 0, wrong = 0;
    for (const l of placed.slice(0, placed.length)) {
      const hit = findAllSaid(stored, l.text);
      if (!hit.length) { missing += 1; continue; }
      if (hit.some((s) => (s.speakers?.length ?? 0) > 1)) { two += 1; continue; }
      if (hit.every((s) => s.userId === `u-${l.who}`)) right += 1; else wrong += 1;
    }
    r.measure('lines planned', placed.length);
    r.measure('share of lines stored under the right speaker (percent)', (right / placed.length) * 100);
    r.measure('lines missing', missing);
    r.measure('lines under two people', two);
    r.measure('lines under the wrong person', wrong);
    const after = await call.chatMessages(p.vera);
    const answer = after.find((m) => m.metadata?.kind === 'assistant-reply' && /four/i.test(String(m.message)));
    r.expect('the final answer is voiced although its first frame came before the request\'s transcript: frames relayed and heard by Vera',
      (finalState?.voiceFramesRelayed ?? 0) > 0 && finalFrames > 0, `relayed ${finalState?.voiceFramesRelayed}, at Vera's socket ${finalFrames}`);
    const voicedAt = ctx.world.provider?.seen.firstVoicedAt?.[0];
    if (voicedAt && firstHeardAt) r.measure('the answer\'s first frame held by the voice gate (ms)', firstHeardAt - voicedAt);
    r.expect('the one addressed request at the end is answered, labelled with Vera', !!answer && answer.metadata.askedBy === 'u-vera', answer ? `labelled ${answer.metadata.askedBy}` : 'no reply');
  },
};
