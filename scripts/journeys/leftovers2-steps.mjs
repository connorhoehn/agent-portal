const INIT = '/iq/projects/p-auth-migration';
const NOTICE = /This initiative's discussion is in #[a-z-]+ in Social\. You don't have Social access\./;

export default {
  async 1(browser, H) {
    const { ctxFor, watch, go, body, shot, note, sleep } = H;
    // hr: no Social grant. vera: has it.
    for (const w of [1440, 390]) {
      const ctx = await ctxFor(browser, 'hr', w, w === 390 ? 844 : 900);
      const page = await ctx.newPage(); watch(page, `1-hr-${w}`);
      await go(page, INIT);
      if (w === 390) {
        const btns = await page.evaluate(() => [...document.querySelectorAll('button,[role=tab]')].map((b) => `${b.getAttribute('aria-label') ?? ''}|${(b.innerText || '').trim().slice(0, 20)}|${b.getAttribute('data-testid') ?? ''}`).filter((s) => /chat|discuss|pane|message|conversation/i.test(s)));
        console.log('390 buttons', btns);
      }
      if (w === 390) { await page.getByTestId('shell-footer-context-chat').click().catch(() => undefined); await sleep(1500); }
      const text = await body(page);
      const hasNotice = NOTICE.test(text);
      const accessAction = /Request Social access|Ask|access/i.test(await body(page, '[data-testid=initiative-discussion-elsewhere]').catch(() => ''));
      const thread = await page.locator('[data-testid=scope-discussion-panel]').count();
      const dest = await page.locator('text=/^To: ?#/').count();
      await shot(page, `1a-no-social-${w}`);
      note(`1a no-social @${w}`, hasNotice && thread === 0 && dest === 0 && accessAction, { hasNotice, accessAction, thread, dest, notice: (await body(page, '[data-testid=initiative-discussion-elsewhere]').catch(() => 'absent')).slice(0, 200) });
      await ctx.close();
    }
    for (const w of [1440, 390]) {
      const ctx = await ctxFor(browser, 'vera', w, w === 390 ? 844 : 900);
      const page = await ctx.newPage(); watch(page, `1-vera-${w}`);
      await go(page, INIT);
      // The header stats: one strip at every width (ui-components 2.518.0 drops separators at line ends); never a
      // visible "•" that starts or ends a wrapped line, and the points bar is drawn.
      const stats = await page.evaluate(() => {
        const vis = (e) => !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none';
        const strip = document.querySelector('[data-testid=overview-stats]');
        const box = (e) => e.getBoundingClientRect();
        const frame = strip ? box(strip) : null;
        const clusters = strip ? [...strip.querySelectorAll('[data-testid=stat-strip-cluster]')].map(box) : [];
        const lines = new Set(clusters.map((c) => Math.round(c.top))).size;
        const badSeps = strip ? [...strip.querySelectorAll('[data-testid=stat-strip-separator]')].map(box).filter((s) => s.right > frame.left + 1)
          .filter((s) => { const same = (c) => c.top < s.bottom && c.bottom > s.top; return !(clusters.some((c) => same(c) && c.right <= s.left + 1) && clusters.some((c) => same(c) && c.left >= s.right - 1)); }).length : -1;
        const bar = strip?.querySelector('[data-testid=stat-strip-progress]');
        const rows = [...document.querySelectorAll('[data-testid=overview-decision-row]')];
        const clipped = rows.flatMap((r) => [...r.querySelectorAll('*')].filter((c) => c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).overflow !== 'visible').map((c) => c.innerText.slice(0, 30)));
        const rowText = rows.map((r) => r.innerText.replace(/\s+/g, ' '));
        const header = document.querySelector('header.shell-header');
        const kids = header ? [...header.querySelectorAll('button, a')].filter(vis).map(box) : [];
        const headerRows = new Set(kids.map((k) => Math.round((k.top + k.bottom) / 2 / 8))).size;
        return { stripShown: vis(strip), lines, badSeps, barShown: vis(bar), clipped, rowText, hscroll: document.documentElement.scrollWidth - window.innerWidth,
          headerH: header ? Math.round(box(header).height) : -1, headerRows, headerMarker: header?.getAttribute('data-header-rows') ?? null };
      });
      if (w === 390) note('1f shell header is one row @390', stats.headerMarker === 'one' && stats.headerRows === 1 && stats.headerH <= 56, { headerH: stats.headerH, headerRows: stats.headerRows });
      note(`1d stats line @${w}`, stats.stripShown && stats.badSeps === 0 && stats.barShown && (w === 390 ? stats.lines >= 2 : true), stats);
      note(`1e waiting row wraps, never clips @${w}`, stats.rowText.length > 0 && stats.clipped.length === 0 && stats.hscroll <= 0, stats);
      if (w === 390) { await shot(page, '1-vera-390'); await page.getByTestId('shell-footer-context-chat').click().catch(() => undefined); await sleep(1500); }
      await shot(page, `1b-social-${w}`);
      if (w === 1440) {
        await page.getByTestId('initiative-conversation-filter').click().catch((e) => console.log('filter click failed', String(e).slice(0, 100)));
        await sleep(500);
        const menu = await page.evaluate(() => [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]')].map((e) => e.innerText.replace(/\s+/g, ' ')));
        await shot(page, '1c-filter-menu-1440');
        note('1c filter menu', ['All', 'Messages', 'Work notes', 'Agent'].every((l) => menu.some((m) => m.replace(/^✓ /, '').startsWith(l))), menu);
      }
      await ctx.close();
    }
  },
  async 2(browser, H) {
    const { ctxFor, watch, go, body, shot, note, sleep, PORTAL } = H;
    const ITEM = 'wi-auth-e2-b3';
    const TEXT = `Leftovers walk note ${Date.now() % 100000}: shim cookie still set after logout`;
    const ctx = await ctxFor(browser, 'vera', 1440, 900);
    const page = await ctx.newPage(); watch(page, '2-vera');
    await go(page, `${INIT}?tab=work&item=${ITEM}`);
    await shot(page, '2a-item-before-1440');
    await page.getByRole('button', { name: 'Hide', exact: true }).click().catch(() => undefined);
    await sleep(600);
    await shot(page, '2a2-composer-1440');
    const ed = page.locator('[data-testid=initiative-central-composer] .ProseMirror, [data-testid=rich-chat-composer] .ProseMirror').first();
    await ed.click();
    // The command token, a pause for its menu to settle, then the note at 15 ms a key. ui-components 2.519.0 fixed the
    // composer re-applying its own one-keystroke-old draft (the lost spaces); one read-back, no retry, so a regression
    // fails here loudly instead of being typed around.
    await page.keyboard.type('/comment ', { delay: 15 });
    await sleep(400);
    await page.keyboard.type(TEXT, { delay: 15 });
    await sleep(400);
    const typed = (await ed.evaluate((e) => e.innerText.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())).replace(/^\/comment /, '');
    note('2 typed note is exact (one pass, 15 ms a key)', typed === TEXT, { typed, want: TEXT });
    await shot(page, '2b-typed-1440');
    await page.getByTestId('rich-chat-composer-send').click();
    await sleep(3000);
    await shot(page, '2c-after-send-1440');
    const receipt = await body(page, '[data-testid=initiative-chat-receipt]').catch(() => '');
    const feed = await (await ctx.request.get(`${PORTAL}/api/graph/work-items/${ITEM}/comments`)).json();
    const inFeed = (feed.comments ?? []).some((c) => c.body.includes(TEXT));
    note('2a comment saved on item feed (API)', inFeed, { receipt, comments: (feed.comments ?? []).length });
    // Activity tab of the item shows it.
    await page.getByRole('tab', { name: /Activity/ }).last().click().catch(() => undefined);
    await sleep(1500);
    await shot(page, '2d-item-activity-1440');
    const t = await body(page, '[data-testid=work-item-detail]').catch(() => '');
    note('2b comment visible in item Activity feed (UI)', t.includes(TEXT), t.slice(0, 300));
    // The channel: reference line + Work notes filter.
    const pane = await body(page);
    const panel = await body(page, '[data-testid=scope-discussion-panel]').catch(() => '');
    note('2c channel shows reference line', /Leftovers walk note/.test(panel) || /Logout leaves the legacy shim cookie alive/.test(panel), panel.slice(-300));
    await page.getByTestId('initiative-conversation-filter').click().catch(() => undefined);
    await sleep(400);
    await page.getByText('Work notes', { exact: true }).last().click().catch(() => undefined);
    await sleep(1200);
    await shot(page, '2e-work-notes-filter-1440');
    const thread = await body(page, '[data-testid=scope-discussion-panel]').catch(() => '');
    note('2d Work notes filter shows it', thread.includes('Logout leaves the legacy shim cookie alive') && !thread.includes('Second rehearsal failed'), thread.slice(0, 400));
    await page.getByTestId('initiative-conversation-filter').click().catch(() => undefined);
    await page.getByText('Messages', { exact: true }).last().click().catch(() => undefined);
    await sleep(1000);
    await shot(page, '2f-messages-filter-1440');
    const msgs = await body(page, '[data-testid=scope-discussion-panel]').catch(() => '');
    note('2e Messages filter hides the reference', !msgs.includes('Leftovers walk note') && msgs.includes('Second rehearsal failed'), msgs.slice(0, 200));
    await ctx.close();
    // 390
    const c2 = await ctxFor(browser, 'vera', 390, 844);
    const p2 = await c2.newPage(); watch(p2, '2-vera-390');
    await go(p2, `${INIT}?tab=work&item=${ITEM}`);
    await shot(p2, '2g-item-390');
    await p2.getByRole('tab', { name: /Activity/ }).last().click().catch(() => undefined);
    await sleep(1200);
    await shot(p2, '2h-item-activity-390');
    await c2.close();
  },
  async '2t'(browser, H) {
    const { ctxFor, watch, go, note, sleep, shot } = H;
    // Typing fidelity (ui-components 2.519.0): a 120-character sentence typed into the initiative composer and a
    // work-item composer at 15, 40 and 80 ms a key, ten times each, must land exactly every time. Before the fix a
    // render committing between two keys re-applied the composer's own older draft and dropped the newest key.
    // Nothing is sent: the editor is cleared between runs and at the end.
    const SENTENCE = 'Typing fidelity check, the cutover rehearsal moves to Thursday so the legacy tenants get one more day of shadow traffic.';
    if (SENTENCE.length !== 120) throw new Error(`sentence is ${SENTENCE.length} characters, not 120`);
    const RUNS = Number(process.env.TYPING_RUNS ?? 10);
    const targets = [['initiative', INIT], ['work-item', `${INIT}?tab=work&item=wi-auth-e2-b3`]];
    const summary = {};
    for (const [name, url] of targets) {
      const ctx = await ctxFor(browser, 'vera', 1440, 900);
      const page = await ctx.newPage(); watch(page, `2t-${name}`);
      await go(page, url);
      // A work item opens with its "Prepare job" dialogue in the composer; Hide gives the text box back (as step 2).
      if (name === 'work-item') { await page.getByRole('button', { name: 'Hide', exact: true }).click().catch(() => undefined); await sleep(600); }
      const ed = page.locator('[data-testid=initiative-central-composer] .ProseMirror').first();
      const read = () => ed.evaluate((e) => e.innerText.replace(/\u00a0/g, ' ').replace(/\n+$/, ''));
      const clear = async () => {
        await ed.click();
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
        await sleep(250);
      };
      for (const delay of [15, 40, 80]) {
        const misses = [];
        for (let run = 1; run <= RUNS; run++) {
          await clear();
          await page.keyboard.type(SENTENCE, { delay });
          await sleep(300);
          const got = await read();
          if (got !== SENTENCE) misses.push({ run, got: got.slice(0, 160), len: got.length });
        }
        summary[`${name}@${delay}ms`] = `${RUNS - misses.length}/${RUNS}`;
        note(`2t ${name} composer exact at ${delay} ms a key`, misses.length === 0, { exact: `${RUNS - misses.length}/${RUNS}`, misses: misses.slice(0, 3) });
      }
      await shot(page, `2t-${name}-last-1440`);
      await clear();
      await ctx.close();
    }
    console.log('2t typing fidelity', JSON.stringify(summary));
  },
  async 3(browser, H) {
    const { ctxFor, watch, go, body, shot, note, sleep } = H;
    const items = [
      ['cutover', 'p-auth-migration', 'wi-auth-e2-s2', 'Cutover order for legacy SSO tenants'],
      ['judge-model', 'p-llm-platform', 'wi-llm-e1-s2', 'Judge model for canary evaluation'],
      ['warm-floor', 'p-inference-platform', 'wi-inf-e1-b3', 'Warm floor or scale-to-zero for tier-1 models'],
    ];
    for (const w of [1440, 390]) {
      const ctx = await ctxFor(browser, 'hr', w, w === 390 ? 844 : 900);
      const page = await ctx.newPage(); watch(page, `3-${w}`);
      for (const [name, proj, id, topic] of items) {
        await go(page, `/iq/projects/${proj}?tab=work&item=${id}`);
        await page.getByRole('button', { name: 'Hide', exact: true }).click().catch(() => undefined);
        await sleep(500);
        const step = await body(page, '[data-testid=work-item-next-step]').catch(() => 'ABSENT');
        await shot(page, `3-${name}-${w}`);
        // At 390 the composer's strip is folded, and Workflow rides the row's overflow (ui-components 2.518.0): the idle
        // row's own "Workflow" ⋯, or the open card's "Workflow and keyboard hints" ⋯. One tap, no focus, no "Aa".
        if (w === 390) {
          const folded = page.locator('[data-folded-menu]').first();
          const oneTap = await folded.isVisible().catch(() => false);
          const label = oneTap ? await folded.getAttribute('aria-label') : null;
          note(`3 ${name} Workflow one tap @390`, oneTap && /^Workflow/.test(label ?? ''), { label });
          await folded.click().catch(() => undefined);
          await sleep(300);
          await shot(page, `3-${name}-workflow-menu-${w}`);
        } else {
          await page.getByRole('button', { name: /Workflow/ }).first().click().catch(() => undefined);
        }
        await sleep(400);
        // A blocked item offers "Unblock this item"; one that only waits on a pending decision, "What does this wait on?" (walk fixes).
        await page.getByText(/^(Unblock this item|What does this wait on\?)$/).first().click().catch(() => undefined);
        await sleep(700);
        const prefill = await page.locator('[data-testid=rich-chat-composer] .ProseMirror, [data-testid=initiative-central-composer] .ProseMirror').first().innerText().catch(() => 'NO EDITOR');
        await shot(page, `3-${name}-prefill-${w}`);
        const nextLine = step.replace(/^Next step /, '').replace(/ Open discussion$/, '');
        const planned = (prefill.match(/Planned next step: ([^\n]*)/) ?? [])[1] ?? '';
        const named = step.includes(topic) && prefill.includes(topic.slice(0, 20)) || planned.includes(topic);
        // The pick writes the /unblock command; the prompt with the derived step is built at Send (3b checks it).
        // The step names the decision once (walk fixes: the reason no longer repeats the title).
        const once = step.split(`"${topic}"`).length - 1 === 1;
        note(`3 ${name} @${w}`, step.includes(`"${topic}"`) && once && !/ decides\b/.test(step.split(' comes first.')[0]) && (planned.length > 0 ? planned.startsWith(nextLine.split('. ')[0].slice(0, 40)) : /^\/unblock\b/.test(prefill.trim())), { step, planned, prefill: prefill.replace(/\s+/g, ' ').slice(0, 400) });
      }
      await ctx.close();
    }
  },
  async '3b'(browser, H) {
    const { ctxFor, watch, go, body, shot, note, sleep } = H;
    // The composer's /unblock expands to the workflow prompt at Send: capture what the agent is asked.
    const ctx = await ctxFor(browser, 'hr', 1440, 900);
    const page = await ctx.newPage(); watch(page, '3b');
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/') && !/telemetry|session/.test(r.url())) posts.push({ url: r.url().replace(H.PORTAL, ''), body: (r.postData() ?? '').slice(0, 1500) }); });
    await go(page, '/iq/projects/p-auth-migration?tab=work&item=wi-auth-e2-s2');
    await page.getByRole('button', { name: 'Hide', exact: true }).click().catch(() => undefined);
    await page.getByRole('button', { name: /Workflow/ }).first().click();
    await sleep(300);
    await page.getByText('Unblock this item', { exact: true }).first().click();
    await sleep(500);
    await page.getByTestId('rich-chat-composer-send').click();
    await sleep(2500);
    await shot(page, '3b-after-send-1440');
    const hit = posts.find((p) => /Planned next step/.test(p.body));
    note('3b unblock prompt carries the derived step', !!hit && /Cutover order for legacy SSO tenants/.test(hit.body), hit ?? posts);
    await ctx.close();
  },
  async 4(browser, H) {
    const { ctxFor, watch, go, body, shot, note, sleep, reset, PORTAL } = H;
    const GET = { ref: null, part: null, detail: null };
    const QUEUE = { kind: null, target: null, note: null, model: null, rows: null, scope: null, focus: null };
    const scenarios = [
      ['answer', 'nora', '/iq/work', async (page, ctx) => {
        const c = (await (await ctx.request.get(`${PORTAL}/api/lab/consults?status=pending`)).json()).consults;
        return [{ said: 'Tell it: riskiest too first, while the shim is warm.', call: { name: 'decide', arguments: { ref: `consult:${c[0].id}`, decision: 'approve', note: 'Riskiest too first, while the shim is warm.', option: null } } }];
      }],
      ['decision', 'vera', `${INIT}?tab=decisions`, async () => [{ said: 'Decide the cutover order: riskiest two tenants first.', call: { name: 'decide', arguments: { ref: '1', decision: 'resolve', note: null, scope: 'this-page', option: 'Riskiest two tenants first' } } }]],
      ['message', 'vera', INIT, async () => [{ said: 'Tell #auth-migration the cutover order is decided; rehearsal Thursday.', call: { name: 'message', arguments: { target: { kind: 'channel', name: 'auth-migration' }, text: 'The cutover order is decided; rehearsal Thursday.', thread: null, attach: null } } }]],
      ['queue-deck', 'vera', INIT, async () => [{ said: "Make a deck of this initiative's progress this past sprint.", call: { name: 'queue_work', arguments: { kind: 'deck', target: 'this initiative', note: null, model: null, rows: null, scope: 'this-page', focus: 'progress this past sprint' } } }]],
      ['queue-dispatch', 'vera', `${INIT}?tab=work&item=wi-auth-e2-b3`, async () => [{ said: 'Send the logout cookie bug to an agent.', call: { name: 'queue_work', arguments: { kind: 'dispatch', target: 'the logout cookie bug', note: null, model: null, rows: null, scope: 'this-page', focus: null } } }]],
    ];
    for (const [name, who, url, turnsFn] of scenarios) {
      await reset();
      for (const w of [1440, 390]) {
        const ctx = await ctxFor(browser, who, w, w === 390 ? 844 : 900);
        const page = await ctx.newPage(); watch(page, `4-${name}-${w}`);
        await go(page, url);
        const turns = await turnsFn(page, ctx);
        const r = await ctx.request.put(`${PORTAL}/api/voice/mock-script`, { data: { turns } });
        if (r.status() !== 204) { note(`4 ${name} @${w}`, false, `mock-script ${r.status()}`); await ctx.close(); continue; }
        await page.getByTestId('shell-voice-dock-start').click();
        let ok = true; let detail = {};
        try {
          await page.getByTestId('voice-confirm-card').waitFor({ timeout: 15000 });
          await sleep(700);
          const card = await body(page, '[data-testid=voice-confirm-card]');
          const btn = (await body(page, '[data-testid=voice-confirm-card-confirm]')).trim();
          const toggle = await page.getByTestId('voice-confirm-card-decision').count();
          const note_ = await page.getByTestId('voice-confirm-card-note').count();
          const noteVal = note_ ? await page.getByTestId('voice-confirm-card-note').inputValue().catch(() => '') : null;
          const clickOnly = await page.locator('[data-testid=voice-confirm-card][data-click-only]').count();
          detail = { card: card.slice(0, 300), button: btn, toggle, noteField: note_, noteVal, clickOnly };
          await shot(page, `4-${name}-${w}`);
        } catch (e) { ok = false; detail = { error: String(e).slice(0, 200) }; await shot(page, `4-${name}-${w}-nocard`); }
        note(`4 ${name} @${w}`, ok, detail);
        await page.getByTestId('shell-voice-dock-stop').click().catch(() => undefined);
        await ctx.close();
      }
    }
  },
  // Sweep 15 (L2): on a phone, a live voice session (and a card waiting on it) leads the footer, whole: End is inside
  // the viewport and not covered, the mute control shows, and the header's persona control is still there.
  async 6(browser, H) {
    const { ctxFor, watch, go, shot, note, sleep, reset, PORTAL } = H;
    const turns = [{ said: 'Tell #auth-migration the cutover order is decided.', call: { name: 'message', arguments: { target: { kind: 'channel', name: 'auth-migration' }, text: 'The cutover order is decided.', thread: null, attach: null } } }];
    const measure = (page) => page.evaluate(() => {
      const box = (id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const shown = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
        const inside = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
        const hitEl = shown ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
        return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), shown, inside, unobstructed: !!hitEl && (hitEl === el || el.contains(hitEl)) };
      };
      const row = document.querySelector('[data-testid="shell-footer-row"]');
      return {
        vw: window.innerWidth, end: box('shell-voice-dock-stop'), mute: box('shell-voice-dock-mute'), persona: box('masquerade-menu-compact'),
        live: !!document.querySelector('[data-testid="shell-footer-voice"][data-voice-live]'),
        rowH: row ? Math.round(row.getBoundingClientRect().height) : null, hscroll: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    const ok = (m, persona) => !!m.end && m.end.shown && m.end.inside && m.end.unobstructed && !!m.mute && m.mute.shown && m.mute.inside && m.hscroll <= 0 && (!persona || (!!m.persona && m.persona.shown && m.persona.inside));
    for (const w of [390, 360]) {
      await reset();
      const ctx = await ctxFor(browser, 'vera', w, 844);
      const page = await ctx.newPage(); watch(page, `6-voice-${w}`);
      await go(page, INIT);
      const r = await ctx.request.put(`${PORTAL}/api/voice/mock-script`, { data: { turns } });
      if (r.status() !== 204) { note(`6 voice footer @${w}`, false, `mock-script ${r.status()}`); await ctx.close(); continue; }
      await page.getByTestId('shell-voice-dock-start').click();
      try {
        await page.getByTestId('voice-confirm-card').waitFor({ timeout: 15000 });
        await sleep(800);
        const m = await measure(page);
        await shot(page, `6-voice-card-${w}`);
        note(`6 End inside the viewport, card pending @${w}`, ok(m, w === 390), m);
        await page.getByTestId('voice-confirm-card-cancel').click();
        await sleep(1500);
        const l = await measure(page);
        await shot(page, `6-voice-live-${w}`);
        note(`6 End inside the viewport, live @${w}`, l.live && ok(l, w === 390), l);
      } catch (e) {
        note(`6 voice footer @${w}`, false, String(e).slice(0, 200));
        await shot(page, `6-voice-${w}-failed`);
      }
      await page.getByTestId('shell-voice-dock-stop').click().catch(() => undefined);
      await ctx.close();
    }
  },
  async 5(browser, H) {
    const { ctxFor, watch, go, body, shot, note, sleep } = H;
    // `need`: the headers that must be on screen at each width (the others may fold into "+N columns");
    // `sample`: text a row shows when the table has stacked into cards (no header row at all).
    const pages = [
      ['decisions', 'vera', '/iq/decisions', 'table', { 1440: ['Decision', 'Status', 'Decided'], 1280: ['Decision', 'Status', 'Decided'], 1024: ['Decision', 'Status', 'Decided'] }, 'Judge model for canary evaluation'],
      ['budgets', 'vera', '/admin/budgets', 'table', { 1440: ['Initiative', 'Budget'], 1280: ['Initiative', 'Budget'], 1024: ['Initiative', 'Budget'], 768: ['Initiative', 'Budget'], 390: ['Initiative', 'Budget'] }, null],
      // Narrow batch: Step is "3/6", Motion an icon chip and Lead outlasts Contributors and Updated, so Lead shows at
      // 1280 (Step, Motion and Contributors still fold into "+3" there; everything shows at 1440).
      ['assessment-teams', 'asha', '/assessment/teams', '[data-testid=assessment-teams] table, table', { 1440: ['Team', 'Lead', 'Motion', 'Step', 'Certification'], 1280: ['Team', 'Lead', 'Certification'], 1024: ['Team', 'Certification'] }, 'Kubernetes Operator'],
    ];
    const measure = (page, tableSel) => page.evaluate((sel) => {
      const tables = [...document.querySelectorAll(sel)].filter((t) => t.getBoundingClientRect().width > 0);
      const out = tables.map((t) => {
        const heads = [...t.querySelectorAll('thead th')].filter((h) => h.getBoundingClientRect().width > 0 && getComputedStyle(h).display !== 'none').map((h) => h.innerText.replace(/\s+/g, ' ').trim());
        const root = t.closest('[data-responsive-columns]') ?? t.parentElement;
        const hiddenAttr = (t.closest('[data-hidden-columns]') ?? root)?.getAttribute('data-hidden-columns');
        const clipped = [...t.querySelectorAll('th,td')].filter((c) => c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).overflow !== 'visible' && getComputedStyle(c).textOverflow !== 'ellipsis').map((c) => c.innerText.slice(0, 30));
        const ell = [...t.querySelectorAll('th,td,td *')].filter((c) => getComputedStyle(c).textOverflow === 'ellipsis' && c.scrollWidth > c.clientWidth + 1).length;
        return { heads, hiddenAttr, clipped: clipped.slice(0, 4), ellipsized: ell, w: Math.round(t.getBoundingClientRect().width) };
      });
      // ui-components 2.519.0 `hiddenColumnsControl="header"`: ONE "+N columns" control in the "More" header; rows carry
      // only a chevron, never a repeated "+N columns" link.
      const more = [...document.querySelectorAll('[data-testid=datatable-more-header-control]')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.innerText.trim());
      const rowMore = [...document.querySelectorAll('tbody button')].filter((b) => /^\+\d+ columns?$/.test(b.innerText.trim())).length;
      return { tables: out, more, rowMore, hscroll: document.documentElement.scrollWidth - window.innerWidth, bodyScroll: document.body.scrollWidth - window.innerWidth };
    }, tableSel);
    for (const [name, who, url, sel, need, sample] of pages) {
      const ctx = await ctxFor(browser, who, 1440, 900);
      const page = await ctx.newPage(); watch(page, `5-${name}`);
      let prev = null;
      for (const w of [1440, 1280, 1024, 768, 390]) {
        await page.setViewportSize({ width: w, height: 900 });
        await go(page, url);
        const m = await measure(page, sel);
        await shot(page, `5-${name}-${w}`);
        let popover = null;
        if (m.more.length) {
          await page.getByTestId('datatable-more-header-control').first().click().catch(() => undefined);
          await sleep(500);
          popover = await page.evaluate(() => (document.querySelector('[data-testid=datatable-more-header-menu]')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300));
          await shot(page, `5-${name}-${w}-popover`);
          await page.keyboard.press('Escape');
        }
        const first = m.tables[0] ?? null;
        // Either every needed header is shown (a "+N" control then lists the rest, never empty), or the table has
        // stacked into cards: no header row, and the rows' text is still on the page.
        const heads = (first?.heads ?? []).map((h) => h.toLowerCase());
        const missing = (need[w] ?? []).filter((h) => !heads.includes(h.toLowerCase()));
        const cards = !first && !!sample && (await body(page)).includes(sample);
        const moreOk = m.more.length === 0 || (popover ?? '').length > 0;
        note(`5 ${name} @${w}`, m.hscroll <= 0 && m.bodyScroll <= 0 && moreOk && m.rowMore === 0 && ((!!first && missing.length === 0) || cards), { mode: first ? 'table' : cards ? 'cards' : 'none', missing,  heads: first?.heads, more: m.more, rowMore: m.rowMore, popover, hscroll: m.hscroll, clipped: first?.clipped, ellipsized: first?.ellipsized, tableW: first?.w });
      }
      // resize within one load: 1440 -> 800 -> 1440
      await page.setViewportSize({ width: 1440, height: 900 });
      await go(page, url);
      const a = (await measure(page, sel)).tables[0]?.heads ?? [];
      await page.setViewportSize({ width: 800, height: 900 }); await sleep(1200);
      const b = (await measure(page, sel)).tables[0]?.heads ?? [];
      await shot(page, `5-${name}-resized-800`);
      await page.setViewportSize({ width: 1440, height: 900 }); await sleep(1200);
      const c = (await measure(page, sel)).tables[0]?.heads ?? [];
      await shot(page, `5-${name}-resized-back-1440`);
      // The same columns come back after a narrow detour. (800 may show more columns than 1440 once it is cards or has room.)
      note(`5 ${name} resize roundtrip`, a.length > 0 && b.length > 0 && JSON.stringify(a) === JSON.stringify(c), { at1440: a, at800: b, back1440: c });
      await ctx.close();
    }
  },
};
