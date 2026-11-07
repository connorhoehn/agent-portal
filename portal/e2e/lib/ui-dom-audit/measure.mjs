/** Serializable browser-side collector. No React, application imports or network. */
export function measureDOM({ contract, selectors, required = [], composerExpectation, probe }) {
  const issues = [], coverage = [], samples = [], fingerprints = [], geometry = [];
  const selectorCache = new WeakMap();
  const tolerance = contract.tolerance ?? 1;
  // checkVisibility(): a closed <details>'s contents (content-visibility hidden)
  // keep a laid-out box but paint nothing; whether that box has been laid out
  // yet depends on what forced layout last, so judging it made cases unstable.
  const visible = el => { const b = el.getBoundingClientRect(), s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.clip.replace(/\s/g, '') !== 'rect(0px,0px,0px,0px)' && s.clipPath !== 'inset(50%)' && (typeof el.checkVisibility !== 'function' || el.checkVisibility()); };
  const selectorOf = el => {
    if (el === document.documentElement) return ':root';
    if (selectorCache.has(el)) return selectorCache.get(el);
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (n.id && !/^(_r_|:r|radix-)/.test(n.id)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const testId = n.getAttribute('data-testid');
      if (testId && document.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`).length === 1) { parts.unshift(`[data-testid="${CSS.escape(testId)}"]`); break; }
      const tag = n.tagName.toLowerCase();
      const siblings = n.parentElement ? [...n.parentElement.children].filter(s => s.tagName === n.tagName) : [];
      parts.unshift(tag + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(n) + 1})` : ''));
    }
    const result = parts.join(' > '); selectorCache.set(el, result); return result;
  };
  // `$alias` resolves through the adapter's bindings; `$alias|css` falls back to the CSS when the alias is unbound.
  const css = name => { if (!name?.startsWith('$')) return name; const [alias, fallback] = name.slice(1).split('|'); return selectors[alias] ?? fallback; };
  const query = (name, includeHidden = false) => {
    const s = css(name);
    if (!s) throw new Error(`Unbound selector ${name}`);
    const all = [...document.querySelectorAll(s)];
    return includeHidden ? all : all.filter(visible);
  };
  const rect = el => { const b = el.getBoundingClientRect(); return Object.fromEntries(['x', 'y', 'left', 'right', 'top', 'bottom', 'width', 'height'].map(k => [k, Math.round(b[k] * 100) / 100])); };
  const add = (rule, el, property, expected, actual, category = 'violation') => issues.push({ rule: rule.id, category, owner: rule.owner ?? 'shared UI contract', selector: el ? selectorOf(el) : css(rule.selector) ?? 'document', property, expected, actual, ...(el ? { bounds: rect(el) } : {}) });
  // A token resolves on the document root, or — `scope: "element"` — on the
  // measured element, so a host-scoped override of the token (a record pane
  // setting its own content gutter) is the value that element must meet.
  const resolve = (expected, el) => {
    if (!expected || typeof expected !== 'object') return expected;
    if (expected.token) {
      const host = expected.scope === 'element' && el ? el : document.documentElement;
      const value = getComputedStyle(host).getPropertyValue(expected.token).trim();
      if (!value) throw new Error(`Missing design token ${expected.token}`);
      if (/^-?[\d.]+rem$/.test(value)) return parseFloat(value) * parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (/^-?[\d.]+(?:px)?$/.test(value)) return parseFloat(value);
      throw new Error(`Token ${expected.token} is not a pixel/rem scalar: ${value}`);
    }
    if (expected.from) {
      const el = query(expected.from)[0];
      if (!el) throw new Error(`Missing style reference ${expected.from}`);
      return getComputedStyle(el)[expected.property];
    }
    return expected;
  };
  const matches = (actual, expected, tol = tolerance) => {
    expected = resolve(expected);
    if (Array.isArray(expected)) return expected.some(v => matches(actual, v, tol));
    if (typeof expected === 'number') return Number.isFinite(parseFloat(actual)) && Math.abs(parseFloat(actual) - expected) <= tol;
    if (expected && typeof expected === 'object') {
      if (expected.contains) return String(actual).includes(expected.contains);
      const n = parseFloat(actual);
      return Number.isFinite(n) && (expected.min == null || n >= expected.min - tol) && (expected.max == null || n <= expected.max + tol);
    }
    return String(actual).replace(/\s+/g, ' ').trim() === String(expected).replace(/\s+/g, ' ').trim();
  };
  const check = (rule, el, property, actual, expected) => {
    const wanted = resolve(expected, el);
    samples.push({ rule: rule.id, selector: selectorOf(el), property, actual, expected: wanted });
    if (!matches(actual, wanted, rule.tolerance ?? tolerance)) add(rule, el, property, wanted, actual);
  };
  const PLACEHOLDER_REASON = /^(?:todo|tbd|n\/?a|none|null|undefined|exempt|not applicable|coming soon|[-?.…]+)[.!?]*$/i;
  // The URL a reader would share: path and query, never a hash or the origin.
  // A record URL is path + query + hash: hash routers (Studio's `#/work?item=…`)
  // move only the fragment, and that is still a routed record.
  const urlKey = href => { try { const u = new URL(href); return u.pathname + u.search + u.hash; } catch { return String(href); } };
  // Ink: where a reader actually sees something — visible text runs, images,
  // icons and canvases — never a padded wrapper's box. Used by the gutter,
  // row-start and sparse-row rules so full-bleed rows and hover surfaces are
  // judged by what they draw, not by the box that holds it.
  const INK_ELEMENTS = 'img, svg, canvas, video, [data-ui-text="avatar"]';
  const inkRects = (root, skip = () => false) => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode, parent = text.parentElement;
      if (!text.textContent.trim() || !parent || !visible(parent) || parent.closest('svg, [aria-hidden="true"]') || skip(parent)) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) out.push({ el: parent, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    for (const el of [root, ...root.querySelectorAll(INK_ELEMENTS)]) {
      if (!el.matches?.(INK_ELEMENTS) || !visible(el) || el.parentElement?.closest('svg') || skip(el)) continue;
      const r = el.getBoundingClientRect();
      out.push({ el, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    return out;
  };
  // A box whose padding is the gutter: its content box is the column's reading edge.
  const contentBox = el => { const b = el.getBoundingClientRect(), s = getComputedStyle(el); return { left: b.left + parseFloat(s.paddingLeft), right: b.right - parseFloat(s.paddingRight), top: b.top, bottom: b.bottom }; };
  // Ink is only what a clipping or scrolling ancestor (below `stop`) lets through:
  // a wide table inside its own scroller is judged by the scroller's window.
  const clipToAncestors = (r, stop) => {
    let { left, right } = r;
    // A Range extends beyond its own ellipsized text element. Include that
    // element's clipping box before its ancestors when measuring painted ink.
    for (let n = r.el; n && n !== stop; n = n.parentElement) {
      if (getComputedStyle(n).overflowX === 'visible') continue;
      const c = n.getBoundingClientRect(); left = Math.max(left, c.left); right = Math.min(right, c.right);
    }
    return right - left > 1 ? { ...r, left, right } : null;
  };
  // ── Legible text (text.cramped, text.overlap, text.clipped, placeholder.squeezed) ──
  // A text run is a non-empty text node a reader can see: its parent paints
  // (no display:none / visibility:hidden / sr-only clip, no opacity-0
  // ancestor) and it is not an icon glyph (svg, aria-hidden). Each line of it
  // is judged by its EM box: the glyph rect a range reports is ~1.2em tall
  // (ascent + descent), so two tight lines (leading-none) would "touch"
  // without any ink meeting; the em box is what the eye reads as the line.
  const csCache = new Map();
  const cs = el => { let s = csCache.get(el); if (!s) { s = getComputedStyle(el); csCache.set(el, s); } return s; };
  const faded = el => { for (let n = el; n && n !== document.documentElement; n = n.parentElement) if (cs(n).opacity === '0') return true; return false; };
  const textRuns = root => {
    const out = [], seen = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, el = node.parentElement;
      if (!node.textContent.trim() || !el || el.closest('svg, [aria-hidden="true"], script, style, noscript, template, title')) continue;
      if (!seen.has(el)) seen.set(el, visible(el) && !faded(el));
      if (!seen.get(el)) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const fs = parseFloat(cs(el).fontSize) || 14;
      const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1).map(r => {
        const pad = Math.max(0, (r.height - fs) / 2);
        return { left: r.left, right: r.right, top: r.top + pad, bottom: r.bottom - pad };
      });
      if (rects.length) out.push({ node, el, fs, rects, text: node.textContent.replace(/\s+/g, ' ').trim() });
    }
    return out;
  };
  // The ancestors that clip an element's painted box, honouring containing
  // blocks: an absolutely positioned box escapes static ancestors' overflow,
  // a fixed one escapes everything below a transformed/filtered ancestor.
  // The element itself is first: its overflow clips its own text.
  const clipCache = new Map();
  const clippers = el => {
    if (clipCache.has(el)) return clipCache.get(el);
    const out = []; let pos = 'static';
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = cs(n);
      const contains = s.position !== 'static' || s.transform !== 'none' || s.filter !== 'none' || /paint|layout|strict|content/.test(s.contain);
      const holds = pos === 'fixed' ? (s.transform !== 'none' || s.filter !== 'none' || /paint|layout|strict|content/.test(s.contain)) : pos === 'absolute' ? contains : true;
      if (holds) {
        {
          const x = s.overflowX !== 'visible', y = s.overflowY !== 'visible';
          if (x || y) out.push({ n, x, y, xHard: /hidden|clip/.test(s.overflowX), yHard: /hidden|clip/.test(s.overflowY) });
        }
        pos = s.position;
      }
      if (n === document.body) break;
    }
    clipCache.set(el, out); return out;
  };
  // The padding box in viewport pixels. client* sizes are layout pixels, so a
  // box under a scale transform (a zoomed node canvas) is converted by its
  // own rendered/layout ratio.
  const innerBox = n => {
    const b = n.getBoundingClientRect();
    const sx = n.offsetWidth ? b.width / n.offsetWidth : 1, sy = n.offsetHeight ? b.height / n.offsetHeight : 1;
    const left = b.left + n.clientLeft * sx, top = b.top + n.clientTop * sy;
    return { left, top, right: left + (n.clientWidth ? n.clientWidth * sx : b.width), bottom: top + (n.clientHeight ? n.clientHeight * sy : b.height) };
  };
  // A run's rect cut to every clipping/scrolling ancestor: null when wholly
  // hidden (a collapsed panel, a row scrolled out of its list).
  const clipped = (r, el) => {
    let { left, right, top, bottom } = r;
    for (const c of clippers(el)) {
      const b = innerBox(c.n);
      if (c.x) { left = Math.max(left, b.left); right = Math.min(right, b.right); }
      if (c.y) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
    }
    return right - left > 1 && bottom - top > 1 ? { left, right, top, bottom } : null;
  };
  // The nearest stacking-context root: two runs are only comparable when they
  // paint in the same context (a popover, a sticky header or a canvas node is
  // its own layer, drawn over the page by design).
  const stackCache = new Map();
  const stackRoot = el => {
    if (stackCache.has(el)) return stackCache.get(el);
    let root = document.documentElement;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = cs(n), parent = n.parentElement ? cs(n.parentElement) : null;
      const flexItem = parent && /flex|grid/.test(parent.display);
      if (s.position === 'fixed' || s.position === 'sticky' || ((s.position !== 'static' || flexItem) && s.zIndex !== 'auto') || parseFloat(s.opacity) < 1
        || s.transform !== 'none' || s.filter !== 'none' || s.isolation === 'isolate' || s.mixBlendMode !== 'normal' || /transform|opacity|filter/.test(s.willChange)
        || /paint|layout|strict|content/.test(s.contain) || (s.backdropFilter && s.backdropFilter !== 'none') || s.clipPath !== 'none' || (s.maskImage && s.maskImage !== 'none')) { root = n; break; }
    }
    stackCache.set(el, root); return root;
  };
  // Elements layered over text by design (a count badge over an avatar)
  // declare it on the owner: data-ui-layered="<reason>".
  const layered = el => el.closest('[data-ui-layered]');
  const snippet = s => (s.length > 40 ? s.slice(0, 39) + '…' : s);
  const canvas = document.createElement('canvas').getContext('2d');
  const textWidth = (text, font) => { canvas.font = font; return canvas.measureText(text).width; };
  const fontOf = s => s.font || `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  // ── Deep-audit helpers (colour, contrast, rows of ink, regions) ──
  // Any CSS colour (oklch, color-mix, named) resolved through a 1×1 canvas.
  const colorCtx = (() => { const c = document.createElement('canvas'); c.width = c.height = 1; return c.getContext('2d', { willReadFrequently: true }); })();
  const rgbaCache = new Map();
  const toRGBA = color => {
    if (rgbaCache.has(color)) return rgbaCache.get(color);
    let out = null;
    if (color && color !== 'transparent' && !/^rgba?\([^)]*,\s*0\)$/.test(color)) {
      colorCtx.clearRect(0, 0, 1, 1); colorCtx.fillStyle = '#000'; colorCtx.fillStyle = color; colorCtx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data; out = { r, g, b, a: a / 255 };
    }
    if (!out) out = { r: 0, g: 0, b: 0, a: 0 };
    rgbaCache.set(color, out); return out;
  };
  const over = (top, base) => ({ r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 });
  // The opaque colour painted behind an element: its own and its ancestors'
  // background colours composited from the root. null when an image or
  // gradient paints behind it (contrast cannot be judged from styles).
  const bgCache = new Map();
  const backdrop = el => {
    if (bgCache.has(el)) return bgCache.get(el);
    const layers = []; let unknown = false;
    for (let n = el; n; n = n.parentElement) {
      const s = cs(n);
      if (s.backgroundImage && /gradient|url\(/.test(s.backgroundImage)) { unknown = true; break; }
      const c = toRGBA(s.backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
    }
    let out = null;
    if (!unknown) { out = { r: 255, g: 255, b: 255, a: 1 }; for (const c of layers.reverse()) out = over(c, out); }
    bgCache.set(el, out); return out;
  };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
  const opacityOf = el => { let o = 1; for (let n = el; n && n !== document.documentElement; n = n.parentElement) o *= parseFloat(cs(n).opacity); return o; };
  // A visible border: some side drawn (width ≥ 1, a style) in a colour that
  // differs from what is painted behind it.
  const borderVisible = el => {
    const s = cs(el), base = backdrop(el.parentElement ?? el);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(s[`border${side}Width`]) < 1 || /none|hidden/.test(s[`border${side}Style`])) continue;
      const c = toRGBA(s[`border${side}Color`]);
      if (!base) return true;
      if (c.a > 0 && ratio(over(c, base), base) >= 1.1) return true;
    }
    return false;
  };
  // Group rects into visual rows (vertical overlap of their middles).
  const rowsOf = rects => {
    const rows = [];
    for (const r of [...rects].sort((a, b) => a.top - b.top)) {
      const mid = (r.top + r.bottom) / 2;
      const row = rows.find(x => mid >= x.top - 1 && mid <= x.bottom + 1);
      if (row) { row.items.push(r); row.top = Math.min(row.top, r.top); row.bottom = Math.max(row.bottom, r.bottom); } else rows.push({ top: r.top, bottom: r.bottom, items: [r] });
    }
    return rows;
  };
  const inFixedLayer = (el, stop) => { for (let n = el; n && n !== stop; n = n.parentElement) if (cs(n).position === 'fixed') return true; return false; };
  // A block whose ink is centred or end-aligned: not a left-edge reading line.
  const notStartAligned = el => {
    for (let n = el, k = 0; n && k < 6; n = n.parentElement, k++) {
      const s = cs(n);
      // A control centres its own label; that says nothing about where the control sits.
      if (/^(center|right|end)$/.test(s.textAlign) && !/inline/.test(s.display) && !n.matches('button, [role="button"], input, select, th, td')) return true;
      if (/grid/.test(s.display) && /^(center|end|right)$/.test(s.justifyItems)) return true;
      if (/flex|grid/.test(s.display) && /^(center|flex-end|end|right|space-around|space-evenly)$/.test(s.justifyContent) && !/column/.test(s.flexDirection)) return true;
      if (/flex/.test(s.display) && /column/.test(s.flexDirection) && /^(center|flex-end|end)$/.test(s.alignItems)) return true;
      if (s.marginLeft === s.marginRight && parseFloat(s.marginLeft) > 8 && n.parentElement) return true;
    }
    return false;
  };
  const accName = el => {
    const label = (el.getAttribute('aria-label') ?? '').trim();
    if (label) return label;
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim(); if (t) return t; }
    if (el.matches('input, select, textarea')) {
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l?.textContent.trim()) return l.textContent.trim(); }
      const wrap = el.closest('label'); if (wrap?.textContent.trim()) return wrap.textContent.trim();
      if (['button', 'submit', 'reset'].includes(el.type) && el.value) return el.value;
      const ph = (el.getAttribute('placeholder') ?? el.getAttribute('aria-placeholder') ?? '').trim(); if (ph) return ph;
    }
    let text = '';
    const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 3) text += c.textContent; else if (c.nodeType === 1 && c.getAttribute('aria-hidden') !== 'true' && cs(c).display !== 'none') { if (c.tagName === 'IMG') text += c.getAttribute('alt') ?? ''; else if (c.tagName === 'svg' || c.tagName === 'SVG') text += c.querySelector('title')?.textContent ?? ''; else walk(c); } } };
    walk(el);
    if (text.trim()) return text.replace(/\s+/g, ' ').trim();
    return (el.getAttribute('title') ?? '').trim();
  };
  const round = v => Math.round(v * 2) / 2;
  for (const name of required) if (query(name).length === 0) add({ id: 'coverage.required', selector: name }, null, 'rendered count', '>= 1', 0, 'coverage');
  for (const rule of contract.rules) {
    try {
      // `includeHidden`: count elements whether or not they paint — a native
      // <select> hidden behind a custom trigger is still a native dropdown.
      let nodes = rule.selector ? query(rule.selector, rule.includeHidden === true) : [];
      const excluded = [];
      for (const exclusion of rule.exclude ?? []) {
        if (!exclusion.reason) throw new Error(`Exclusion on ${rule.id} needs a reason`);
        const removed = nodes.filter(el => el.matches(css(exclusion.selector)) || el.closest(css(exclusion.selector)));
        excluded.push({ reason: exclusion.reason, count: removed.length });
        nodes = nodes.filter(el => !removed.includes(el));
      }
      coverage.push({ rule: rule.id, matched: nodes.length, excluded });
      if (rule.required && nodes.length === 0) { add(rule, null, 'rendered count', '>= 1', 0, 'coverage'); continue; }
      if (rule.kind === 'composer-presence') {
        // Omitted policy is unreviewed; an explicitly malformed policy is an adapter defect.
        const mode = composerExpectation == null ? 'unclassified' : composerExpectation.mode;
        const validPolicy = composerExpectation == null || (typeof composerExpectation === 'object' && !Array.isArray(composerExpectation) && ['required', 'exempt', 'unclassified'].includes(mode));
        const reason = typeof composerExpectation?.reason === 'string' ? composerExpectation.reason.trim() : '';
        Object.assign(coverage.at(-1), { status: validPolicy ? mode : 'invalid', ...(reason ? { reason } : {}) });
        samples.push({ rule: rule.id, selector: css(rule.selector), property: 'presence policy', actual: nodes.length, expected: mode, ...(reason ? { reason } : {}) });
        if (!validPolicy) add(rule, null, 'presence policy', 'object with required, exempt or unclassified mode', mode ?? composerExpectation, 'coverage');
        else if (mode === 'required') {
          if (nodes.length === 0) add(rule, null, 'composer count', '>= 1', 0);
          else {
            for (const el of nodes) {
              const inputs = [...el.querySelectorAll(rule.input ?? '[contenteditable="true"], textarea, [role="textbox"]')].filter(visible);
              // ComposerPromptDeck owns the answer surface while a choice or
              // confirmation is active. Its actual answer buttons replace the
              // editor; a marker alone or an unrelated page button cannot.
              const answers = [...el.querySelectorAll('[data-composer-dialogue="choice"] [data-composer-prompt-option], [data-composer-dialogue="confirm"] [data-composer-prompt-option]')]
                .filter(button => visible(button) && button.matches('button') && button.textContent?.trim());
              samples.push({ rule: rule.id, selector: selectorOf(el), property: 'composer input count', actual: inputs.length, expected: '>= 1 input or active prompt answer', answers: answers.length });
              if (!inputs.length && !answers.length) add(rule, el, 'composer input count', '>= 1 visible input or active prompt answer inside composer', 0);
            }
          }
        }
        else if (mode === 'exempt' && (!reason || PLACEHOLDER_REASON.test(reason))) {
          add(rule, null, 'exemption reason', 'documented contextual reason, not blank or a placeholder', reason, 'coverage');
        }
      }
      else if (rule.kind === 'breadcrumb') {
        // Labels, not separators; a collection and its singular grouping label
        // name the same place (Design / Designs, or Runs / All runs).
        const canonical = value => value.trim().toLowerCase().replace(/^all\s+/, '').replace(/s$/, '');
        for (const nav of nodes) {
          const list = nav.querySelector('ol');
          if (!list) continue;
          const labels = [...list.children].map(li => li.querySelector('a, button, span:not([aria-hidden="true"])')).filter(el => el && visible(el));
          for (let i = 1; i < labels.length; i++) {
            if (canonical(labels[i].textContent) === canonical(labels[i - 1].textContent))
              add(rule, labels[i], 'adjacent labels', 'distinct navigation levels', [labels[i - 1].textContent, labels[i].textContent]);
          }
          const tops = labels.map(el => rect(el).top);
          if (tops.length && Math.max(...tops) - Math.min(...tops) > 4)
            add(rule, nav, 'trail lines', 'one line', tops);
          for (const label of labels) {
            if (label.scrollWidth > label.clientWidth + tolerance && getComputedStyle(label).textOverflow !== 'ellipsis')
              add(rule, label, 'overflow text', 'ellipsis with full accessible label', getComputedStyle(label).textOverflow);
          }
        }
      }
      else if (rule.kind === 'text') {
        const labels = new Set();
        for (const scope of nodes) {
          if (scope.matches('input,select,textarea')) labels.add(scope);
          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const text = walker.currentNode, parent = text.parentElement;
            if (!text.textContent.trim() || !parent || !visible(parent) || parent.closest('svg, [aria-hidden="true"]')) continue;
            if ((rule.exclude ?? []).some(e => parent.closest(css(e.selector)))) continue;
            const range = document.createRange(); range.selectNodeContents(text);
            if ([...range.getClientRects()].some(r => r.width > 1 && r.height > 1)) labels.add(parent);
          }
        }
        coverage.at(-1).textNodes = labels.size;
        for (const el of labels) for (const [property, expected] of Object.entries(rule.properties)) check(rule, el, property, getComputedStyle(el)[property], expected);
      }
      else if (rule.kind === 'style' || rule.kind === 'box') for (const el of nodes) {
        const values = rule.kind === 'style' ? getComputedStyle(el) : rect(el);
        for (const [property, expected] of Object.entries(rule.properties)) check(rule, el, property, values[property], expected);
      }
      else if (rule.kind === 'count') {
        samples.push({ rule: rule.id, selector: css(rule.selector), property: 'count', actual: nodes.length, expected: rule.expected });
        if (!matches(nodes.length, rule.expected, 0)) add(rule, nodes[0], 'count', rule.expected, nodes.length);
      }
      else if (rule.kind === 'in-viewport') for (const el of nodes) {
        // An open popup (a listbox, a menu) must sit wholly inside the viewport.
        const b = rect(el);
        const box = { left: b.left, top: b.top, right: window.innerWidth - b.right, bottom: window.innerHeight - b.bottom };
        samples.push({ rule: rule.id, selector: selectorOf(el), property: 'viewport margins', actual: box, expected: { min: 0 } });
        for (const [edge, gap] of Object.entries(box)) if (gap < -tolerance) add(rule, el, `${edge} inside viewport`, '>= 0', Math.round(gap * 100) / 100);
      }
      else if (rule.kind === 'viewport') {
        const overflow = document.documentElement.scrollWidth - innerWidth;
        samples.push({ rule: rule.id, selector: ':root', property: 'horizontal overflow', actual: overflow, expected: {max:tolerance} });
        if (overflow > tolerance) add(rule, document.documentElement, 'horizontal overflow', '<= ' + tolerance, overflow);
      }
      else if (rule.kind === 'align' || rule.kind === 'within') for (const el of nodes) {
        const anchors = rule.ancestor ? [el.parentElement?.closest(css(rule.anchor))].filter(Boolean) : query(rule.anchor);
        if (anchors.length !== 1) { add(rule, el, 'anchor count', 1, anchors.length, 'coverage'); continue; }
        const a = rect(anchors[0]), b = rect(el);
        if (rule.kind === 'align') for (const edge of rule.edges ?? ['left', 'right']) check(rule, el, edge, b[edge] - a[edge], rule.offset ?? 0);
        else for (const axis of rule.axes ?? ['x', 'y']) {
          const [start, end] = axis === 'x' ? ['left', 'right'] : ['top', 'bottom'];
          if (b[start] < a[start] - tolerance || b[end] > a[end] + tolerance) add(rule, el, axis + ' containment', [a[start], a[end]], [b[start], b[end]]);
        }
      }
      else if (rule.kind === 'gutter') {
        // The content column's reading edge: the anchor (the trail band, padded
        // by the page gutter) sets left/right; every piece of ink in the
        // column's body must sit inside it. A body flush to the rail while the
        // trail and title are inset fails; so does an action at the window edge.
        let measured = 0;
        for (const region of nodes) {
          const anchor = [...region.querySelectorAll(css(rule.anchor))].filter(visible)[0];
          if (!anchor) { add(rule, region, 'gutter anchor', css(rule.anchor), 'missing', 'coverage'); continue; }
          const edge = contentBox(anchor);
          const skip = el => anchor.contains(el) || (rule.exclude ?? []).some(e => el.closest(css(e.selector)));
          const ink = inkRects(region, skip).filter(r => r.top >= edge.bottom - tolerance).map(r => clipToAncestors(r, region)).filter(Boolean);
          measured += ink.length;
          const tol = rule.tolerance ?? tolerance;
          for (const side of rule.edges ?? ['left', 'right']) {
            const worst = side === 'left' ? ink.reduce((a, r) => (!a || r.left < a.left ? r : a), null) : ink.reduce((a, r) => (!a || r.right > a.right ? r : a), null);
            if (!worst) continue;
            const delta = Math.round((side === 'left' ? worst.left - edge.left : edge.right - worst.right) * 100) / 100;
            samples.push({ rule: rule.id, selector: selectorOf(region), property: `${side} gutter`, actual: delta, expected: { min: 0 } });
            if (delta < -tol) add(rule, worst.el, `${side} gutter (ink inside the trail's edge)`, `>= 0 (edge ${Math.round(edge[side])})`, delta);
          }
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'row-start') {
        // The first heading row under the anchor (a page title, or a
        // conversation's avatar + name when it is the page's header) starts
        // at the anchor's reading edge — not left of it, not indented.
        let measured = 0;
        for (const region of nodes) {
          const anchor = [...region.querySelectorAll(css(rule.anchor))].filter(visible)[0];
          if (!anchor) continue;
          const edge = contentBox(anchor);
          const heading = [...region.querySelectorAll(css(rule.heading ?? 'h1, h2, h3, [role="heading"]'))]
            .filter(el => visible(el) && !anchor.contains(el) && el.getBoundingClientRect().top >= edge.bottom - tolerance)
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
          if (!heading) continue;
          const band = heading.getBoundingClientRect(), mid = (band.top + band.bottom) / 2;
          // The row: ink in the region whose vertical extent crosses the heading's middle.
          const row = inkRects(region).filter(r => r.top <= mid && r.bottom >= mid);
          const start = row.reduce((a, r) => (!a || r.left < a.left ? r : a), null);
          if (!start) continue;
          measured++;
          check(rule, start.el, 'first heading row start', Math.round((start.left - edge.left) * 100) / 100, rule.offset ?? 0);
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'title-count') {
        // One title per page: headings drawn at the page-title step (or larger) in the content column.
        const min = resolve(rule.titleSize) - 0.1;
        for (const region of nodes) {
          const titles = [...region.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
            .filter(el => visible(el) && parseFloat(getComputedStyle(el).fontSize) >= min && !(rule.exclude ?? []).some(e => el.closest(css(e.selector))));
          samples.push({ rule: rule.id, selector: selectorOf(region), property: 'title-size headings', actual: titles.length, expected: rule.expected ?? 1 });
          if (!matches(titles.length, rule.expected ?? 1, 0)) add(rule, titles[1] ?? region, 'title-size headings', rule.expected ?? 1, `${titles.length}: ${titles.map(t => `${(t.textContent ?? '').trim().slice(0, 40)} (${getComputedStyle(t).fontSize})`).join(' | ')}`);
        }
      }
      else if (rule.kind === 'contained') {
        // A visible control must be wholly visible: inside the viewport, inside
        // its region (the content column, a rail), and not cut by any clipping
        // or scrolling ancestor. The exception is explicit: an ancestor matching
        // `scrollers` (a tab row, a table's scroller) may scroll the control
        // out of view, and that scroller is judged in its place.
        const tol = rule.tolerance ?? tolerance;
        for (const reason of rule.scrollers ?? []) if (!reason.reason) throw new Error(`Scroller exception on ${rule.id} needs a reason`);
        const scroller = n => (rule.scrollers ?? []).some(x => n.matches(css(x.selector)));
        for (const el of nodes) {
          let subject = el, clipped = false;
          const region = rule.region ? el.parentElement?.closest(css(rule.region)) : null;
          for (let n = el.parentElement; n && n !== document.body && n !== region; n = n.parentElement) {
            const ox = getComputedStyle(n).overflowX;
            if (ox === 'visible') continue;
            if (scroller(n)) { subject = n; continue; }
            const c = n.getBoundingClientRect(), b = subject.getBoundingClientRect();
            // Wholly outside the clip box is hidden (a collapsed panel's contents), not clipped.
            if (b.left >= c.right - tol || b.right <= c.left + tol) { clipped = true; break; }
            if (b.right > c.right + tol || b.left < c.left - tol) {
              add(rule, el, subject === el ? 'clipped by an ancestor' : 'scroller clipped by an ancestor', [Math.round(c.left), Math.round(c.right)], [Math.round(b.left), Math.round(b.right)]);
              clipped = true; break;
            }
          }
          if (clipped) continue;
          const b = subject.getBoundingClientRect();
          const bounds = { left: 0, right: innerWidth };
          if (region) { const r = region.getBoundingClientRect(); bounds.left = Math.max(bounds.left, r.left); bounds.right = Math.min(bounds.right, r.right); }
          samples.push({ rule: rule.id, selector: selectorOf(el), property: 'x containment', actual: [Math.round(b.left), Math.round(b.right)], expected: [Math.round(bounds.left), Math.round(bounds.right)] });
          if (b.right > bounds.right + tol || b.left < bounds.left - tol) add(rule, el, subject === el ? 'x containment' : 'x containment (its scroller)', [Math.round(bounds.left), Math.round(bounds.right)], [Math.round(b.left), Math.round(b.right)]);
        }
      }
      else if (rule.kind === 'sparse-row') {
        // A row of like tiles (people, avatars) packed by what they draw: on a
        // wide column a stretched grid sets each tile's ink far from the next.
        const factor = rule.maxGapRatio ?? 3, minItems = rule.minItems ?? 3;
        for (const list of nodes) {
          const items = [...list.children].filter(visible).map(item => {
            const ink = inkRects(item);
            if (!ink.length) return null;
            return { item, left: Math.min(...ink.map(r => r.left)), right: Math.max(...ink.map(r => r.right)), top: item.getBoundingClientRect().top };
          }).filter(Boolean);
          const rows = new Map();
          for (const it of items) { const key = [...rows.keys()].find(t => Math.abs(t - it.top) <= 2) ?? it.top; rows.set(key, [...(rows.get(key) ?? []), it]); }
          for (const row of rows.values()) {
            if (row.length < minItems) continue;
            row.sort((a, b) => a.left - b.left);
            const widths = row.map(r => r.right - r.left).sort((a, b) => a - b), median = widths[Math.floor(widths.length / 2)];
            const gap = Math.max(...row.slice(1).map((r, i) => r.left - row[i].right));
            samples.push({ rule: rule.id, selector: selectorOf(list), property: 'tile gap / tile width', actual: Math.round((gap / median) * 100) / 100, expected: { max: factor } });
            if (gap > factor * median + tolerance) add(rule, list, 'tile gap', `<= ${factor}x the ${Math.round(median)}px tile ink`, `${Math.round(gap)}px`);
          }
        }
      }
      else if (rule.kind === 'columns') {
        const groups = rule.children ? nodes.map(parent => [...parent.querySelectorAll(rule.children)].filter(visible).map(el => ({ name: selectorOf(el), el, box: rect(el) })))
          : [rule.regions.flatMap(name => query(name).map(el => ({ name, el, box: rect(el) })))];
        let measured = 0;
        for (const group of groups) {
          const columns = group.sort((a, b) => a.box.left - b.box.left); measured += columns.length;
          if (columns.length < rule.min || columns.length > rule.max) add(rule, null, 'column count', { min: rule.min, max: rule.max }, columns.length);
          for (let i = 1; i < columns.length; i++) {
            const prev = columns[i - 1], curr = columns[i];
            check(rule, curr.el, 'column gap', curr.box.left - prev.box.right, { min: 0, max: rule.maxGap ?? 1 });
            check(rule, curr.el, 'column top alignment', curr.box.top - prev.box.top, 0);
            check(rule, curr.el, 'column bottom alignment', curr.box.bottom - prev.box.bottom, 0);
          }
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'dock-clearance') {
        // A pinned composer dock (and the prompt deck inside it) takes layout
        // space: the content column scrolls ABOVE it. Nothing outside the dock
        // may paint inside its box — judged on each element's VISIBLE rect
        // (cut by every clipping/scrolling ancestor), so content that scrolls
        // under a scroller ending at the dock's top is fine, and content drawn
        // over or under the dock is not. Only elements that paint something of
        // their own (text, a control, an image) are judged.
        const tol = rule.tolerance ?? tolerance;
        const ignore = rule.ignore ? css(rule.ignore) : null;
        const paints = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || el.matches('button, a[href], input, select, textarea, img, svg, video, canvas, [role="button"]');
        // Pinned means it holds its place while the content scrolls: the dock
        // (or an ancestor) is sticky/fixed, or no ancestor scroll container
        // actually scrolls it. A dock laid out as the last row INSIDE a
        // scrolling column (an embedded collection command host) scrolls with
        // that column; it is not a dock, and the shell chrome under that
        // column's bottom edge is not "inside" it.
        const inScrollFlow = dock => {
          for (let n = dock; n && n !== document.documentElement; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.position === 'fixed' || cs.position === 'sticky') return false;
            if (n !== dock && /^(auto|scroll)$/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) return true;
          }
          return false;
        };
        for (const dock of nodes) {
          if (inScrollFlow(dock)) { samples.push({ rule: rule.id, selector: selectorOf(dock), property: 'dock placement', actual: 'scrolls with its column (not pinned)', expected: 'judged only when pinned' }); continue; }
          const d = dock.getBoundingClientRect();
          let found = 0;
          for (const el of document.body.querySelectorAll('*')) {
            if (found >= (rule.maxPerDock ?? 3)) break;
            if (dock.contains(el) || el.contains(dock)) continue;
            const b = el.getBoundingClientRect();
            // Cheap first: only an element whose own box reaches the dock can paint in it.
            if (!(b.bottom > d.top + tol && b.top < d.bottom - tol && b.right > d.left + tol && b.left < d.right - tol)) continue;
            if (!paints(el) || !visible(el) || (ignore && el.closest(ignore))) continue;
            let top = b.top, bottom = b.bottom, left = b.left, right = b.right;
            for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
              const cs = getComputedStyle(n);
              if (cs.position === 'fixed') break;
              if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
              const c = n.getBoundingClientRect();
              top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); left = Math.max(left, c.left); right = Math.min(right, c.right);
            }
            if (bottom - top <= tol || right - left <= tol) continue;
            if (bottom > d.top + tol && top < d.bottom - tol && right > d.left + tol && left < d.right - tol) {
              add(rule, el, 'visible bottom vs docked composer top', `<= ${Math.round(d.top)} (nothing paints inside the dock)`, Math.round(bottom));
              found++;
            }
          }
          samples.push({ rule: rule.id, selector: selectorOf(dock), property: 'elements painting inside the dock', actual: found, expected: 0 });
        }
      }
      else if (rule.kind === 'table') for (const table of nodes) {
        const rows = [...table.querySelectorAll('tbody > tr')].filter(visible).filter(row => !row.querySelector('[colspan]'));
        for (const row of rows) check(rule, row, 'row height', rect(row).height, rule.rowHeight);
        for (const th of [...table.querySelectorAll('thead th')].filter(visible)) {
          check(rule, th, 'header fontSize', getComputedStyle(th).fontSize, rule.headerFontSize);
          check(rule, th, 'header fontWeight', getComputedStyle(th).fontWeight, rule.headerFontWeight);
        }
        for (const cell of [...table.querySelectorAll('tbody td:not([colspan])')].filter(visible)) {
          if (rule.bodyFontSize != null) check(rule, cell, 'cell fontSize', getComputedStyle(cell).fontSize, rule.bodyFontSize);
          if (rule.bodyFontFamily != null) check(rule, cell, 'cell fontFamily', getComputedStyle(cell).fontFamily, rule.bodyFontFamily);
          check(rule, cell, 'cell paddingLeft', getComputedStyle(cell).paddingLeft, rule.cellInset);
          check(rule, cell, 'cell paddingRight', getComputedStyle(cell).paddingRight, rule.cellInset);
        }
        coverage.at(-1).rows = (coverage.at(-1).rows ?? 0) + rows.length;
      }
      else if (rule.kind === 'composer') for (const el of nodes) {
        const inputs = [...el.querySelectorAll(rule.input)].filter(visible);
        check(rule, el, 'input count', inputs.length, 1);
        for (const side of ['paddingLeft', 'paddingRight']) check(rule, el, side, getComputedStyle(el)[side], rule.inset);
        const background = getComputedStyle(el, rule.pseudo ?? '::before');
        if (background.content === 'none' || background.backgroundImage === 'none') add(rule, el, 'backdrop', 'painted pseudo-element', 'missing');
        for (const side of ['left', 'right', 'top', 'bottom']) if (parseFloat(background[side]) > tolerance) add(rule, el, 'backdrop ' + side, '<= 0', background[side]);
        const anchor = el.parentElement?.closest(css(rule.boundary));
        if (!anchor) add(rule, el, 'composer boundary', css(rule.boundary), 'missing', 'coverage');
        else for (const edge of ['left', 'right']) check(rule, el, 'shelf ' + edge, rect(el)[edge] - rect(anchor)[edge], 0);
      }
      else if (rule.kind === 'popover-fit') for (const el of nodes) {
        // An open anchored panel must fit the viewport, must not cover the
        // control that opened it, and — when it has a header (title, tabs,
        // "Mark all read") — must scroll a region inside itself rather than
        // scrolling as a whole, which carries the header away with the feed.
        const b = rect(el), margin = rule.margin ?? 0;
        samples.push({ rule: rule.id, selector: selectorOf(el), property: 'viewport fit', actual: [b.top, b.bottom], expected: [margin, innerHeight - margin] });
        if (b.top < margin - tolerance || b.bottom > innerHeight - margin + tolerance) add(rule, el, 'y containment', [margin, innerHeight - margin], [b.top, b.bottom]);
        if (b.left < margin - tolerance || b.right > innerWidth - margin + tolerance) add(rule, el, 'x containment', [margin, innerWidth - margin], [b.left, b.right]);
        const triggers = [...document.querySelectorAll(rule.trigger ?? '[aria-expanded="true"]')].filter(t => visible(t) && !el.contains(t));
        for (const trigger of triggers) {
          const t = rect(trigger);
          const overlap = Math.min(b.right, t.right) - Math.max(b.left, t.left) > tolerance && Math.min(b.bottom, t.bottom) - Math.max(b.top, t.top) > tolerance;
          samples.push({ rule: rule.id, selector: selectorOf(el), property: 'covers trigger', actual: overlap, expected: false });
          if (overlap) add(rule, el, 'covers trigger', 'opens beside its trigger, not over it', selectorOf(trigger));
        }
        const style = getComputedStyle(el);
        const scrollsWhole = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + tolerance;
        const header = rule.header ? [...el.querySelectorAll(css(rule.header))].find(visible) : null;
        samples.push({ rule: rule.id, selector: selectorOf(el), property: 'scroll region', actual: scrollsWhole && header ? 'whole panel' : 'inner', expected: 'inner' });
        if (scrollsWhole && header) add(rule, el, 'scroll region', 'a scrolling region inside the panel; the header stays in view', `the whole panel scrolls (${el.scrollHeight}px in ${el.clientHeight}px), carrying ${selectorOf(header)}`);
      }
      else if (rule.kind === 'panel-inset') {
        // Inside an anchored panel (popover, dialog, drawer) every block shares
        // the header's inset: no ink starts left of the header's first ink or
        // ends right of the same inset from the panel's right edge. A
        // start-aligned empty state flush on the panel's edge under an inset
        // title and tab row is the reported shape. Judged on ink, clipped to
        // the panel's scrolling/clipping descendants, so a full-bleed row whose
        // text keeps the inset passes. A panel inside another is judged on its
        // own; a panel with no heading is unexercised.
        const tol = rule.tolerance ?? 2;
        let measured = 0;
        for (const panel of nodes) {
          const nested = n => n !== panel && n.closest(css(rule.selector)) !== panel;
          const heading = [...panel.querySelectorAll(css(rule.header ?? 'h1, h2, h3, [role="heading"]'))].find(h => visible(h) && !nested(h));
          if (!heading) continue;
          const headInk = inkRects(heading);
          if (!headInk.length) continue;
          const p = panel.getBoundingClientRect();
          const edge = Math.min(...headInk.map(r => r.left)), inset = edge - p.left;
          const skip = el => nested(el) || (rule.exclude ?? []).some(e => el.closest(css(e.selector)));
          const ink = inkRects(panel, skip).map(r => clipToAncestors(r, panel)).filter(Boolean);
          measured++;
          const left = ink.reduce((a, r) => (!a || r.left < a.left ? r : a), null), right = ink.reduce((a, r) => (!a || r.right > a.right ? r : a), null);
          const dl = left ? Math.round((left.left - edge) * 100) / 100 : 0, dr = right ? Math.round((p.right - inset - right.right) * 100) / 100 : 0;
          samples.push({ rule: rule.id, selector: selectorOf(panel), property: 'panel inset', actual: { left: dl, right: dr, inset: Math.round(inset) }, expected: { min: 0 } });
          if (dl < -tol) add(rule, left.el, 'left inset (ink left of the panel header)', `>= ${Math.round(inset)}px from the panel edge (the header's inset)`, `${Math.round(left.left - p.left)}px`);
          if (dr < -tol) add(rule, right.el, 'right inset (ink past the header inset)', `<= panel right - ${Math.round(inset)}px`, `${Math.round(p.right - right.right)}px from the panel's right edge`);
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'panel-empty') {
        // An anchored panel whose content is an empty state shrinks to that
        // content: its fixed height is a maximum, not a minimum. Judged on
        // the blank bands between what the panel draws (ink: text, icons,
        // images) — from its padded top to its padded bottom — so a pinned
        // footer link under a blank 300px area still fails.
        const maxGap = rule.maxGap ?? 96, tol = rule.tolerance ?? tolerance;
        let measured = 0;
        for (const panel of nodes) {
          const empty = [...panel.querySelectorAll(css(rule.empty))].filter(visible);
          if (!empty.length) continue;
          measured++;
          const p = panel.getBoundingClientRect(), s = getComputedStyle(panel);
          const top = p.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop), bottom = p.bottom - parseFloat(s.borderBottomWidth) - parseFloat(s.paddingBottom);
          const bands = inkRects(panel).map(r => [Math.max(top, r.top), Math.min(bottom, r.bottom)]).filter(([a, b]) => b - a > 1).sort((a, b) => a[0] - b[0]);
          let cursor = top, gap = 0, at = top;
          for (const [a, b] of bands) { if (a - cursor > gap) { gap = a - cursor; at = cursor; } cursor = Math.max(cursor, b); }
          if (bottom - cursor > gap) { gap = bottom - cursor; at = cursor; }
          gap = Math.round(gap * 100) / 100;
          samples.push({ rule: rule.id, selector: selectorOf(panel), property: 'largest blank band', actual: gap, expected: { max: maxGap } });
          if (gap > maxGap + tol) add(rule, panel, 'blank band in an empty panel', `<= ${maxGap}px (the panel shrinks to its empty state; its height cap is a maximum)`, `${Math.round(gap)}px blank from y=${Math.round(at)} in a ${Math.round(p.height)}px panel`);
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'composer-last') {
        // A page's composer is docked at the bottom of its column: nothing is
        // laid out below it in that column (the dock that holds it excepted —
        // a call strip under the composer belongs to the dock), and its band
        // (the surface's painted backdrop) spans the column edge to edge, never
        // a decorated strip with side margins inside a section. Content below
        // the composer counts whether or not it is scrolled into view.
        const tol = rule.tolerance ?? tolerance;
        let measured = 0;
        for (const composer of nodes) {
          const column = composer.parentElement?.closest(css(rule.column));
          if (!column) { add(rule, composer, 'composer column', css(rule.column), 'missing', 'coverage'); continue; }
          measured++;
          const c = composer.getBoundingClientRect(), col = column.getBoundingClientRect();
          const dock = rule.dock ? composer.closest(css(rule.dock)) : null;
          const ignore = rule.ignore ? css(rule.ignore) : null;
          const layer = el => { for (let n = el; n && n !== column; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return true; return false; };
          const skip = el => composer.contains(el) || (dock && column.contains(dock) && dock.contains(el)) || (ignore && el.closest(ignore)) || layer(el);
          // Ink inside a scroller or clipping box that does NOT hold the composer
          // is cut to it: rows scrolled past a list that ends above the dock are
          // above the composer in the flow, not below it. Ink sharing the
          // composer's scroller is not cut — out of view below it still counts.
          const ownWindow = r => {
            let { top, bottom } = r;
            for (let n = r.el.parentElement; n && n !== column; n = n.parentElement) {
              if (getComputedStyle(n).overflowY === 'visible' || n.contains(composer)) continue;
              const b = n.getBoundingClientRect(); top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom);
            }
            return bottom - top > 1 ? { ...r, top, bottom } : null;
          };
          const below = inkRects(column, skip).map(r => clipToAncestors(r, column)).filter(Boolean).map(ownWindow).filter(r => r && r.top >= c.bottom - tol && r.right > c.left + tol && r.left < c.right - tol).sort((a, b) => a.top - b.top);
          samples.push({ rule: rule.id, selector: selectorOf(composer), property: 'content below the composer', actual: below.length, expected: 0 });
          if (below.length) add(rule, below[0].el, 'content below the composer', `nothing in ${selectorOf(column)} below the composer (bottom ${Math.round(c.bottom)})`, `${below.length} piece(s) of ink, first "${snippet((below[0].el.textContent ?? '').trim()) || below[0].el.tagName.toLowerCase()}" at y=${Math.round(below[0].top)}`);
          const margins = { left: Math.round((c.left - col.left) * 100) / 100, right: Math.round((col.right - c.right) * 100) / 100 };
          samples.push({ rule: rule.id, selector: selectorOf(composer), property: 'band side margins', actual: margins, expected: 0 });
          for (const side of ['left', 'right']) if (Math.abs(margins[side]) > tol) add(rule, composer, `band ${side} margin`, `the composer band spans ${selectorOf(column)} (0px)`, `${margins[side]}px`);
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'section-empty') {
        // A page section with nothing to show takes one row: its title and
        // one quiet line, not a heading over a "nothing here" paragraph. A
        // section qualifies when it holds its own empty state (`empty`, not a
        // nested section's) and no other ink apart from headings and controls
        // (a header link or button); its ink must then sit on `maxLines` lines.
        const maxLines = rule.maxLines ?? 1;
        let measured = 0;
        for (const section of nodes) {
          const own = el => el.closest(css(rule.selector)) === section;
          const empties = [...section.querySelectorAll(css(rule.empty))].filter(e => visible(e) && own(e));
          if (!empties.length) continue;
          const ink = inkRects(section, el => !own(el));
          const other = ink.filter(r => !r.el.closest(css(rule.empty)) && !r.el.closest('h1, h2, h3, h4, h5, h6, [role="heading"], button, a[href], [role="button"]'));
          if (other.length) continue;
          measured++;
          const tops = ink.map(r => ({ top: r.top, h: r.bottom - r.top })).sort((a, b) => a.top - b.top);
          let lines = 0, last = -Infinity;
          for (const t of tops) if (t.top > last + t.h * 0.6) { lines++; last = t.top; }
          const h = Math.round(section.getBoundingClientRect().height);
          samples.push({ rule: rule.id, selector: selectorOf(section), property: 'empty section lines', actual: lines, expected: { max: maxLines } });
          if (lines > maxLines) add(rule, section, 'empty section lines', `<= ${maxLines} (the title and one quiet line on one row)`, `${lines} lines, ${h}px: "${snippet((empties[0].textContent ?? '').trim())}"`);
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'surface-distinct') for (const el of nodes) {
        // A surface that is meant to read as its own region (a board lane)
        // paints a background the reader can tell apart from what it sits on.
        const painted = c => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return c !== 'transparent'; const parts = m[1].split(/[\s,/]+/).filter(Boolean); return parts.length < 4 || parseFloat(parts[3]) > 0; };
        const own = getComputedStyle(el).backgroundColor;
        let behind = null;
        for (let n = el.parentElement; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (painted(c)) { behind = c; break; } }
        behind ??= 'rgb(255, 255, 255)';
        samples.push({ rule: rule.id, selector: selectorOf(el), property: 'backgroundColor', actual: own, expected: `painted, not ${behind}` });
        if (!painted(own)) add(rule, el, 'backgroundColor', 'a painted surface distinct from its background', own);
        else if (own.replace(/\s/g, '') === behind.replace(/\s/g, '')) add(rule, el, 'backgroundColor', `distinct from the surface behind it (${behind})`, own);
      }
      else if (rule.kind === 'record-popout') {
        // Judged only after a row or record-detail action was activated (the
        // state's probe). Allowed kinds are named by semantic marker.
        const activation = probe?.kind === 'row-activation' ? probe : null;
        Object.assign(coverage.at(-1), { matched: activation ? 1 : 0, ...(activation ? { trigger: activation.trigger } : {}) });
        if (activation) {
          const allowed = el => (rule.allow ?? []).some(a => el.matches(css(a)));
          const popouts = nodes.filter(el => !allowed(el) && !nodes.some(other => other !== el && !allowed(other) && other.contains(el)));
          samples.push({ rule: rule.id, selector: 'probe', property: `popouts after ${activation.trigger}`, actual: popouts.length, expected: 0 });
          for (const el of popouts) add(rule, el, 'record surface', 'the record routed into the content column or split layout (no drawer/modal)', `${el.getAttribute('data-ui-dialog') ?? el.getAttribute('role') ?? el.tagName.toLowerCase()} opened by ${activation.trigger}${activation.label ? ` "${activation.label}"` : ''}`);
          if (activation.trigger === 'row') {
            const before = urlKey(activation.beforeUrl), after = urlKey(activation.afterUrl);
            samples.push({ rule: rule.id, selector: 'probe', property: 'url changed by row activation', actual: before !== after, expected: true });
            if (before === after) add(rule, null, 'url after row activation', `a record URL other than ${before}`, after);
          }
          if (activation.blockedWrites?.length) add(rule, null, 'writes during activation', 'none (activation is navigation)', activation.blockedWrites.join(', '));
        }
      }
      else if (rule.kind === 'row-activatable') {
        let rows = 0;
        for (const table of nodes) {
          const host = table.closest('[data-collection-rows]');
          if (host?.getAttribute('data-collection-rows') === 'static') {
            const reason = (host.getAttribute('data-collection-rows-reason') ?? '').trim();
            samples.push({ rule: rule.id, selector: selectorOf(table), property: 'static rows reason', actual: reason, expected: 'documented reason' });
            if (!reason || PLACEHOLDER_REASON.test(reason)) add(rule, table, 'static rows reason', 'documented reason, not blank or a placeholder', reason, 'coverage');
            continue;
          }
          const body = [...table.querySelectorAll(':scope > tbody > tr')].filter(visible).filter(row => !row.querySelector('[colspan]'));
          rows += body.length;
          const activatable = row => {
            const focusable = row.tabIndex >= 0 || ['link', 'button'].includes(row.getAttribute('role'));
            return (focusable && getComputedStyle(row).cursor === 'pointer') || !!row.querySelector('td a[href]');
          };
          const inert = body.filter(row => !activatable(row));
          samples.push({ rule: rule.id, selector: selectorOf(table), property: 'activatable rows', actual: body.length - inert.length, expected: body.length });
          if (inert.length) add(rule, inert[0], 'row activation', 'focusable pointer row with a click target or a row link, or data-collection-rows="static" with a reason', `${inert.length} of ${body.length} rows inert`);
        }
        coverage.at(-1).rows = rows;
      }
      else if (rule.kind === 'selection-shift') {
        const selection = probe?.kind === 'selection' ? probe : null;
        coverage.at(-1).matched = selection ? 1 : 0;
        if (selection) {
          if (!selection.toggled) add(rule, null, 'selection toggle', 'checked then unchecked', JSON.stringify([selection.before.checked, selection.during.checked, selection.after.checked]), 'coverage');
          if (selection.blockedWrites?.length) add(rule, null, 'writes during selection', 'none (selection is local state)', selection.blockedWrites.join(', '));
          for (const phase of ['during', 'after']) for (const edge of ['tableTop', 'rowTop', 'rowBottom', 'rowLeft']) {
            const delta = Math.round((selection[phase][edge] - selection.before[edge]) * 100) / 100;
            samples.push({ rule: rule.id, selector: 'probe', property: `${edge} ${phase} selection`, actual: delta, expected: 0 });
            if (Math.abs(delta) > (rule.tolerance ?? tolerance)) add(rule, null, `${edge} ${phase} selection`, 0, delta);
          }
        }
      }
      else if (rule.kind === 'text-cramped') {
        // A block of wrapped text squeezed into a column too narrow to read:
        // more than `maxLines` lines while a line holds fewer than `minChars`
        // characters at the block's own font (measured, not assumed). A
        // truncated cell, a chip or a single-word label is one line and never
        // qualifies; lines forced by <br> or separate items (a short address)
        // do not either — the text must be long enough to fill the lines by
        // wrapping (`length / chars-per-line > maxLines`).
        const maxLines = rule.maxLines ?? 4, minChars = rule.minChars ?? 20;
        const blocks = new Map();
        for (const scope of nodes) for (const run of textRuns(scope)) {
          if ((rule.exclude ?? []).some(e => run.el.closest(css(e.selector)))) continue;
          let block = run.el;
          while (block.parentElement && /^(inline|contents)$/.test(cs(block).display)) block = block.parentElement;
          if (/^(pre|pre-wrap)$/.test(cs(block).whiteSpace) || block.closest('pre, code, [contenteditable="true"]') || cs(block).writingMode !== 'horizontal-tb') continue;
          const entry = blocks.get(block) ?? { text: '', tops: [] };
          entry.text += (entry.text ? ' ' : '') + run.text;
          for (const r of run.rects) entry.tops.push({ top: r.top, fs: run.fs });
          blocks.set(block, entry);
        }
        let measured = 0;
        for (const [block, { text, tops }] of blocks) {
          tops.sort((a, b) => a.top - b.top);
          let lines = 0, last = -Infinity;
          for (const t of tops) if (t.top > last + t.fs * 0.5) { lines++; last = t.top; }
          if (lines <= maxLines) continue;
          measured++;
          const s = cs(block), width = block.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
          const avg = textWidth(text, fontOf(s)) / Math.max(1, text.length);
          const perLine = width / Math.max(avg, 0.1);
          samples.push({ rule: rule.id, selector: selectorOf(block), property: 'characters per line', actual: Math.round(perLine), expected: { min: minChars } });
          if (perLine < minChars && text.length / perLine > maxLines) add(rule, block, 'characters per line', `>= ${minChars} when the text wraps past ${maxLines} lines`, `${Math.round(perLine)} chars (${Math.round(width)}px, ${Math.round(width / parseFloat(s.fontSize) * 10) / 10}em) over ${lines} lines: "${snippet(text)}"`);
        }
        coverage.at(-1).matched = measured;
        coverage.at(-1).textNodes = blocks.size;
      }
      else if (rule.kind === 'text-overlap') {
        // Two runs of text drawn on top of each other in the same stacking
        // context: a label that overflows into its neighbour, an absolutely
        // placed caption over a value. Judged on each line's em box cut to its
        // clipping/scrolling ancestors; a pair inside a declared layer
        // (data-ui-layered="<reason>") is exempt, and a blank or placeholder
        // reason fails coverage.
        const tol = rule.tolerance ?? 2, cap = rule.maxPerPage ?? 10;
        const boxes = [];
        for (const scope of nodes) for (const run of textRuns(scope)) {
          if ((rule.exclude ?? []).some(e => run.el.closest(css(e.selector)))) continue;
          const layer = layered(run.el);
          if (layer) {
            const reason = (layer.getAttribute('data-ui-layered') ?? '').trim();
            if (!reason || PLACEHOLDER_REASON.test(reason)) add(rule, layer, 'layered reason', 'data-ui-layered names why text is layered over text', reason, 'coverage');
            continue;
          }
          for (const r of run.rects) { const v = clipped(r, run.el); if (v) boxes.push({ ...v, run, root: stackRoot(run.el) }); }
        }
        boxes.sort((a, b) => a.left - b.left);
        let found = 0;
        for (let i = 0; i < boxes.length && found < cap; i++) {
          const a = boxes[i];
          for (let j = i + 1; j < boxes.length && boxes[j].left < a.right - tol && found < cap; j++) {
            const b = boxes[j];
            if (a.run === b.run || a.root !== b.root) continue;
            const x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (x > tol && y > tol) {
              add(rule, a.run.el, 'text overlaps text', `no overlap (> ${tol}px) with neighbouring text in the same layer`, `"${snippet(a.run.text)}" × "${snippet(b.run.text)}" (${Math.round(x)}×${Math.round(y)}px; other: ${selectorOf(b.run.el)})`);
              found++;
            }
          }
        }
        samples.push({ rule: rule.id, selector: 'document', property: 'overlapping text pairs', actual: found, expected: 0 });
        coverage.at(-1).matched = boxes.length;
      }
      else if (rule.kind === 'text-clipped') {
        // Text cut by an overflow:hidden/clip ancestor — a label sliced
        // mid-glyph at a container edge. Allowed only as a declared
        // truncation: an ellipsis (text-overflow: ellipsis, or a line clamp
        // for a vertical cut) on the element doing the cutting or between it
        // and the text. Whether the full text is reachable (a `title`, an
        // aria-label carrying it) is recorded on the sample; `requireFullText`
        // makes it a violation too. Text wholly outside the clip box is
        // hidden, not clipped; a scroll container's edge is not a cut (the
        // reader can scroll), nor is a declared pannable viewport's
        // (`scrollers`, each with a reason — a node canvas pans).
        const tol = rule.tolerance ?? 1;
        for (const x of rule.scrollers ?? []) if (!x.reason) throw new Error(`Scroller exception on ${rule.id} needs a reason`);
        const pannable = n => (rule.scrollers ?? []).some(x => n.matches(css(x.selector)));
        const reported = new Set();
        let measured = 0;
        for (const scope of nodes) for (const run of textRuns(scope)) {
          if (reported.has(run.el) || (rule.exclude ?? []).some(e => run.el.closest(css(e.selector)))) continue;
          const chain = clippers(run.el).map(c => pannable(c.n) ? { ...c, xHard: false, yHard: false } : c);
          if (!chain.some(c => c.xHard || c.yHard)) continue;
          measured++;
          let cut = null;
          for (const r of run.rects) {
            let { left, right, top, bottom } = r, hidden = false;
            for (const c of chain) {
              const b = innerBox(c.n);
              const nl = c.x ? Math.max(left, b.left) : left, nr = c.x ? Math.min(right, b.right) : right;
              const nt = c.y ? Math.max(top, b.top) : top, nb = c.y ? Math.min(bottom, b.bottom) : bottom;
              if (nr - nl <= 1 || nb - nt <= 1) { hidden = true; break; }
              const axis = (nl - left > tol || right - nr > tol) ? 'x' : (nt - top > tol || bottom - nb > tol) ? 'y' : null;
              if (axis && (axis === 'x' ? c.xHard : c.yHard)) { cut = { c, axis, lost: axis === 'x' ? (nl - left) + (right - nr) : (nt - top) + (bottom - nb) }; break; }
              left = nl; right = nr; top = nt; bottom = nb;
            }
            if (hidden || cut) break;
          }
          if (!cut) continue;
          const between = [];
          for (let n = run.el; n; n = n.parentElement) { between.push(n); if (n === cut.c.n) break; }
          const ellipsis = between.some(n => cut.axis === 'x' ? cs(n).textOverflow === 'ellipsis' : (cs(n).webkitLineClamp && cs(n).webkitLineClamp !== 'none'));
          const probe = run.text.slice(0, 24).toLowerCase();
          let reachable = false;
          for (let n = run.el, k = 0; n && k < between.length + 3; n = n.parentElement, k++) {
            if ((n.getAttribute('title') ?? '').trim()) { reachable = true; break; }
            const label = (n.getAttribute('aria-label') ?? '').toLowerCase();
            if (label && label.includes(probe)) { reachable = true; break; }
          }
          samples.push({ rule: rule.id, selector: selectorOf(run.el), property: 'clipped text', actual: { ellipsis, reachable, axis: cut.axis }, expected: 'ellipsis + full text' });
          if (!ellipsis || (rule.requireFullText && !reachable)) {
            reported.add(run.el);
            add(rule, run.el, `text clipped (${cut.axis})`, 'fits its box, or an ellipsis with the full text in a title / aria-label', `${Math.round(cut.lost)}px of "${snippet(run.text)}" cut by ${selectorOf(cut.c.n)}${ellipsis ? ' (ellipsis, no full text)' : ' (no ellipsis)'}`);
          }
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'placeholder-squeezed') for (const el of nodes) {
        // An input sharing its row with chips/buttons must keep room to be
        // read: at least `minEm` of its own font wide, and its placeholder
        // must not lose more than `maxHidden` (default half) of its width
        // while the row's other items are wider than the input itself — the
        // chips taking the space the words need.
        const editable = el.isContentEditable;
        const holder = editable ? el.querySelector('[data-placeholder]') : el;
        const placeholder = editable ? (holder?.getAttribute('data-placeholder') ?? el.getAttribute('aria-placeholder') ?? '') : (el.getAttribute('placeholder') ?? '');
        const empty = editable ? !el.textContent.trim() : !el.value;
        if (!placeholder.trim() || !empty) continue;
        const s = cs(el), fs = parseFloat(s.fontSize) || 14, own = el.getBoundingClientRect();
        // The row: the nearest flex/grid ancestor (display:contents wrappers
        // flattened) holding other painted items on the input's line.
        let siblings = null, row = null;
        for (let child = el, n = el.parentElement, k = 0; n && k < 8; child = n, n = n.parentElement, k++) {
          const d = cs(n).display;
          if (d === 'contents') continue;
          if (!/flex|grid/.test(d) || (/flex/.test(d) && /column/.test(cs(n).flexDirection))) continue;
          const flat = node => [...node.children].flatMap(c => cs(c).display === 'contents' ? flat(c) : [c]);
          const items = flat(n).filter(c => c !== child && !c.contains(el) && visible(c)).filter(c => { const b = c.getBoundingClientRect(); return b.width > 1 && Math.min(b.bottom, own.bottom) - Math.max(b.top, own.top) > 4; });
          if (items.length) { siblings = items; row = n; break; }
        }
        if (!siblings) continue;
        const sibWidth = siblings.reduce((sum, c) => sum + c.getBoundingClientRect().width, 0);
        const box = holder && holder !== el ? holder : el, bs = cs(box);
        const avail = box.clientWidth - parseFloat(bs.paddingLeft) - parseFloat(bs.paddingRight);
        const phFont = fontOf(getComputedStyle(holder ?? el, editable ? '::before' : '::placeholder'));
        const need = textWidth(placeholder, phFont);
        const truncated = need > avail + tolerance && avail < need * (1 - (rule.maxHidden ?? 0.5));
        samples.push({ rule: rule.id, selector: selectorOf(el), property: 'input width (em)', actual: Math.round(own.width / fs * 10) / 10, expected: { min: rule.minEm ?? 10 } });
        if (own.width < (rule.minEm ?? 10) * fs - tolerance) add(rule, el, 'input width', `>= ${rule.minEm ?? 10}em (${Math.round((rule.minEm ?? 10) * fs)}px) beside ${siblings.length} row item(s)`, `${Math.round(own.width)}px; the row's other items take ${Math.round(sibWidth)}px (${selectorOf(row)})`);
        else if (truncated && sibWidth > own.width) add(rule, el, 'placeholder truncated', `at most ${Math.round((rule.maxHidden ?? 0.5) * 100)}% of the placeholder hidden, or the input wider than what shares its row`, `"${snippet(placeholder)}" needs ${Math.round(need)}px, has ${Math.round(avail)}px; row items take ${Math.round(sibWidth)}px`);
      }
      else if (rule.kind === 'fingerprint') {
        // Consistency outliers (deep-audit family 1). Nothing is judged on one
        // page: each family's rendered values are recorded per page, and the
        // runner reports the minority values across every route it measured.
        let measured = 0;
        for (const family of rule.families ?? []) {
          let els;
          try { els = query(family.selector); } catch { continue; }
          if (family.exclude) els = els.filter(el => !el.closest(css(family.exclude)));
          for (const el of els.slice(0, family.max ?? 200)) {
            if (family.where === 'pill') { const s = cs(el), b = el.getBoundingClientRect(); const bg = toRGBA(s.backgroundColor); if (!(bg.a > 0 && b.height < 30 && b.height > 10 && parseFloat(s.borderTopLeftRadius) >= b.height / 2 - 1 && (el.textContent ?? '').trim().length && (el.textContent ?? '').trim().length < 24 && !el.matches('button, a, [role="button"]'))) continue; }
            if (family.where === 'card') { const s = cs(el), b = el.getBoundingClientRect(); if (!(b.width > 160 && b.height > 48 && (borderVisible(el) || s.boxShadow !== 'none') && toRGBA(s.backgroundColor).a > 0) || el.matches('table, input, textarea, button, [role="dialog"], [data-ui-dialog]')) continue; }
            if (family.where === 'control' && !(borderVisible(el) || toRGBA(cs(el).backgroundColor).a > 0)) continue;
            // `of`: measure the item the marker labels (a rail row for its title); `host.<prop>`: read a property of the enclosing `host`.
            const target = family.of ? el.closest(family.of) ?? el : el;
            const readOf = (node, p) => { const s = cs(node), b = node.getBoundingClientRect(); return p === 'height' || p === 'width' ? round(b[p]) : p === 'iconOnly' ? !(node.textContent ?? '').trim() : /Width$|Radius$|^padding|^margin|^fontSize$|^lineHeight$|^letterSpacing$|^gap$/.test(p) && /px$/.test(s[p]) ? round(parseFloat(s[p])) : s[p]; };
            const read = p => { if (p.startsWith('host.')) { const h = family.host ? el.closest(family.host) : null; return h ? readOf(h, p.slice(5)) : null; } return readOf(target, p); };
            const key = (family.keyBy ?? []).map(p => `${p}=${read(p)}`).join(' ') || '*';
            const value = Object.fromEntries((family.properties ?? []).map(p => [p, read(p)]));
            fingerprints.push({ family: family.name, key, value: JSON.stringify(value), selector: selectorOf(el) });
            measured++;
          }
        }
        // Geometry families: the trail→title and title→content rhythm and the gutter, per content column.
        if (rule.columns) for (const region of query(rule.columns)) {
          const trail = [...region.querySelectorAll(css(rule.trail))].filter(visible)[0];
          if (!trail) continue;
          const t = trail.getBoundingClientRect(), edge = contentBox(trail);
          fingerprints.push({ family: 'gutter', key: '*', value: JSON.stringify({ gutter: round(edge.left - region.getBoundingClientRect().left) }), selector: selectorOf(region) });
          const heading = [...region.querySelectorAll('h1, h2, [role="heading"]')].filter(el => visible(el) && !trail.contains(el) && el.getBoundingClientRect().top >= t.bottom - 1).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
          if (!heading) continue;
          const h = heading.getBoundingClientRect();
          fingerprints.push({ family: 'trail-to-title', key: '*', value: JSON.stringify({ gap: round(h.top - t.bottom) }), selector: selectorOf(heading) });
          const below = inkRects(region, el => trail.contains(el) || heading.contains(el) || inFixedLayer(el, region)).filter(r => r.top >= h.bottom - 1).sort((a, b) => a.top - b.top)[0];
          if (below) fingerprints.push({ family: 'title-to-content', key: '*', value: JSON.stringify({ gap: round(below.top - h.bottom) }), selector: selectorOf(below.el) });
          measured++;
        }
        samples.push({ rule: rule.id, selector: 'document', property: 'fingerprints', actual: fingerprints.length, expected: 'recorded for the cross-route pass' });
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'blank-band') {
        // Whitespace (family 2): a blank band inside a content column taller
        // than `maxGap` between two things it draws, or a short scroller that
        // scrolls its content while blank space sits under it in the column.
        const maxGap = rule.maxGap ?? 96, tol = rule.tolerance ?? tolerance;
        const solid = 'img, svg, canvas, video, iframe, input, textarea, select, button, hr, [role="separator"], [role="progressbar"], progress, [contenteditable="true"], [data-ui-text="avatar"]';
        let measured = 0;
        for (const column of nodes) {
          const c = column.getBoundingClientRect();
          const top = Math.max(c.top, 0), bottom = Math.min(c.bottom, innerHeight);
          if (bottom - top < maxGap * 2) continue;
          measured++;
          const skip = el => inFixedLayer(el, column) || (rule.exclude ?? []).some(e => el.closest(css(e.selector)));
          const marks = inkRects(column, skip);
          for (const el of column.querySelectorAll(solid)) if (visible(el) && !skip(el)) { const b = el.getBoundingClientRect(); marks.push({ el, left: b.left, right: b.right, top: b.top, bottom: b.bottom }); }
          const bands = marks.map(r => clipToAncestors(r, column)).filter(Boolean).map(r => {
            // Vertical clip too: rows scrolled out of a scroller are not drawn.
            let t = r.top, b = r.bottom;
            for (let n = r.el.parentElement; n && n !== column; n = n.parentElement) if (cs(n).overflowY !== 'visible') { const x = n.getBoundingClientRect(); t = Math.max(t, x.top); b = Math.min(b, x.bottom); }
            return { el: r.el, top: Math.max(t, top), bottom: Math.min(b, bottom) };
          }).filter(r => r.bottom - r.top > 1).sort((a, b) => a.top - b.top);
          if (!bands.length) continue;
          // A semantic column dock is intentionally anchored below short content.
          // Only its leading flexible space is allowed: gaps within the dock,
          // or before a dock that no longer reaches the column bottom, still fail.
          const anchored = rule.anchoredDocks ? query(rule.anchoredDocks).filter(d => column.contains(d)
            && Math.abs(d.getBoundingClientRect().bottom - c.bottom) <= tol) : [];
          let cursor = bands[0].top, worst = { gap: 0 }, previousDock = null;
          for (const r of bands) {
            const dock = anchored.find(d => d.contains(r.el));
            const leadingDockSpace = dock && dock !== previousDock && cursor <= dock.getBoundingClientRect().top + tol;
            if (!leadingDockSpace && r.top - cursor > worst.gap) worst = { gap: r.top - cursor, at: cursor, next: r.el };
            cursor = Math.max(cursor, r.bottom); previousDock = dock;
          }
          samples.push({ rule: rule.id, selector: selectorOf(column), property: 'largest interior blank band', actual: round(worst.gap), expected: { max: maxGap } });
          if (worst.gap > maxGap + tol) add(rule, worst.next, 'interior blank band', `<= ${maxGap}px between consecutive blocks in the column`, `${Math.round(worst.gap)}px blank from y=${Math.round(worst.at)} above "${snippet((worst.next.textContent ?? '').trim()) || worst.next.tagName.toLowerCase()}"`);
          // A scroller in the column that hides content while blank space sits below it.
          const trailing = bottom - cursor;
          if (trailing > maxGap + tol) {
            const short = [...column.querySelectorAll('*')].find(n => /^(auto|scroll)$/.test(cs(n).overflowY) && n.scrollHeight > n.clientHeight + 4 && visible(n) && n.getBoundingClientRect().bottom <= cursor + 2 && n.getBoundingClientRect().height > 40);
            samples.push({ rule: rule.id, selector: selectorOf(column), property: 'blank below a short scroller', actual: short ? round(trailing) : 0, expected: { max: maxGap } });
            if (short) add(rule, short, 'blank below a short scroller', `the scroller fills the column (<= ${maxGap}px blank below it)`, `${Math.round(trailing)}px blank under ${selectorOf(short)} while it scrolls ${short.scrollHeight - short.clientHeight}px of hidden content`);
          }
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'table-first') {
        // Density (family 2): on a list page the table is the content — its
        // header starts above the fold and is not pushed down by a stack of
        // status cards or banners between the title and the table.
        const maxTop = rule.maxTopRatio ?? 0.6, maxPre = rule.maxPreamble ?? 240;
        let measured = 0;
        for (const region of query(rule.columns)) {
          const table = nodes.find(t => region.contains(t));
          if (!table) continue;
          measured++;
          const tb = table.getBoundingClientRect();
          const trail = [...region.querySelectorAll(css(rule.trail))].filter(visible)[0];
          const heading = [...region.querySelectorAll('h1, h2, [role="heading"]')].filter(el => visible(el) && (!trail || !trail.contains(el)) && el.getBoundingClientRect().bottom <= tb.top + 1).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
          const start = heading ? heading.getBoundingClientRect().bottom : trail ? trail.getBoundingClientRect().bottom : region.getBoundingClientRect().top;
          const pre = Math.round(tb.top - start);
          samples.push({ rule: rule.id, selector: selectorOf(table), property: 'table top / preamble', actual: { top: Math.round(tb.top), preamble: pre }, expected: { top: Math.round(innerHeight * maxTop), preamble: maxPre } });
          if (tb.top > innerHeight * maxTop + tolerance) add(rule, table, 'table below the fold', `table header within the top ${Math.round(maxTop * 100)}% of the viewport (y <= ${Math.round(innerHeight * maxTop)})`, `y=${Math.round(tb.top)}`);
          else if (pre > maxPre + tolerance) add(rule, table, 'preamble above the table', `<= ${maxPre}px between the title and the table (one compact selector/filter row)`, `${pre}px`);
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'narrow-block') {
        // Density (family 2): a table/section/list narrower than its column
        // with nothing beside it — a fixed max-width leaving the column empty.
        const min = rule.minRatio ?? 0.6;
        const flagged = [];
        let measured = 0;
        for (const region of query(rule.columns)) {
          const trail = [...region.querySelectorAll(css(rule.trail))].filter(visible)[0];
          const edge = trail ? contentBox(trail) : contentBox(region), width = edge.right - edge.left;
          if (width < 480) continue;
          for (const block of nodes.filter(b => region.contains(b))) {
            if (flagged.some(f => f.contains(block)) || block.closest('[role="dialog"], [data-ui-dialog], aside, td, th')) continue;
            const b = block.getBoundingClientRect();
            measured++;
            if (b.width >= min * width) continue;
            const beside = inkRects(region, el => block.contains(el) || el.contains(block)).some(r => r.top < b.bottom - 4 && r.bottom > b.top + 4 && (r.left >= b.right - 2 || r.right <= b.left + 2));
            if (beside) continue;
            flagged.push(block);
            add(rule, block, 'block width', `>= ${Math.round(min * 100)}% of the ${Math.round(width)}px column, or something beside it`, `${Math.round(b.width)}px (${Math.round(b.width / width * 100)}%) with the rest of the row blank`);
          }
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'alignment-grid') {
        // Alignment (family 3): every reading line in the content column
        // starts on a small set of insets from its reading edge (the gutter,
        // the table inset, card padding and their sums). A line 1–12px off the
        // nearest inset is a stray offset; further away it is an indent and
        // not judged. Right edges of controls and boxes that end a row snap
        // to the reading edge's right the same way.
        const maxStray = rule.maxStray ?? 12, tol = rule.tolerance ?? 1.5;
        const base = (rule.insets ?? [0]).map(v => resolve(v));
        const insets = [...new Set([...base, ...base.flatMap(a => base.map(b => a + b))])];
        const boxes = css(rule.boxes ?? 'button, input, select, textarea, table, [role="tablist"], [data-ui-section]');
        let measured = 0;
        for (const region of query(rule.columns)) {
          const trail = [...region.querySelectorAll(css(rule.trail))].filter(visible)[0];
          if (!trail) continue;
          const edge = contentBox(trail);
          const skip = el => trail.contains(el) || inFixedLayer(el, region) || el.closest('[role="dialog"], [data-ui-dialog], [role="menu"], [role="listbox"], [role="tooltip"]') || (rule.exclude ?? []).some(e => el.closest(css(e.selector)));
          const ink = inkRects(region, skip).filter(r => r.top >= edge.bottom - 1).map(r => clipToAncestors(r, region)).filter(Boolean);
          const rows = rowsOf(ink);
          measured += rows.length;
          const strays = new Map();
          for (const row of rows) {
            const first = row.items.reduce((a, r) => (r.left < a.left ? r : a));
            if (!notStartAligned(first.el)) {
              // Borders are not insets: a bordered card's 1px edge is subtracted before snapping.
              let borders = 0; for (let n = first.el; n && n !== region; n = n.parentElement) borders += parseFloat(cs(n).borderLeftWidth) || 0;
              const off = first.left - edge.left - borders;
              const near = insets.reduce((a, v) => (Math.abs(off - v) < Math.abs(off - a) ? v : a), insets[0]);
              const d = Math.abs(off - near);
              if (off >= -tol && d > tol && d <= maxStray) { const k = Math.round(off); if (!strays.has(k)) strays.set(k, { el: first.el, near, n: 0 }); strays.get(k).n++; }
            }
            // Right edges: a control or box that ends its row.
            const last = row.items.reduce((a, r) => (r.right > a.right ? r : a));
            const box = last.el.closest(boxes);
            if (box && region.contains(box)) {
              let rb = 0; for (let n = box.parentElement; n && n !== region; n = n.parentElement) rb += parseFloat(cs(n).borderRightWidth) || 0;
              const roff = edge.right - box.getBoundingClientRect().right - rb;
              const rnear = insets.reduce((a, v) => (Math.abs(roff - v) < Math.abs(roff - a) ? v : a), insets[0]);
              const rd = Math.abs(roff - rnear);
              if (roff >= -tol && rd > tol && rd <= maxStray) { const k = `r${Math.round(roff)}`; if (!strays.has(k)) strays.set(k, { el: box, near: rnear, n: 0, right: true }); strays.get(k).n++; }
            }
          }
          samples.push({ rule: rule.id, selector: selectorOf(region), property: 'stray offsets', actual: [...strays.keys()], expected: insets });
          for (const [k, s] of [...strays].slice(0, rule.maxPerColumn ?? 5)) add(rule, s.el, s.right ? 'right edge off the grid' : 'line start off the grid', `${s.right ? 'right inset' : 'offset'} on the inset grid ${JSON.stringify(insets.slice(0, 8))}px from the reading edge`, `${String(k).replace('r', '')}px (${s.n} row${s.n > 1 ? 's' : ''}; nearest inset ${s.near}px): "${snippet((s.el.textContent ?? '').trim()) || s.el.tagName.toLowerCase()}"`);
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'baseline') {
        // Alignment (family 3): a label and its value side by side in one flex
        // row, at different sizes, share a baseline. Centred items of unequal
        // size put the smaller text's baseline above the larger's.
        const tol = rule.tolerance ?? 1.5;
        const metrics = new Map();
        const ascent = font => { if (!metrics.has(font)) { canvas.font = font; const m = canvas.measureText('Hxg'); metrics.set(font, [m.fontBoundingBoxAscent, m.fontBoundingBoxDescent]); } return metrics.get(font); };
        const plain = el => { const s = cs(el); return toRGBA(s.backgroundColor).a === 0 && !borderVisible(el) && parseFloat(s.paddingTop) <= 2 && parseFloat(s.paddingBottom) <= 2; };
        const leafText = el => { const t = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()); return t.length && el.children.length === 0 ? t[0] : null; };
        let measured = 0, found = 0;
        for (const row of nodes) {
          const s = cs(row);
          if (!/flex/.test(s.display) || /column/.test(s.flexDirection)) continue;
          // A glyph drawn as text (✓, ●, an emoji) is an icon, not a label: it has no letters or digits.
          const items = [...row.children].filter(c => visible(c) && leafText(c) && plain(c) && /[\p{L}\p{N}]/u.test(c.textContent));
          // A row that aligns on the baseline is correct by construction: counted, not judged.
          if (/baseline/.test(s.alignItems)) { measured += items.filter((c, i) => i && cs(c).fontSize !== cs(items[i - 1]).fontSize).length; continue; }
          for (let i = 1; i < items.length && found < (rule.maxPerPage ?? 10); i++) {
            const a = items[i - 1], b = items[i];
            if (cs(a).fontSize === cs(b).fontSize) continue;
            const base = el => { const r = document.createRange(); r.selectNodeContents(leafText(el)); const rect = r.getClientRects()[0]; if (!rect) return null; const [asc, desc] = ascent(fontOf(cs(el))); return rect.top + asc * (rect.height / (asc + desc)); };
            const x = base(a), y = base(b);
            if (x == null || y == null) continue;
            measured++;
            const d = Math.round(Math.abs(x - y) * 10) / 10;
            samples.push({ rule: rule.id, selector: selectorOf(b), property: 'baseline delta', actual: d, expected: { max: tol } });
            if (d > tol) { found++; add(rule, b, 'baseline delta', `label and value on one baseline (<= ${tol}px)`, `${d}px between "${snippet(a.textContent.trim())}" (${cs(a).fontSize}) and "${snippet(b.textContent.trim())}" (${cs(b).fontSize})`); }
          }
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'icon-center') {
        // Alignment (family 3): an icon beside text in a button/row is
        // centred on the text line, not sitting high or low.
        const tol = rule.tolerance ?? 2;
        let measured = 0, found = 0;
        for (const host of nodes) {
          if (found >= (rule.maxPerPage ?? 10)) break;
          const icon = [...host.querySelectorAll('svg')].find(svg => { const b = svg.getBoundingClientRect(); return visible(svg) && b.width >= 8 && b.width <= 32 && !svg.parentElement.closest('svg'); });
          if (!icon) continue;
          const runs = textRuns(host).filter(r => {
            if (r.el.closest('[data-ui-text="avatar"]')) return false;
            // Count badges sit on the icon's corner, not on its label baseline.
            // Only a library-marked, positioned badge is excluded; ordinary labels still count.
            const badge = r.el.closest('[data-ui-badge="count"]');
            return !badge || getComputedStyle(badge).position !== 'absolute';
          });
          const run = runs[0];
          if (!run) continue;
          // One line of text only: an icon beside a two-line block centres on the block by design.
          const tops = [...new Set(runs.flatMap(r => r.rects.map(x => Math.round(x.top / 4))))];
          if (tops.length > 1) continue;
          const line = run.rects[0], ib = icon.getBoundingClientRect();
          if (ib.bottom < line.top || ib.top > line.bottom + run.fs) continue; // on another line
          measured++;
          const d = Math.round(((ib.top + ib.bottom) / 2 - (line.top + line.bottom) / 2) * 10) / 10;
          samples.push({ rule: rule.id, selector: selectorOf(host), property: 'icon centre - text centre', actual: d, expected: { max: tol } });
          if (Math.abs(d) > tol) { found++; add(rule, icon, 'icon vertical centre', `centred on its text line (|Δ| <= ${tol}px)`, `${d > 0 ? '+' : ''}${d}px beside "${snippet(run.text)}"`); }
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'scroll-owner') {
        // Widths (family 6): a wide table/grid/pre/media scrolls inside its own
        // container; it never widens the page or gets cut by its column.
        const tol = rule.tolerance ?? tolerance;
        for (const el of nodes) {
          const region = el.parentElement?.closest(css(rule.region)) ?? document.documentElement;
          const r = region === document.documentElement ? { left: 0, right: innerWidth } : region.getBoundingClientRect();
          const b = el.getBoundingClientRect();
          if (b.right <= r.right + tol && b.left >= r.left - tol) continue;
          let owner = null;
          for (let n = el.parentElement; n && n !== region; n = n.parentElement) if (/^(auto|scroll)$/.test(cs(n).overflowX)) { owner = n; break; }
          const ob = owner?.getBoundingClientRect();
          samples.push({ rule: rule.id, selector: selectorOf(el), property: 'scroll owner', actual: owner ? selectorOf(owner) : 'none', expected: 'a horizontal scroller inside its column' });
          if (!owner) add(rule, el, 'wide content without its own scroller', `a scroller inside ${selectorOf(region)} (x ${Math.round(r.left)}–${Math.round(r.right)})`, `x ${Math.round(b.left)}–${Math.round(b.right)} with no overflow-x:auto ancestor`);
          else if (ob.right > r.right + tol || ob.left < r.left - tol) add(rule, owner, 'scroller wider than its column', `x within ${Math.round(r.left)}–${Math.round(r.right)}`, `x ${Math.round(ob.left)}–${Math.round(ob.right)}`);
        }
      }
      else if (rule.kind === 'content-share') {
        // Widths (family 6): rails fold so the content column keeps the room
        // the reader came for — most of a phone screen, a working width on a laptop.
        for (const el of nodes) {
          const w = el.getBoundingClientRect().width;
          const need = innerWidth < (rule.narrowBelow ?? 768) ? innerWidth * (rule.narrowRatio ?? 0.75) : Math.min(rule.minWidth ?? 480, innerWidth * 0.5);
          samples.push({ rule: rule.id, selector: selectorOf(el), property: 'content column width', actual: Math.round(w), expected: { min: Math.round(need) } });
          if (w < need - tolerance) add(rule, el, 'content column width', `>= ${Math.round(need)}px at a ${innerWidth}px viewport (rails fold or collapse)`, `${Math.round(w)}px`);
        }
      }
      else if (rule.kind === 'content-honesty') {
        // Content honesty (family 7): text a reader should never see.
        const patterns = (rule.patterns ?? []).map(p => ({ ...p, re: new RegExp(p.pattern, p.flags ?? '') }));
        const code = css(rule.code ?? 'code, pre, kbd, samp, [data-ui-text="code"], .font-mono, [contenteditable="true"], textarea, input');
        let count = 0, prev = null;
        const reported = new Set();
        for (const scope of nodes) for (const run of textRuns(scope)) {
          if ((rule.exclude ?? []).some(e => run.el.closest(css(e.selector)))) { prev = null; continue; }
          const isCode = !!run.el.closest(code);
          for (const p of patterns) {
            if (count >= (rule.maxPerPage ?? 12) || (isCode && !p.inCode)) continue;
            const m = p.whole ? (p.re.test(run.text) ? [run.text] : null) : run.text.match(p.re);
            if (m && !reported.has(`${p.name}|${m[0]}`)) { reported.add(`${p.name}|${m[0]}`); count++; add(rule, run.el, p.name, p.expect ?? 'readable copy', `"${snippet(m[0])}" in "${snippet(run.text)}"`); }
          }
          // Duplicated adjacent labels: the same words twice in a row, outside list/table items.
          const row = el => el.closest('tr, li, [role="row"], [role="option"], [role="listitem"], [role="menuitem"], [role="tab"]');
          // Separate cells answer separate column questions (e.g. each role's
          // permission can be Yes). Repetition inside one cell still fails.
          const cell = el => el.closest('td, th, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]');
          // Adjacent means one composition: the two labels share an ancestor within three levels
          // (a rail caption beside the page title is two regions). Rows a many-rows state repeated are copies.
          const near = (a, b) => { for (let n = a.parentElement, k = 0; n && k < 3; n = n.parentElement, k++) if (n.contains(b)) return true; return false; };
          if (prev && rule.duplicates !== false && !(probe?.kind === 'data-state' && probe.mode === 'many') && near(run.el, prev.el) && run.text.length >= 3 && run.text.toLowerCase() === prev.text.toLowerCase() && row(run.el) === row(prev.el) && cell(run.el) === cell(prev.el) && !prev.el.contains(run.el) && !run.el.contains(prev.el) && Math.abs(run.rects[0].top - prev.rects[0].top) < 48 && count < (rule.maxPerPage ?? 12)) {
            count++; add(rule, run.el, 'duplicated adjacent label', 'each label once', `"${snippet(run.text)}" twice in a row (also ${selectorOf(prev.el)})`);
          }
          prev = run;
        }
        samples.push({ rule: rule.id, selector: 'document', property: 'honesty findings', actual: count, expected: 0 });
      }
      else if (rule.kind === 'a11y-names') {
        // Accessibility (family 8): every control and image says what it is.
        let count = 0;
        for (const el of nodes) {
          if (el.closest('[aria-hidden="true"], [inert]')) continue;
          const isImg = el.matches('img');
          const name = isImg ? el.getAttribute('alt') : accName(el);
          samples.push({ rule: rule.id, selector: selectorOf(el), property: 'accessible name', actual: name == null ? null : name.slice(0, 40), expected: 'non-empty' });
          if (isImg ? name == null : !name) { if (count++ < (rule.maxPerPage ?? 15)) add(rule, el, isImg ? 'img alt' : 'accessible name', isImg ? 'an alt attribute (empty for decoration)' : 'a name from text, aria-label, aria-labelledby, label or title', `none on <${el.tagName.toLowerCase()}${el.getAttribute('role') ? ` role=${el.getAttribute('role')}` : ''}>`); }
        }
      }
      else if (rule.kind === 'contrast') {
        // Accessibility (family 8) and theme parity (family 9): text drawn
        // against what is painted behind it, in the theme being measured.
        const normal = rule.min ?? 4.5, large = rule.minLarge ?? 3;
        const reported = new Map();
        let measured = 0;
        for (const scope of nodes) for (const run of textRuns(scope)) {
          const el = run.el;
          // Punctuation (a "·" separator) carries no words to read.
          if (!/[\p{L}\p{N}]/u.test(run.text) || el.closest(':disabled, [aria-disabled="true"], [data-ui-placeholder]') || (rule.exclude ?? []).some(e => el.closest(css(e.selector)))) continue;
          const bg = backdrop(el);
          if (!bg) continue;
          const s = cs(el), fg = toRGBA(s.color);
          const alpha = fg.a * opacityOf(el);
          if (alpha <= 0) continue;
          const shown = over({ ...fg, a: alpha }, bg);
          const r = ratio(shown, bg);
          const big = run.fs >= 24 || (run.fs >= 18.66 && parseInt(s.fontWeight, 10) >= 700);
          const need = big ? large : normal;
          measured++;
          if (r >= need - 0.005) continue;
          const key = `${s.color}|${s.fontSize}`;
          if (reported.has(key)) { reported.get(key).n++; continue; }
          reported.set(key, { n: 1 });
          if (reported.size <= (rule.maxPerPage ?? 12)) add(rule, el, 'text contrast', `>= ${need}:1`, `${r}:1 (${s.color} on rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)}), ${s.fontSize}): "${snippet(run.text)}"`);
        }
        samples.push({ rule: rule.id, selector: 'document', property: 'low-contrast text styles', actual: reported.size, expected: 0 });
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'heading-order') {
        // Accessibility (family 8): one h1; levels never skip on the way down.
        const shown = el => { const s = cs(el); return s.display !== 'none' && s.visibility !== 'hidden' && (typeof el.checkVisibility !== 'function' || el.checkVisibility()); };
        const heads = nodes.length ? nodes : query(rule.selector, true);
        // Authored documents have an independent outline (CanvasDocumentView
        // marks its body, including read-only mode). Only that named document
        // body is outside the application outline; its toolbar/title remain
        // accountable, and the app still needs exactly one primary heading.
        const all = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"][aria-level]')].filter(el => shown(el) && !el.closest('[role="dialog"], [data-ui-dialog], [aria-hidden="true"]') && !el.closest('[role="document"]')?.getAttribute('aria-label')?.trim() && (!heads.length || heads.some(h => h.contains(el))));
        const level = el => el.getAttribute('aria-level') ? parseInt(el.getAttribute('aria-level'), 10) : parseInt(el.tagName.slice(1), 10);
        const h1 = all.filter(el => level(el) === 1);
        samples.push({ rule: rule.id, selector: 'document', property: 'h1 count', actual: h1.length, expected: 1 });
        if (h1.length !== 1) add(rule, h1[1] ?? null, 'h1 count', 1, `${h1.length}${h1.length ? ': ' + h1.map(h => `"${snippet(h.textContent.trim())}"`).join(', ') : ''}`);
        let last = 0, found = 0;
        for (const el of all) {
          const l = level(el);
          if (last && l > last + 1 && found++ < 5) add(rule, el, 'heading level skipped', `h${last + 1} or higher after an h${last}`, `h${l}: "${snippet(el.textContent.trim())}"`);
          last = l;
        }
      }
      else if (rule.kind === 'landmarks') {
        // Accessibility (family 8): one main, at most one banner and
        // contentinfo, and repeated navigation/complementary landmarks
        // distinguished by name.
        const top = el => !el.parentElement?.closest('article, aside, main, nav, section, [role="main"], [role="navigation"], [role="complementary"], [role="region"]');
        const shown = el => cs(el).display !== 'none' && cs(el).visibility !== 'hidden';
        const mains = [...document.querySelectorAll('main, [role="main"]')].filter(shown);
        const banners = [...document.querySelectorAll('header, [role="banner"]')].filter(el => shown(el) && (el.getAttribute('role') === 'banner' || top(el)));
        const infos = [...document.querySelectorAll('footer, [role="contentinfo"]')].filter(el => shown(el) && (el.getAttribute('role') === 'contentinfo' || top(el)));
        samples.push({ rule: rule.id, selector: 'document', property: 'landmarks', actual: { main: mains.length, banner: banners.length, contentinfo: infos.length }, expected: { main: 1 } });
        if (mains.length !== 1) add(rule, mains[1] ?? null, 'main landmarks', 1, mains.length);
        if (banners.length > 1) add(rule, banners[1], 'banner landmarks', '<= 1', banners.length);
        if (infos.length > 1) add(rule, infos[1], 'contentinfo landmarks', '<= 1', infos.length);
        for (const [kind, sel] of [['navigation', 'nav, [role="navigation"]'], ['complementary', 'aside, [role="complementary"]']]) {
          const list = [...document.querySelectorAll(sel)].filter(shown);
          if (list.length < 2) continue;
          const names = list.map(el => (el.getAttribute('aria-label') ?? (el.getAttribute('aria-labelledby') ? accName(el) : '')).trim().toLowerCase());
          const dup = names.findIndex((n, i) => names.indexOf(n) !== i);
          if (dup >= 0) add(rule, list[dup], `${kind} landmark names`, `each of the ${list.length} ${kind} landmarks named distinctly`, `"${names[dup] || '(unnamed)'}" repeated`);
        }
      }
      else if (rule.kind === 'composer-readonly') {
        // A composer that cannot post is read-only as a whole: no enabled
        // formatting, mode, workflow, command or attachment control and no
        // editable input remain in it, and the reason is shown in it.
        const notice = new RegExp(rule.noticeText ?? 'cannot post|can read messages|read[- ]only|view only|don.?t have permission', 'i');
        const marker = css(rule.marker ?? '[data-composer-readonly], [data-readonly="true"], [aria-readonly="true"], [aria-disabled="true"]');
        let measured = 0;
        for (const surface of nodes) {
          const dock = rule.dock ? surface.closest(css(rule.dock)) ?? surface : surface;
          const marked = surface.matches(marker) || !!surface.closest(marker);
          const said = textRuns(dock).find(r => notice.test(r.text));
          if (!marked && !said) continue;
          measured++;
          const allow = rule.allow ? css(rule.allow) : null;
          // A control that is the way out of the read-only state (the To: selector, a mode switch),
          // or only discloses existing facts (a prompt deck's Show/Hide),
          // declares it: data-composer-readonly-allow="<reason>". A blank or placeholder reason fails coverage.
          const exempt = el => { const host = el.closest('[data-composer-readonly-allow]'); if (!host || !surface.contains(host)) return false; const reason = (host.getAttribute('data-composer-readonly-allow') ?? '').trim(); if (!reason || PLACEHOLDER_REASON.test(reason)) { add(rule, host, 'read-only exemption reason', 'data-composer-readonly-allow names why this control stays live', reason, 'coverage'); return false; } return true; };
          const live = [...surface.querySelectorAll('button, [role="button"], [role="menuitem"], [aria-haspopup], input, textarea, select, [contenteditable="true"], [role="textbox"]')].filter(el => {
            if (!visible(el) || (allow && el.closest(allow)) || exempt(el)) return false;
            if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.closest('[aria-disabled="true"], [inert], fieldset:disabled')) return false;
            if (el.matches('[role="textbox"]') && el.getAttribute('contenteditable') !== 'true' && !el.querySelector('[contenteditable="true"]')) return false;
            if (el.matches('input, textarea') && el.readOnly) return false;
            return true;
          });
          samples.push({ rule: rule.id, selector: selectorOf(surface), property: 'enabled controls in a read-only composer', actual: live.length, expected: 0 });
          if (live.length) add(rule, live[0], 'enabled controls in a read-only composer', 'every input affordance disabled (formatting, mode menu, workflow, commands, attachments, the editor)', `${live.length}: ${live.slice(0, 8).map(el => `"${snippet(accName(el) || el.tagName.toLowerCase())}"`).join(', ')}`);
          if (marked && !said) add(rule, surface, 'read-only reason', 'the reason shown inside the composer or its dock', 'none visible');
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'layer') {
        // Interaction depth (family 4): an opened menu/popover/dialog/drawer/
        // tooltip, judged after the `openLayer` probe opened it (and tested its
        // focus and Escape handling). Layout rules all apply inside it too.
        const opened = probe?.kind === 'layer' ? probe : null;
        coverage.at(-1).matched = opened ? 1 : 0;
        if (opened) {
          const label = `${opened.role ?? 'layer'} from "${opened.trigger}"`;
          if (opened.blockedWrites?.length) add(rule, null, 'writes while opening', 'none (opening a layer is read-only)', opened.blockedWrites.join(', '));
          if (!opened.opened) add(rule, null, 'layer opened', `${label}: a visible layer`, opened.reason ?? 'nothing opened', 'coverage');
          // A disclosure opens in place: no layer to judge; every other rule measures what it revealed.
          else if (opened.disclosure) samples.push({ rule: rule.id, selector: 'probe', property: 'disclosure opened', actual: opened.trigger, expected: 'judged by the page rules' });
          else {
            if (opened.triggerFocus && !opened.focusOnTrigger) add(rule, null, 'focus stays on the trigger', `${label}: a descriptive nonmodal card keeps focus on its linked trigger`, opened.focusAfterOpen ?? 'body');
            if (opened.focusExpected && !opened.focusInside) add(rule, null, 'focus moves into the layer', `${label}: focus inside the opened ${opened.role}`, opened.focusAfterOpen ?? 'body');
            if (opened.escapeCloses === false) add(rule, null, 'Escape closes', `${label}: Escape closes it`, 'still open after Escape');
            if ((opened.focusExpected || opened.triggerFocus) && opened.escapeCloses && opened.focusReturned === false) add(rule, null, 'focus returns to the trigger', `${label}: focus back on its trigger after Escape`, opened.focusAfterEscape ?? 'body');
            const layer = document.querySelector('[data-audit-layer]');
            if (!layer || !visible(layer)) add(rule, null, 'layer still open when measured', label, 'closed', 'coverage');
            else {
              const b = layer.getBoundingClientRect();
              const out = { left: b.left, top: b.top, right: innerWidth - b.right, bottom: innerHeight - b.bottom };
              for (const [edge, gap] of Object.entries(out)) if (gap < -tolerance) add(rule, layer, `${edge} inside viewport`, `${label}: >= 0`, Math.round(gap));
              // z-order: the layer paints over the content beneath it.
              const pts = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]].map(([x, y]) => [b.left + b.width * x, b.top + b.height * y]).filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
              // The layer's own panel: its nearest positioned (fixed/absolute) ancestor-or-self. Parts of the
              // same panel drawn over the marked node (a header over a menu list) are the layer, not a cover.
              let panel = layer; for (let n = layer; n && n !== document.body; n = n.parentElement) if (/fixed|absolute/.test(cs(n).position)) { panel = n; break; }
              const covered = pts.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit && !panel.contains(hit) && !hit.contains(layer); });
              if (covered.length) add(rule, layer, 'z-order', `${label}: drawn above the page`, `${covered.length}/${pts.length} sample points covered by ${selectorOf(document.elementFromPoint(...covered[0]))}`);
              // Never under or over the shell's header/footer bars.
              for (const name of rule.chrome ?? []) {
                let bars = []; try { bars = query(name); } catch { continue; }
                for (const bar of bars) {
                  // A menu anchored to a control in the bar may meet its own bar.
                  if (bar.contains(layer) || layer.contains(bar) || bar.querySelector('[data-audit-trigger]')) continue;
                  const c = bar.getBoundingClientRect();
                  const x = Math.min(b.right, c.right) - Math.max(b.left, c.left), y = Math.min(b.bottom, c.bottom) - Math.max(b.top, c.top);
                  if (x > 2 && y > 2) add(rule, layer, 'overlaps shell chrome', `${label}: clear of ${selectorOf(bar)}`, `${Math.round(x)}×${Math.round(y)}px overlap`);
                }
              }
              // Taller than the viewport allows, with nothing scrolling inside it.
              if (b.height >= innerHeight - 2 * (rule.margin ?? 0) - tolerance) {
                const scrolls = [layer, ...layer.querySelectorAll('*')].some(n => /^(auto|scroll)$/.test(cs(n).overflowY) && n.scrollHeight > n.clientHeight);
                if (!scrolls && layer.scrollHeight > layer.clientHeight + 1) add(rule, layer, 'max height', `${label}: capped to the viewport with a scrolling region`, `${Math.round(layer.scrollHeight)}px of content in ${Math.round(b.height)}px, nothing scrolls`);
              }
            }
          }
        }
      }
      else if (rule.kind === 'focus-walk') {
        // Interaction depth (family 4): keyboard Tab through the first
        // focusables — each shows a focus indicator, is visible, and focus is
        // never dropped on <body>.
        const walk = probe?.kind === 'focus-walk' ? probe : null;
        coverage.at(-1).matched = walk ? walk.steps.length : 0;
        if (walk) {
          const lost = walk.steps.filter(s => s.lost), hidden = walk.steps.filter(s => !s.lost && !s.visible), bare = walk.steps.filter(s => !s.lost && s.visible && !s.indicator);
          samples.push({ rule: rule.id, selector: 'probe', property: 'focus steps', actual: { steps: walk.steps.length, lost: lost.length, hidden: hidden.length, noIndicator: bare.length }, expected: 'all visible with an indicator' });
          if (lost.length) add(rule, null, 'focus lost to body', 'each Tab lands on a control', `after Tab ${lost[0].step} (previous: ${lost[0].after ?? 'start'})`);
          for (const s of hidden.slice(0, 3)) add(rule, null, 'focused element not visible', 'the focused control is on screen', `Tab ${s.step}: ${s.selector} "${snippet(s.name ?? '')}"`);
          for (const s of bare.slice(0, rule.maxPerPage ?? 5)) add(rule, null, 'no visible focus indicator', 'an outline, ring or style change on keyboard focus', `Tab ${s.step}: ${s.selector} "${snippet(s.name ?? '')}"`);
        }
      }
      else if (rule.kind === 'tab-stability') {
        // Tab-switch layout stability: clicking each tab of a tablist changes
        // only its panel. The tablist, its tabs, everything above it, the
        // panel's top edge and the surrounding chrome (rails, headers, the
        // composer dock, the side pane) keep their geometry.
        const cycle = probe?.kind === 'tabs' ? probe : null;
        coverage.at(-1).matched = cycle ? cycle.snapshots.length : 0;
        if (cycle) {
          const tol = rule.tolerance ?? 1;
          if (cycle.blockedWrites?.length) add(rule, null, 'writes while switching tabs', 'none (a tab switch is read-only)', cycle.blockedWrites.join(', '));
          if (cycle.snapshots.length < 2) add(rule, null, 'tabs switched', `>= 2 tabs of "${cycle.tablist}" visited`, cycle.snapshots.length, 'coverage');
          const [first, ...rest] = cycle.snapshots, worst = new Map();
          for (const snap of rest) for (const [region, box] of Object.entries(snap.regions)) {
            const was = first.regions[region];
            if (!was) continue;
            for (const field of Object.keys(box)) {
              const d = Math.round((box[field] - was[field]) * 100) / 100;
              if (Math.abs(d) <= tol) continue;
              const key = `${region} ${field}`;
              if (!worst.has(key) || Math.abs(d) > Math.abs(worst.get(key).d)) worst.set(key, { d, tab: snap.tab, from: first.tab });
            }
          }
          samples.push({ rule: rule.id, selector: 'probe', property: `shifted regions in "${cycle.tablist}"`, actual: [...worst.keys()], expected: [] });
          for (const [key, w] of [...worst].slice(0, rule.maxPerTablist ?? 8)) add(rule, null, `${key} on tab switch`, `unchanged (±${tol}px) across the tabs of "${cycle.tablist}"`, `${w.d > 0 ? '+' : ''}${w.d}px on "${w.tab}" (vs "${w.from}")`);
        }
      }
      else if (rule.kind === 'data-state') {
        // Data-state coverage (family 5): the page rendered under an
        // intercepted empty / error / loading response still tells the
        // reader what is going on.
        const state = probe?.kind === 'data-state' ? probe : null;
        coverage.at(-1).matched = state ? state.intercepted : 0;
        if (state?.blockedWrites?.length) add(rule, null, `${state.mode}: writes attempted`, 'none (the page reacts to a data state by reading, not by writing)', state.blockedWrites.slice(0, 6).join(', '));
        if (state && state.intercepted > 0) {
          const region = query(rule.region)[0] ?? document.body;
          const text = (region.innerText ?? '').replace(/\s+/g, ' ');
          // Ink apart from headings and the shell's own regions: a title over nothing is a blank page.
          const ink = inkRects(region, el => !!el.closest(css(rule.ignore ?? 'nav, aside, header, footer, h1, h2, [role="heading"], [data-trail]'))).length;
          const busy = !!region.querySelector(css(rule.busy ?? '[aria-busy="true"], [role="progressbar"], [data-testid*="loading"], [data-ui-skeleton], .animate-pulse')) || /\b(loading|fetching|please wait)\b/i.test(text);
          const raw = /\{"(error|message)"|Internal Server Error|at [\w$.]+ \(.*:\d+:\d+\)|\bundefined\b|\[object Object\]/.exec(text);
          if (state.readyError && state.mode !== 'loading') add(rule, null, `${state.mode}: page settles`, 'the page leaves its loading state under this response', snippet(state.readyError));
          if (raw) add(rule, null, `${state.mode}: raw error text`, 'a written message, not a raw payload or stack', `"${snippet(raw[0])}"`);
          if (state.mode === 'error' && !region.querySelector('[role="alert"]') && !/(error|couldn.?t|could not|failed|unavailable|try again|went wrong|unable)/i.test(text)) add(rule, null, 'error: message shown', 'an error message (role=alert or error copy) in the content', 'no error message; the failure is silent');
          if (state.mode === 'empty') {
            for (const table of [...region.querySelectorAll('table')].filter(visible)) {
              const rows = [...table.querySelectorAll('tbody > tr')].filter(visible);
              const host = table.closest('[data-ui-section], section, [data-collection-page]') ?? table.parentElement;
              if (!rows.length && !host.querySelector('[data-ui-empty]') && !/(no |nothing|empty|none|0 )/i.test((host.innerText ?? '').replace(/(^|\n)[^\n]*\n?/, ''))) add(rule, table, 'empty: table explains itself', 'an empty state in or beside a table with no rows', 'header row over nothing');
            }
            if (ink < (rule.minInk ?? 1)) add(rule, null, 'empty: page blank', 'an empty state says there is nothing yet', `${ink} pieces of ink in the content`);
          }
          if (state.mode === 'loading' && ink < (rule.minInk ?? 1) && !busy) add(rule, null, 'loading: indicator', 'a loading indicator or skeleton while data is pending', 'a blank content area');
        }
      }
      else if (rule.kind === 'geometry-snapshot') {
        // Theme parity (family 9): boxes and border visibility of the page's
        // structural elements, compared light vs dark by the runner.
        for (const el of nodes.slice(0, rule.max ?? 600)) {
          const b = el.getBoundingClientRect();
          geometry.push({ selector: selectorOf(el), box: [round(b.left), round(b.top), round(b.width), round(b.height)], border: borderVisible(el) });
        }
        samples.push({ rule: rule.id, selector: 'document', property: 'geometry snapshot', actual: geometry.length, expected: 'recorded for the theme-parity pass' });
        coverage.at(-1).matched = Math.min(nodes.length, rule.max ?? 600);
      }
      else if (rule.kind === 'text-fragmented') {
        // From the visual review (/iq/canary): a sentence whose words and
        // inline marks are direct items of a flex row breaks into columns —
        // each anonymous text item wraps on its own ("Click | ▶ Scenarios |
        // in the toolbar, generate…"). A flex row holding bare text beside
        // elements is judged once any of its bare text items wraps.
        let measured = 0;
        for (const el of nodes) {
          const s = cs(el);
          if (!/flex|grid/.test(s.display) || (/flex/.test(s.display) && /column/.test(s.flexDirection)) || !visible(el)) continue;
          const bare = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim().length >= 2);
          // Prose split means several pieces of one sentence: two bare text runs, or bare text between
          // phrasing elements that carry words. An icon beside one wrapping sentence is a normal row.
          const phrasing = [...el.children].filter(c => c.matches('b, strong, em, i, a, code, kbd, span, mark, small') && /[\p{L}\p{N}]/u.test(c.textContent));
          if (!bare.length || !el.children.length || (bare.length < 2 && phrasing.length < 2)) continue;
          measured++;
          const wrapped = bare.find(n => { const r = document.createRange(); r.selectNodeContents(n); return new Set([...r.getClientRects()].filter(x => x.width > 1).map(x => Math.round(x.top))).size > 1; });
          if (wrapped) add(rule, el, 'prose split into flex items', 'running text in one inline flow (wrap it in one element; the flex row holds blocks)', `${bare.length + el.children.length} items; "${snippet(wrapped.textContent.trim())}" wraps inside its own column`);
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'leading-separator') {
        // From the visual review (/iq/projects stats line): a run of
        // "a · b · c" that wraps must not start its next line with the separator.
        const sep = new RegExp(rule.separators ?? '^[·•|]$');
        let found = 0;
        // Separators are usually decorative (aria-hidden), so they are found among all painted text
        // nodes, not only the readable runs; the rows around them are judged by readable ink.
        const glyphs = [];
        for (const scope of nodes) {
          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode, el = node.parentElement, text = node.textContent.trim();
            if (!sep.test(text) || !el || el.closest('svg') || !visible(el) || faded(el)) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            const rects = [...range.getClientRects()].filter(r => r.width > 1 && r.height > 1);
            if (rects.length) glyphs.push({ node, el, text, rects });
          }
        }
        for (const run of glyphs) {
          if (found >= (rule.maxPerPage ?? 5)) continue;
          let block = run.el; while (block.parentElement && /^(inline|inline-block|inline-flex|contents)$/.test(cs(block).display)) block = block.parentElement;
          // The line holder: the nearest ancestor whose ink spans more than one row.
          let holder = block;
          for (let k = 0; k < 3 && holder.parentElement; k++) { const ink = inkRects(holder); if (rowsOf(ink).length > 1) break; holder = holder.parentElement; }
          const ink = inkRects(holder), rows = rowsOf(ink);
          if (rows.length < 2) continue;
          // A separator sits between items: a glyph that is the first text of its holder is a list marker (list.marker-alignment).
          { const w = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT); let firstText = null; while (w.nextNode()) if (w.currentNode.textContent.trim()) { firstText = w.currentNode; break; } if (firstText === run.node) continue; }
          const r = run.rects[0], mid = (r.top + r.bottom) / 2;
          const row = rows.find(x => mid >= x.top - 1 && mid <= x.bottom + 1);
          if (!row || row === rows[0]) continue;
          const leftmost = row.items.reduce((a, x) => (x.left < a.left ? x : a));
          // Judged by position: text nodes of one element ("Page ", "1", " · ", "77") share their parent.
          if (leftmost.left >= r.left - 1) { found++; add(rule, run.el, 'line starts with a separator', 'separators between items, never leading a wrapped line', `"${run.text}" opens line ${rows.indexOf(row) + 1} of ${selectorOf(holder)}`); }
        }
        samples.push({ rule: rule.id, selector: 'document', property: 'leading separators', actual: found, expected: 0 });
      }
      else if (rule.kind === 'selection-column') {
        // From the visual review (/iq/scores): a row-selection checkbox sits
        // in the table's first column, not between Name and Department.
        let measured = 0;
        for (const table of nodes) {
          for (const row of [...table.querySelectorAll(':scope > tbody > tr')].filter(visible).slice(0, 3)) {
            const cells = [...row.children].filter(c => c.matches('td, th') && visible(c));
            const at = cells.findIndex(c => c.querySelector('input[type="checkbox"], [role="checkbox"]') && !(c.textContent ?? '').trim());
            if (at < 0) continue;
            measured++;
            if (at > 0 && at < cells.length - 1) { add(rule, cells[at], 'selection column', 'the first column', `column ${at + 1} of ${cells.length}`); break; }
          }
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'column-hog') {
        // From the visual review (/iq/projects under long text): one long
        // value widens its column until the table's other columns scroll out
        // of view. A cell that can grow truncates (or wraps) before the table
        // overflows; a column may take at most `maxShare` of an overflowing table's window.
        const maxShare = rule.maxShare ?? 0.5;
        let measured = 0;
        for (const table of nodes) {
          let scroller = null;
          for (let n = table.parentElement; n && n !== document.body; n = n.parentElement) if (/^(auto|scroll|hidden)$/.test(cs(n).overflowX)) { scroller = n; break; }
          const window = scroller ? scroller.clientWidth : innerWidth;
          const overflow = (scroller ? scroller.scrollWidth : table.getBoundingClientRect().width) - window;
          const head = [...table.querySelectorAll('thead th, tbody > tr:first-child > td')].filter(visible);
          if (!head.length) continue;
          measured++;
          if (overflow <= 1) continue;
          const widest = head.reduce((a, c) => (c.getBoundingClientRect().width > a.getBoundingClientRect().width ? c : a));
          const w = widest.getBoundingClientRect().width;
          samples.push({ rule: rule.id, selector: selectorOf(table), property: 'widest column share', actual: Math.round(w / window * 100) / 100, expected: { max: maxShare } });
          if (w > maxShare * window) add(rule, widest, 'column pushing the table out of view', `<= ${Math.round(maxShare * 100)}% of the table's ${Math.round(window)}px window while the table overflows (truncate the long value)`, `${Math.round(w)}px; ${Math.round(overflow)}px of other columns out of view`);
        }
        coverage.at(-1).matched = measured;
      }
      else if (rule.kind === 'marker-first-line') {
        // From the visual review (/assessment/teams/:id criteria list): a
        // list marker (a bullet glyph, a number, an icon) beside an item that
        // wraps sits on the item's first line, not centred on the whole item.
        const glyph = /^[•·◦▪‣\-–—*]$|^\d{1,3}[.)]?$/;
        const tol = rule.tolerance ?? 2;
        let measured = 0, found = 0;
        for (const host of nodes) {
          if (found >= (rule.maxPerPage ?? 6)) break;
          const kids = [...host.children].filter(visible);
          if (kids.length < 2) continue;
          const [mark, body] = kids;
          const isMark = mark.matches('svg') ? mark.getBoundingClientRect().width <= 24 : (!mark.children.length || mark.querySelector('svg')) && (glyph.test((mark.textContent ?? '').trim()) || (!!mark.querySelector('svg') && !(mark.textContent ?? '').trim()));
          if (!isMark) continue;
          const runs = textRuns(body);
          // One wrapping text block: a single run whose lines share a font size.
          if (runs.length !== 1 || runs[0].rects.length < 2) continue;
          const lines = rowsOf(runs[0].rects.map(r => ({ ...r, el: runs[0].el })));
          if (lines.length < 2) continue;
          measured++;
          const m = mark.getBoundingClientRect(), mid = (m.top + m.bottom) / 2, first = lines[0];
          samples.push({ rule: rule.id, selector: selectorOf(host), property: 'marker on the first line', actual: Math.round(mid - (first.top + first.bottom) / 2), expected: 0 });
          if (mid < first.top - tol || mid > first.bottom + tol) { found++; add(rule, mark, 'list marker position', 'on the first line of its item', `centred ${Math.round(mid - (first.top + first.bottom) / 2)}px below the first line of "${snippet(runs[0].text)}" (${lines.length} lines)`); }
        }
        coverage.at(-1).matched = measured;
      }
    } catch (error) { add(rule, null, 'rule evaluation', 'valid selector/token/config', String(error.message), 'coverage'); }
  }
  return { issues, coverage, samples, fingerprints, geometry, viewport: { width: innerWidth, height: innerHeight }, measuredElements: new Set(samples.map(s => s.selector)).size };
}
