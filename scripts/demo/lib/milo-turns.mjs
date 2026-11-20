// Milo's turns in a live film take, measured from the browsers: his voice frames as the candidate's page receives them, his
// words in the call chat, and the beats the 20 November films play (a request by voice, a request by the hold button, a line
// that must get no reply, a cut-in over his answer). Shared by interviews-board-film.mjs and interviews-call-film.mjs.
//
// miloTurns(ctx) → { milo, voiceLog, keepMiloVoice, miloSays, miloPosts, turn, askByVoice, watchSilence, bargeOver, askByHold }
// ctx: out (the take's dir), timeline, report, lines (id → [who, text]), busy ({ until }: when the call is next quiet), say(id,
// gapMs, { now }) (plays a line into its speaker's microphone, resolves when it ends), until, sleep, note, moveTo(page, x, y, ms),
// portal (base URL), people() → { lead, cand }, callId() → the call's id or null, handsfree, bargeOn ('cand' | 'hold' | 'none'),
// record (write the voice frames to <out>/assistant-voice.jsonl).
import fs from 'node:fs';
import path from 'node:path';

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function miloTurns(ctx) {
  const { out, timeline, report, lines, busy, say, until, sleep, note, moveTo, portal, people, callId, handsfree = false, bargeOn = 'cand', record = true } = ctx;
  const filmS = (ms) => Number(((ms - timeline.film.fromMs) / 1000).toFixed(1));
  const voiceLog = record ? fs.createWriteStream(path.join(out, 'assistant-voice.jsonl')) : null;
  const milo = { frames: 0, utterances: 0, cur: null, lastStartMs: 0 };
  timeline.milo ??= [];

  /** Milo's voice frames as `page` receives them; one utterance runs while the frames follow each other (same run, next seq). */
  function keepMiloVoice(page) {
    page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string' || !payload.includes('assistant-audio')) return;
      let f; try { f = JSON.parse(payload); } catch { return; }
      if (f?.type !== 'assistant-audio' || typeof f.data?.pcm !== 'string') return;
      const now = Date.now();
      milo.frames += 1;
      const c = milo.cur;
      if (!c || c.done || c.runId !== f.data.runId || f.data.seq !== c.seq + 1 || now - (c.lastAtMs ?? now) > 1500) {
        milo.cur = { runId: f.data.runId, seq: f.data.seq, startMs: now, ms: 0, done: false }; milo.utterances += 1; milo.lastStartMs = now; timeline.milo.push(milo.cur);
      }
      const u = milo.cur;
      u.seq = f.data.seq; u.done = f.data.last === true; u.lastAtMs = now;
      u.ms += (Buffer.from(f.data.pcm, 'base64').length / 2 / (f.data.sampleRate || 24000)) * 1000;
      busy.until = Math.max(busy.until, u.startMs + u.ms);
      voiceLog?.write(`${JSON.stringify({ atMs: now, runId: f.data.runId, seq: f.data.seq, sampleRate: f.data.sampleRate, last: f.data.last === true, pcm: f.data.pcm })}\n`);
    }));
  }
  /** Waits until Milo has said something new (an utterance after `n`) and finished it; → true when he did. */
  async function miloSays(n, ms) {
    if (!(await until(async () => milo.utterances > n, ms, 100))) return false;
    const quiet = async () => (Date.now() > busy.until + 120 && Date.now() - (milo.cur?.lastAtMs ?? 0) > 600 ? true : null);
    await until(quiet, 60_000, 60);
    // Hands-free: one answer can come as two utterances, so an utterance starting within 1 s belongs to the same answer.
    for (let k = milo.utterances; handsfree && (await until(async () => (milo.utterances > k ? true : null), 1000, 50)); k = milo.utterances) {
      await until(quiet, 60_000, 60);
    }
    return true;
  }
  /** Milo's posts in the call chat (his words, as captioned), oldest first. */
  async function miloPosts() {
    const id = callId(); if (!id) return [];
    const r = await people().lead.api.get(`${portal}/api/calls/${encodeURIComponent(id)}/chat?limit=100`).catch(() => null);
    if (!r?.ok()) return [];
    return ((await r.json().catch(() => ({}))).messages ?? []).filter((m) => String(m.metadata?.kind ?? '').startsWith('assistant')).map((m) => String(m.message ?? m.text ?? m.body ?? ''));
  }
  /** One Milo turn, measured: the asking line's end to Milo's first audio, and what he said (his new posts). */
  async function turn(kind, asker, asked, endMs, n, posts0, spoke) {
    const u = timeline.milo[n] ?? null;
    const said = spoke ? ((await until(async () => { const p = await miloPosts(); return p.length > posts0 ? p.slice(posts0).join(' | ') : null; }, 6000, 400)) ?? '') : '';
    const t = { kind, asker, asked, askedEndS: filmS(endMs), spoke, firstAudioS: u ? filmS(u.startMs) : null, latencyS: u ? Number(((u.startMs - endMs) / 1000).toFixed(1)) : null,
      voiceS: u ? Number((u.ms / 1000).toFixed(1)) : null, said };
    report.turns.push(t);
    console.log(`milo turn ${kind}: ${JSON.stringify(t)}`);
    return t;
  }
  /** A line said to Milo by voice, and his answer measured (the line's end to his first audio). */
  async function askByVoice(kind, asker, id, how, expect, ms = 20_000) {
    const n = milo.utterances; const posts0 = (await miloPosts()).length;
    await say(id, 300);
    const endMs = Date.now();
    const spoke = await miloSays(n, ms);
    const t = await turn(kind, asker, lines[id][1], endMs, n, posts0, spoke);
    t.how = how; t.right = spoke && expect.test(t.said);
    return t;
  }
  /** A line that must get no reply from Milo, watched for `ms` after its end. */
  async function watchSilence(kind, id, ms) {
    const n = milo.utterances;
    await say(id, 300);
    const endMs = Date.now();
    const replied = !!(await until(async () => (milo.utterances > n ? true : null), ms, 100));
    if (replied) await miloSays(n, 20_000);
    const r = { kind, line: id, asked: lines[id][1], endS: filmS(endMs), watchedS: ms / 1000, replied, firstAudioS: replied ? filmS(timeline.milo[n].startMs) : null };
    (report.silences ??= []).push(r);
    console.log(`milo silence ${kind}: ${JSON.stringify(r)}`);
    return r;
  }
  /** Hugo talks over Milo's utterance `n` about 2.5 s in (line x01); measured to Milo's silence. */
  async function bargeOver(n) {
    const u = timeline.milo[n];
    await sleep(Math.max(0, u.startMs + 2500 - Date.now()));
    if (u.done) { note('Milo finished before the barge-in could start'); return null; }
    const startMs = Date.now();
    const x01 = say('x01', 0, { now: true });
    await until(async () => (u.done || (u.lastAtMs && Date.now() - u.lastAtMs > 700) ? true : null), 12_000, 50);
    const barge = { on: bargeOn, startS: filmS(startMs), lastFrameAfterS: Number((((u.lastAtMs ?? startMs) - startMs) / 1000).toFixed(2)),
      playoutEndAfterS: Number(((u.startMs + u.ms - startMs) / 1000).toFixed(2)), closed: u.done, voiceS: Number((u.ms / 1000).toFixed(1)) };
    await x01;
    await until(async () => Date.now() > busy.until + 120, 30_000, 60);
    return barge;
  }
  /** Hugo holds the bar's talk button through line `id`, then lets go; Milo's answer measured from the release. */
  async function askByHold(kind, id, expect) {
    const { lead, cand } = people();
    const btn = lead.page.getByTestId('assistant-bar-hold').first();
    const b = await btn.boundingBox({ timeout: 8000 }).catch(() => null);
    if (!b) { note('no hold-to-talk button in Hugo\'s bar'); return null; }
    await moveTo(lead.page, b.x + b.width / 2, b.y + b.height / 2, 700);
    const n = milo.utterances; const posts0 = (await miloPosts()).length;
    await sleep(Math.max(0, busy.until + 300 - Date.now()));
    await lead.page.mouse.down();
    const holding = await until(async () => ((await lead.page.getByTestId('assistant-bar').first().getAttribute('data-holding').catch(() => null)) === 'true' ? true : null), 3000, 100);
    report.holdAtS = filmS(Date.now());
    const line = say(id, 0, { now: true });
    // Both seats during the hold: the "<who> is talking to Milo" chip, the bar's floor holder, and the ring on the speaker's tile.
    const seat = async (p, bar) => {
      await until(async () => ((await p.page.getByTestId(`${bar}-floor`).first().isVisible().catch(() => false)) ? true : null), 2500, 100);
      const r = { chip: squash(await p.page.getByTestId(`${bar}-floor`).first().textContent({ timeout: 500 }).catch(() => '')),
        floor: await p.page.getByTestId(bar).first().getAttribute('data-floor').catch(() => null),
        rings: await p.page.getByTestId('tile-highlight-ring').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).length).catch(() => -1),
        atS: filmS(Date.now()) };
      await p.page.screenshot({ path: path.join(out, `hold-${p.key}.png`) }).catch(() => {});
      return r;
    };
    const [cl, cc] = await Promise.all([seat(lead, 'assistant-bar'), seat(cand, 'guest-milo-requests')]);
    await line;
    await sleep(300);
    await lead.page.mouse.up();
    const relMs = Date.now();
    let barge = null;
    if (bargeOn === 'hold' && (await until(async () => (milo.utterances > n ? true : null), 15_000, 50))) { barge = await bargeOver(n); report.barge = barge; }
    const spoke = barge ? true : await miloSays(n, 20_000);
    const t = await turn(kind, 'lead (hold)', lines[id][1], relMs, n, posts0, spoke);
    t.how = 'hold'; t.right = spoke && expect.test(t.said); t.holding = !!holding; t.chips = { lead: cl, cand: cc }; t.barge = barge;
    return t;
  }
  return { milo, voiceLog, keepMiloVoice, miloSays, miloPosts, turn, askByVoice, watchSilence, bargeOver, askByHold };
}
