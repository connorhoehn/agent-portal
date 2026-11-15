// address-forms: the ways people really address Milo, and the ways they do not.
//  addressed: the name at the end of the sentence; "Hey Milo"; "Milo?" then a two second pause then the question
//  not addressed: a question to a colleague named Nora ("Nora, what do you think?"); someone talking about Milo in the third person
// An addressed form is answered, labelled with who spoke it; a form that is not addressed raises no request and is not answered.
// Voice is on, and the last request asks for a long plain answer (no tool call): five sentences with short pauses between them, over
// 15 s in all, so well past the 10 s after the request. The voice gate decides a whole speaking turn at once: every voiced frame of
// the answer must reach the people in the call (none of its later sentences withheld).
const LONG = [
  'Lisbon sits on a row of hills above the river Tagus, close to the coast.',
  'Much of the old town was rebuilt after the great earthquake of 1755.',
  'The yellow trams still climb the steepest streets of the Alfama quarter.',
  'Most visitors start at the riverside square and walk up through the shops.',
  'In summer the evenings stay warm until late, so dinner often starts after nine.',
];

export default {
  order: 8, id: 'address-forms', limitSeconds: 150, title: 'the name at the end, Hey Milo, Milo? and pause; Nora and third-person talk are not requests',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'], voice: true });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    ctx.at(500);
    const f1 = ctx.next('vera', 'What is the capital of Portugal, Milo?', { gap: 1500, dry: { delegate: true, reply: { text: 'The capital of Portugal is Lisbon.', frames: 15 } } });
    const f2 = ctx.next('nora', 'Hey Milo, what is two plus two?', { gap: 7000, dry: { reply: { text: 'Two plus two is four.', frames: 12 } } });
    const f3a = ctx.next('mia', 'Milo?', { gap: 7000 });
    const f3b = ctx.next('mia', 'What is the capital of Spain?', { gap: 2000, dry: { reply: { text: 'The capital of Spain is Madrid.', frames: 15 } } });
    const f4 = ctx.next('vera', 'Nora, what do you think about the reminder wording?', { gap: 8000 });
    const f4b = ctx.next('nora', 'I think the wording is clear enough for the first release.', { gap: 1500 });
    const f5 = ctx.next('mia', 'Last week Milo helped Vera with the plan for the launch.', { gap: 6000 });
    const f6 = ctx.next('nora', 'Milo, can you tell us a little about Lisbon?', { gap: 8000, dry: { id: 'long', reply: { sentences: LONG.map((text) => ({ text, frames: 32 })), pausesMs: [400, 550, 700, 500] } } });
    // The long answer's frames as they reach Mia's socket: all of them, and the voiced ones (the fake's voice is a tone, its pauses zeros).
    let collecting = false, framesAtMia = 0, voicedAtMia = 0;
    p.mia.audioHook = (d) => { if (!collecting) return; framesAtMia += 1; if (Buffer.from(String(d.pcm ?? ''), 'base64').some((b) => b !== 0)) voicedAtMia += 1; };
    r.note('in --dry the provider only answers the addressed forms the scenario scripts; whether a real model stays silent for the others is what the paid run judges (the request counter is judged either way)');
    ctx.begin();
    await ctx.until(f4.atMs - 300); const s4a = await call.state();
    await ctx.until(f4b.endMs + 4000); const s4b = await call.state();
    await ctx.until(f5.endMs + 5000); const s5 = await call.state();
    // The address forms are judged on the chat as it stands before the long request (at least 7 s after the last line, as before it).
    await ctx.until(f6.atMs - 300); collecting = true;
    const chat = await call.chatMessages(p.vera);
    await ctx.until(f6.endMs + 24_000); const s6 = await call.state();
    await ctx.world.stopLanes();
    await ctx.debug();

    const replies = chat.filter((m) => m.metadata?.kind === 'assistant-reply');
    const find = (re) => replies.find((m) => re.test(String(m.message)));
    for (const [form, re, who] of [['the name at the end of the sentence', /lisbon/i, 'u-vera'], ['"Hey Milo"', /four/i, 'u-nora'], ['"Milo?" then a two second pause then the question', /madrid/i, 'u-mia']]) {
      const m = find(re);
      r.expect(`${form}: answered, labelled with who spoke`, !!m && m.metadata.askedBy === who, m ? `labelled ${m.metadata.askedBy}` : 'no reply');
    }
    r.measure('requests counted after the three addressed forms', s4a?.counters?.requests ?? -1);
    r.expect('"Nora, what do you think?" raised no request and was not answered', s4b?.counters?.requests === s4a?.counters?.requests && replies.length === 3, `requests ${s4a?.counters?.requests} -> ${s4b?.counters?.requests}, ${replies.length} replies`);
    r.expect('talk about Milo in the third person raised no request and was not answered', s5?.counters?.requests === s4b?.counters?.requests && replies.length === 3, `requests ${s4b?.counters?.requests} -> ${s5?.counters?.requests}, ${replies.length} replies`);
    r.measure('requests counted at the end', s5?.counters?.requests ?? -1);
    const seenBefore = new Set(chat.map((m) => m.id));
    const long = (await call.chatMessages(p.vera)).find((m) => m.metadata?.kind === 'assistant-reply' && !seenBefore.has(m.id));
    r.measure('frames of the long answer at Mia\'s socket (voiced and each sentence\'s short tail)', framesAtMia);
    if (ctx.dry) {
      r.expect('the long plain answer is posted, labelled with who asked', !!long && /Lisbon sits on a row of hills/.test(String(long.message)) && long.metadata.askedBy === 'u-nora', long ? `labelled ${long.metadata.askedBy}` : 'no reply');
      const voicedByFake = ctx.world.provider?.seen.voicedFor?.long ?? 0;
      r.expect('every voiced frame of the long answer (five sentences, over 15 s) was relayed: none of its later sentences was withheld',
        voicedByFake >= LONG.length * 32 && voicedAtMia === voicedByFake, `the fake voiced ${voicedByFake}, Mia received ${voicedAtMia} voiced (${framesAtMia} in all); withheld ${s6?.voiceFramesWithheld} frames in ${s6?.voiceUtterancesWithheld} turns`);
    } else r.measure('voiced frames of the model\'s own answer about Lisbon at Mia\'s socket', voicedAtMia);
    void [f1, f2, f3a, f3b];
  },
};
