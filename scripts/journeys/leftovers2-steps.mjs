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
      if (w === 390) { await page.getByTestId('shell-footer-context-chat').click().catch(() => undefined); await sleep(1500); }
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
    await page.keyboard.type(`/comment ${TEXT}`, { delay: 15 });
    await sleep(400);
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
        await page.getByRole('button', { name: /Workflow/ }).first().click().catch(() => undefined);
        await sleep(400);
        await page.getByText('Unblock this item', { exact: true }).first().click().catch(() => undefined);
        await sleep(700);
        const prefill = await page.locator('[data-testid=rich-chat-composer] .ProseMirror, [data-testid=initiative-central-composer] .ProseMirror').first().innerText().catch(() => 'NO EDITOR');
        await shot(page, `3-${name}-prefill-${w}`);
        const nextLine = step.replace(/^Next step /, '').replace(/ Open discussion$/, '');
        const planned = (prefill.match(/Planned next step: ([^\n]*)/) ?? [])[1] ?? '';
        const named = step.includes(topic) && prefill.includes(topic.slice(0, 20)) || planned.includes(topic);
        note(`3 ${name} @${w}`, step.includes(`"${topic}"`) && !/ decides\b/.test(step.split('Blocked on')[0]) && planned.length > 0 && planned.startsWith(nextLine.split('. ')[0].slice(0, 40)), { step, planned, prefill: prefill.replace(/\s+/g, ' ').slice(0, 400) });
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
  async 5(browser, H) {
    const { ctxFor, watch, go, shot, note, sleep } = H;
    const pages = [
      ['decisions', 'vera', '/iq/decisions', 'table'],
      ['budgets', 'vera', '/admin/budgets', 'table'],
      ['assessment-teams', 'asha', '/assessment/teams', '[data-testid=assessment-teams] table, table'],
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
      const more = [...document.querySelectorAll('button')].filter((b) => /^\+\d+ columns?$/.test(b.innerText.trim())).map((b) => b.innerText.trim());
      return { tables: out, more, hscroll: document.documentElement.scrollWidth - window.innerWidth, bodyScroll: document.body.scrollWidth - window.innerWidth };
    }, tableSel);
    for (const [name, who, url, sel] of pages) {
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
          await page.locator('button', { hasText: /^\+\d+ columns?$/ }).first().click().catch(() => undefined);
          await sleep(500);
          popover = await page.evaluate(() => (document.querySelector('[data-testid$="-popover"]')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300));
          await shot(page, `5-${name}-${w}-popover`);
          await page.keyboard.press('Escape');
        }
        const first = m.tables[0] ?? null;
        note(`5 ${name} @${w}`, m.hscroll <= 0 && m.bodyScroll <= 0 && !!first, { heads: first?.heads, more: m.more, popover, hscroll: m.hscroll, clipped: first?.clipped, ellipsized: first?.ellipsized, tableW: first?.w });
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
      note(`5 ${name} resize roundtrip`, JSON.stringify(a) === JSON.stringify(c) && b.length < a.length, { at1440: a, at800: b, back1440: c });
      await ctx.close();
    }
  },
};
