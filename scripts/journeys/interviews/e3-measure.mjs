// Browser-side measures for the candidate-side walk (E3-door.mjs): one result object per state; runs inside page.evaluate. Not a piece (lower-case name).
export function measureAll(opts) {
  const SCALE = [11, 12, 14, 16, 20];
  const vis = (el) => { const b = el.getBoundingClientRect(), s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'; };
  const name = (el) => {
    const al = el.getAttribute('aria-label'); if (al) return al.trim();
    const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? '').join(' ').trim(); if (t) return t; }
    const t = (el.innerText || el.textContent || '').trim(); if (t) return t;
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l?.textContent.trim()) return l.textContent.trim(); }
    const wrap = el.closest('label'); if (wrap?.textContent.trim()) return wrap.textContent.trim();
    return (el.getAttribute('title') || el.getAttribute('placeholder') || el.querySelector('img[alt]')?.getAttribute('alt') || '').trim();
  };
  const desc = (el) => `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}"${(name(el) || '').slice(0, 24)}"`;
  const r = (e) => e.getBoundingClientRect();
  const out = {};
  const W = innerWidth;
  out.sideways = document.scrollingElement.scrollWidth - W; // > 0 = scrolls sideways
  const ctrlSel = 'button, [role=tab], [role=button], input, select, textarea, a[href], [role=switch], [role=checkbox], [role=radio]';
  const ctrls = [...document.querySelectorAll(ctrlSel)].filter(vis).filter((e) => !e.closest('.cm-editor, video, [aria-hidden=true]'));
  // 1. controls cut by an overflow-clipping ancestor, or past the window
  const cut = [];
  for (const c of ctrls) {
    const b = r(c);
    if (b.right > W + 1 || b.left < -1) cut.push(`${desc(c)} off-window ${Math.round(b.left)}..${Math.round(b.right)}`);
    for (let p = c.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(hidden|clip)/.test(s.overflowX) || /(hidden|clip)/.test(s.overflowY)) {
        const pb = r(p);
        if (pb.width && (b.right > pb.right + 1 || b.left < pb.left - 1 || b.bottom > pb.bottom + 1 || b.top < pb.top - 1) && !(/(auto|scroll)/.test(s.overflowX + s.overflowY))) { cut.push(`${desc(c)} cut by ${p.getAttribute('data-testid') || p.tagName.toLowerCase()} (${Math.round(b.left)}-${Math.round(b.right)} vs ${Math.round(pb.left)}-${Math.round(pb.right)}; ${Math.round(b.top)}-${Math.round(b.bottom)} vs ${Math.round(pb.top)}-${Math.round(pb.bottom)})`); break; }
      }
    }
  }
  out.cut = cut.slice(0, 8);
  // 2. overlap between controls
  const ov = [];
  for (let i = 0; i < ctrls.length; i++) for (let j = i + 1; j < ctrls.length; j++) {
    const a = ctrls[i], b = ctrls[j]; if (a.contains(b) || b.contains(a)) continue;
    const A = r(a), B = r(b); const w = Math.min(A.right, B.right) - Math.max(A.left, B.left), h = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
    if (w > 2 && h > 2) ov.push(`${desc(a)} x ${desc(b)} ${Math.round(w)}x${Math.round(h)}`);
  }
  out.overlap = ov.slice(0, 8);
  // 3. bars on one row
  const bars = {};
  for (const tid of opts.bars ?? []) {
    const bar = document.querySelector(`[data-testid="${tid}"]`); if (!bar || !vis(bar)) continue;
    const items = [...bar.querySelectorAll(ctrlSel)].filter(vis).filter((e) => !e.closest('[role=dialog]') && !(opts.barExclude && e.closest(opts.barExclude)));
    if (!items.length) continue;
    const tops = items.map((e) => Math.round(r(e).top + r(e).height / 2));
    bars[tid] = { n: items.length, spreadCentre: Math.max(...tops) - Math.min(...tops), h: Math.round(r(bar).height) };
  }
  [...document.querySelectorAll('[role=tablist]')].filter(vis).forEach((tl, i) => { const it = [...tl.querySelectorAll('[role=tab]')].filter(vis); if (!it.length) return; const t = it.map((e) => Math.round(r(e).top + r(e).height / 2)); const hs = it.map((e) => Math.round(r(e).height)); bars[`tablist${i}`] = { n: it.length, spreadCentre: Math.max(...t) - Math.min(...t), heights: [...new Set(hs)].join('/') }; });
  out.bars = bars;
  // 4. geometry of named boxes
  const geo = {};
  for (const tid of opts.boxes ?? []) { const e = document.querySelector(`[data-testid="${tid}"]`); if (e && vis(e)) { const b = r(e); geo[tid] = `${Math.round(b.left)},${Math.round(b.top)}..${Math.round(b.right)},${Math.round(b.bottom)}`; } }
  out.geo = geo;
  // 5. type scale
  const off = new Map();
  const seq = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim(); if (!t) continue; const p = n.parentElement; if (!p || !vis(p) || p.closest('script,style,.cm-editor,[aria-hidden=true],svg')) continue;
    const fs = parseFloat(getComputedStyle(p).fontSize);
    if (!SCALE.includes(Math.round(fs * 10) / 10)) { const k = `${fs}px`; if (!off.has(k)) off.set(k, []); if (off.get(k).length < 2) off.get(k).push(t.slice(0, 24)); }
    seq.push([Math.round(p.getBoundingClientRect().top), fs, t.slice(0, 18), Math.round(p.getBoundingClientRect().left)]);
  }
  out.offScale = [...off].map(([k, v]) => `${k} ${JSON.stringify(v)}`);
  // 6. headings
  const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')].filter(vis).map((h) => ({ l: h.getAttribute('aria-level') ? +h.getAttribute('aria-level') : +h.tagName[1] || 0, t: h.textContent.trim().slice(0, 20) }));
  const skips = []; let prev = 0; for (const h of hs) { if (prev && h.l > prev + 1) skips.push(`h${prev}->h${h.l} "${h.t}"`); prev = h.l; }
  out.headings = hs.map((h) => h.l).join(''); out.headingSkips = skips;
  // 7. names
  out.noName = ctrls.filter((c) => !name(c)).map(desc).slice(0, 6);
  // 8. staff words
  if (opts.guest) {
    const txt = document.body.innerText;
    const re = /huddle|\b(?:iv|u|op|cand|rd)-[a-z0-9]{4,}\b|in_progress|\bscheduled\b|\bdebrief\b|scorecard|interviewer notes|\bstaff\b|\bundefined\b|\bnull\b/gi;
    out.staffWords = [...txt.matchAll(re)].slice(0, 4).map((x) => `${x[0]} <- "${txt.slice(Math.max(0, x.index - 40), x.index + 40).replace(/\s+/g, ' ')}"`);
  }
  out.seqSample = opts.seq ? seq.slice(0, 60) : undefined;
  return out;
}
