// Piece F1: the lead's waiting question is on the footer's row, never above it (the owner, 20 November: the call footer is
// one row of one height with nothing stacked above it). On the mock world, with the scripted coach:
//   F1a  the lead in the call with no question waiting: the footer is its row at 1280 and 1440 (the heights F1b–F1d compare with)
//   F1b  Milo's suggestion waits as a button on the row: at both widths the footer is as tall as in F1a, nothing is drawn
//        above the row, and the question is not on the page until the lead opens it
//   F1c  the button opens the question over the page with its three answers (I'll ask it / Have Milo ask / Skip); the
//        footer's height does not change; a click outside closes it and the question keeps waiting on the button
//   F1d  "I'll ask it" from the popover: the button is gone, the receipt is a chip on the row, and the height is the same
// Screenshots: question-<width>.png (the question waiting) and question-<width>-open.png (opened) in --out.
import { liveRoom, inject, sleep } from './h3-call.mjs';

const WIDTHS = [1280, 1440];

/** The footer's boxes: its own height, its row's, and anything else in it that takes height (a row above the bar). */
const measure = (page) => page.evaluate(() => {
  const footer = document.querySelector('[data-testid="shell-footer"]');
  const row = document.querySelector('[data-testid="shell-footer-row"]');
  if (!footer || !row) return null;
  const h = (el) => Math.round(el.getBoundingClientRect().height * 10) / 10;
  const above = Array.from(footer.children).filter((el) => el !== row && el.getClientRects().length > 0 && h(el) > 0).map((el) => `${el.getAttribute('data-testid') ?? el.tagName}:${h(el)}`);
  return { footer: h(footer), row: h(row), above, wide: row.scrollWidth > row.clientWidth + 1 };
});

export default async function run(ctx) {
  const { SEED, record, resetMock, out } = ctx;
  const iv = SEED.panelInterview;
  const WEN = SEED.cast.interviewer2;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const at = async (page, width) => { await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(700); return measure(page); };
  const same = (base, m) => !!base && !!m && m.footer === base.footer && m.row === base.row && m.above.length === 0 && !m.wide;
  const says = (m) => (m ? `footer ${m.footer}, row ${m.row}${m.above.length ? `, above ${m.above.join(' ')}` : ''}${m.wide ? ', the row overflows' : ''}` : 'no footer');

  await resetMock();
  let room = null;
  try {
    room = await liveRoom(ctx, { interviewId: iv, leadId: WEN });
  } catch (e) {
    for (const s of ['a', 'b', 'c', 'd']) record(`F1${s}`, false, `the live room did not open: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    return;
  }
  const page = room.leadPage;
  const button = page.getByTestId('interview-room-ask-open');
  const deck = page.getByTestId('interview-room-ask');
  const base = {};
  try {
    await step('F1a', async () => {
      await sleep(2500);
      for (const w of WIDTHS) base[w] = await at(page, w);
      const ok = WIDTHS.every((w) => base[w] && base[w].row === 44 && base[w].footer >= 44 && base[w].footer <= 46 && base[w].above.length === 0 && !base[w].wide);
      return { ok: ok && (await button.count()) === 0, detail: WIDTHS.map((w) => `${w}: ${says(base[w])}`).join('; ') };
    });

    await step('F1b', async () => {
      await inject(ctx, room.callId, [{ userId: WEN, text: 'Tell me about someone on your team who was struggling. What did you do, and what happened?' }]);
      await inject(ctx, room.callId, [{ userId: room.guest.guestId, text: 'I paired with him every morning, and we could tell it was working when his reviews got faster.' }]);
      const came = await button.waitFor({ timeout: 160_000 }).then(() => true, () => false);
      if (!came) return { ok: false, detail: 'no suggestion came to the footer in 160 s' };
      const kind = await button.getAttribute('data-ask');
      const closed = !(await deck.isVisible().catch(() => false));
      const got = {};
      for (const w of WIDTHS) { got[w] = await at(page, w); await page.screenshot({ path: `${out}/question-${w}.png` }); }
      const ok = kind === 'suggestion' && closed && WIDTHS.every((w) => same(base[w], got[w]));
      return { ok, detail: `the button reads "${(await button.innerText()).trim()}" (${kind}), the question shut ${closed}; ${WIDTHS.map((w) => `${w}: ${says(got[w])} (no question: ${base[w]?.footer})`).join('; ')}` };
    });

    await step('F1c', async () => {
      const got = {};
      let options = '';
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForTimeout(500);
        if (!(await deck.isVisible().catch(() => false))) await button.click();
        await deck.waitFor({ timeout: 5000 });
        got[w] = await measure(page);
        options = (await deck.getByRole('button').allInnerTexts()).map((t) => t.trim()).filter(Boolean).join(' / ');
        await page.screenshot({ path: `${out}/question-${w}-open.png` });
        // A click on the page closes it; the question keeps waiting.
        await page.mouse.click(Math.round(w / 2), 300);
        await page.waitForTimeout(400);
      }
      const shut = !(await deck.isVisible().catch(() => false));
      const waits = (await button.count()) === 1;
      const ok = /I’ll ask it/.test(options) && /Have Milo ask/.test(options) && /Skip/.test(options) && shut && waits && WIDTHS.every((w) => same(base[w], got[w]));
      return { ok, detail: `opened: ${options}; ${WIDTHS.map((w) => `${w}: ${says(got[w])}`).join('; ')}; a click outside shut it ${shut}, still waiting ${waits}` };
    });

    await step('F1d', async () => {
      await button.click();
      await deck.getByRole('button', { name: 'I’ll ask it', exact: true }).first().click({ timeout: 5000 });
      const gone = await button.waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false);
      const receipt = (await page.getByTestId('interview-room-receipt').first().innerText({ timeout: 5000 }).catch(() => '')).trim();
      const got = {};
      for (const w of WIDTHS) got[w] = await at(page, w);
      const ok = gone && /Answered/.test(receipt) && WIDTHS.every((w) => same(base[w], got[w]));
      return { ok, detail: `the button gone ${gone}; receipt "${receipt}"; ${WIDTHS.map((w) => `${w}: ${says(got[w])}`).join('; ')}` };
    });
  } finally {
    await room.close();
  }
}
