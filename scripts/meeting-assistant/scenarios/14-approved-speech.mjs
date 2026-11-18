// approved-speech: words the server holds (an interview's approved question, the time left) said aloud on the call's live session
// (orchestrator.ts sayHeldText, docs/interviews-tenant-plan.md decision 9). Each utterance is held whole until the session's transcript
// of it is complete, then relayed only when it is the same words. The real provider streams the words as the audio plays and stalls
// part way through a sentence; a stall must not cut the utterance short (that withheld every approved line, 17 November). The fake
// provider (lib/fakes.mjs) speaks the same way. With --dry it also says one line in other words: that one must be withheld whole.
const enc = encodeURIComponent;

export default {
  order: 14, id: 'approved-speech', limitSeconds: 60, title: 'approved words are relayed whole; other words are withheld',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora'], voice: true });
    for (const k of ['vera', 'nora']) ctx.lane(k);
    ctx.say('nora', 800, 'I will share the notes from the planning session after this call.');
    ctx.begin();
    await ctx.until(7000);
    const say = async (text) => {
      const res = await p.vera.call('POST', `/api/dev/calls/${enc(call.callId)}/assistant-say`, { text, by: 'u-vera' });
      return res.json?.outcome ?? `http ${res.status}`;
    };
    const relayed = async () => (await call.state())?.voiceFramesRelayed ?? 0;
    const lines = [
      { id: 'time left', text: 'About 59 minutes are left in this round.', want: 'spoken' },
      { id: 'question', text: 'Can you walk me through how you would design a rate limiter for an API that serves many customers?', want: 'spoken' },
    ];
    if (ctx.dry) lines.push({ id: 'paraphrase', text: 'What would you change about the design if the traffic doubled overnight?', want: 'posted', rewrite: (t) => t.replace('change about', 'do differently with') });
    for (const l of lines) {
      if (ctx.world.provider) ctx.world.provider.sayStyle = l.rewrite ? { rewrite: l.rewrite } : {};
      const before = await relayed();
      const outcome = await say(l.text);
      const after = await relayed();
      r.measure(`${l.id}: frames relayed`, after - before);
      r.expect(`${l.id}: ${l.want === 'spoken' ? 'relayed whole' : 'withheld whole'}`, outcome === l.want && (l.want === 'spoken' ? after > before : after === before), `outcome ${outcome}, frames relayed ${after - before}`);
      await new Promise((res) => setTimeout(res, 1500));
    }
    await ctx.world.stopLanes();
    await ctx.debug();
    r.harness('the session was asked to say each line', !ctx.world.provider || (ctx.world.provider.seen.commentary?.length ?? 0) === lines.length, `${ctx.world.provider?.seen.commentary?.length ?? 'n/a'} of ${lines.length}`);
  },
};
