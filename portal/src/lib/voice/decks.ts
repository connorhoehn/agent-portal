// The voice on an open deck (docs/deck-edit-operations.md, docs/voice-navigator-spec.md §4 `update`):
// `update { ref: 'deck:<id>' | 'this-page', fields: { operations: [...] } }` sends a short list of typed edits to
// the deck in view, as its editor's page context names it (components/decks/deckVoiceContext.ts): the tenant,
// the saved head and the slides by position. Nothing the model says names a slide id, a revision or a route.
//
// The card says in words exactly what changes ("Add a timeline slide after slide 3", "Fill slide 4 with a pie
// chart from Spend by initiative"); confirming sends ONE `POST <deck>/:id/operations` on the head the page showed.
// A stale head (409 with activeRevisionId) re-reads the page context once: if the page now shows a newer head the
// same operations go again on it, else the voice says the deck changed. The editor reloads at the new revision
// (DECK_REVISED_EVENT). Free-form rewriting ("make slide 3 shorter") is NOT offered here: an instruction to an
// agent is never taken from a voice note (spec §4, "What stays a click").

import { UPDATE_ACTIONS, DECK_LAYOUTS, DECK_STYLE_NAMES, DECK_EMPHASIS_NAMES } from './catalogue.ts';
import { done, failed, once, refused, NOT_ON_PAGE, type ConfirmPlan, type ToolContext, type ToolResult } from './tools.ts';
import type { PageDeck } from './pageContext.ts';
import { announceDeckRevision, deckOpPaths, reportRenameClause, type DeckOperation } from '../../components/decks/deckApi.ts';
import { plainDeckRefusal } from '../../components/decks/deckRefusal.ts';

type Rec = Record<string, unknown>;

export const REPORT_LABELS: Readonly<Record<string, string>> = {
  'spend-by-initiative': 'Spend by initiative', 'spend-by-model': 'Spend by model', 'runs-by-outcome': 'Runs by outcome',
  'findings-by-severity': 'Findings by severity', 'jobs-by-status': 'Jobs by status',
};
const CHART_WORDS: Readonly<Record<string, string>> = { bar: 'bar', line: 'line', 'stacked-bar': 'stacked bar', pie: 'pie' };
const THEME_WORDS: Readonly<Record<string, string>> = { product: 'product', engineering: 'engineering', plain: 'plain' };
const article = (w: string) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const layoutWords = (l: string) => l.replace(/-/g, ' ');
const quoted = (t: string) => `"${t.replace(/["“”]/g, "'").slice(0, 80)}"`;

export const SAVE_FIRST = 'The deck has unsaved changes. Save them first: a voice edit applies to the saved version.';

export interface DeckOpsPlan {
  key: string;
  tenant: PageDeck['tenant'];
  deckId: string;
  baseRevisionId: string;
  operations: DeckOperation[];
  done: string;
}

/** The refusal code when no deck is open: the dock is told plainly to open one (refusals.ts). */
export const NO_DECK_OPEN = 'no-deck-open';

const PAST: Readonly<Record<string, string>> = {
  Add: 'Added', Rename: 'Renamed', Move: 'Moved', Remove: 'Removed', Fill: 'Filled', Use: 'Now using', Compose: 'Composed', Change: 'Changed', Put: 'Put', Give: 'Gave', Clear: 'Cleared',
};
/** A card line ("Fill slide 4 with …") said as done ("Filled slide 4 with …."); "3 changes to X" becomes "Made 3 changes to X.". */
export function spokenDone(line: string): string {
  const [verb, ...rest] = line.split(' ');
  const said = verb && PAST[verb] ? [PAST[verb], ...rest].join(' ') : /^\d+ changes to /.test(line) ? `Made ${line}` : line;
  return /[.!?]$/.test(said) ? said : `${said}.`;
}

/** The open deck, or the sentence that says why there is none to change. */
export function openDeck(ctx: Pick<ToolContext, 'page' | 'tenant'>, ref: string): { deck: PageDeck } | { result: ToolResult } {
  const deck = ctx.page?.()?.deck ?? null;
  // Plainly: no deck is open. No `not-on-this-page` code, whose hint (list or search instead) does not help here.
  if (!deck) return { result: refused('No deck is open. Open the deck first: a deck is changed by voice only in its editor.', { code: NO_DECK_OPEN }) };
  if (deck.tenant !== ctx.tenant) return { result: refused('That deck belongs to another workspace.') };
  const named = ref.trim();
  if (named.startsWith('deck:') && named.slice(5) !== deck.id) return { result: refused('Only the deck in view is changed by voice; open that deck first.', { code: NOT_ON_PAGE }) };
  if (deck.readOnly) return { result: refused('You can view this deck but not change it.') };
  if (deck.dirty) return { result: refused(SAVE_FIRST, { code: 'unsaved-changes' }) };
  if (!deck.headRevisionId) return { result: refused('This deck has no saved version to change yet.') };
  if (deck.viewedRevisionId && deck.viewedRevisionId !== deck.headRevisionId) return { result: refused('The editor shows an older version. Open the newest one first.') };
  return { deck };
}

/** A slide said by position ("3", "slide 3", "third"), "this" (the selected one), "last", or its title. */
function slideAt(deck: PageDeck, said: unknown, what: string): { index: number } | { result: ToolResult } {
  const s = typeof said === 'string' ? said.trim().toLowerCase() : '';
  if (!s || /^(this|this one|current|selected|here)( slide)?$/.test(s)) return { index: Math.max(0, deck.selectedPosition - 1) };
  if (/^(last|the last)( slide)?$/.test(s)) return { index: deck.slides.length - 1 };
  const n = /^(?:slide\s*)?(\d{1,2})$/.exec(s);
  if (n) {
    const i = Number(n[1]) - 1;
    if (i < 0 || i >= deck.slides.length) return { result: refused(`The deck has ${deck.slides.length} slides; there is no slide ${n[1]}.`) };
    return { index: i };
  }
  const hits = deck.slides.map((x, i) => ({ x, i })).filter(({ x }) => x.title.toLowerCase().includes(s));
  if (hits.length === 1) return { index: hits[0]!.i };
  return { result: refused(`Say which slide ${what} by its number (1 to ${deck.slides.length}).`) };
}

/** One spoken operation as the contract's, and the card's line for it. */
function planOne(op: Rec, deck: PageDeck, tenant: string): { op: DeckOperation; line: string } | { result: ToolResult } {
  const at = (key: string, what: string) => slideAt(deck, op[key], what);
  const pos = (i: number) => `slide ${i + 1}`;
  switch (op['op']) {
    case 'add_slide': {
      const layout = typeof op['layout'] === 'string' ? op['layout'] : '';
      if (!layout) return { result: refused('Adding a slide needs its layout (timeline, chart, key figures…).') };
      const title = typeof op['title'] === 'string' && op['title'].trim() ? op['title'].trim() : undefined;
      const said = typeof op['after'] === 'string' ? op['after'].trim().toLowerCase() : '';
      let after: string | undefined; let where: string;
      if (said === 'end' || said === 'last') { after = 'end'; where = 'at the end'; }
      else if (said === 'start') return { result: refused('A new slide goes after a slide; say "after slide 1" or move it to the start afterwards.') };
      else { const a = slideAt(deck, op['after'], 'it goes after'); if ('result' in a) return a; after = deck.slides[a.index]!.id; where = `after ${pos(a.index)}`; }
      const w = layoutWords(layout);
      return { op: { op: 'add_slide', layout, ...(after ? { after } : {}), ...(title ? { title } : {}) }, line: `Add ${article(w)} ${w} slide ${where}${title ? ` titled ${quoted(title)}` : ''}` };
    }
    case 'set_title': {
      const s = at('slide', 'to rename'); if ('result' in s) return s;
      const title = typeof op['title'] === 'string' ? op['title'].trim() : '';
      if (!title) return { result: refused('Renaming a slide needs the new title.') };
      return { op: { op: 'set_title', slideId: deck.slides[s.index]!.id, title }, line: `Rename ${pos(s.index)} to ${quoted(title)}` };
    }
    case 'move_slide': {
      const s = at('slide', 'to move'); if ('result' in s) return s;
      const said = typeof op['after'] === 'string' ? op['after'].trim().toLowerCase() : '';
      if (!said) return { result: refused('Say where it goes: after which slide, or to the start.') };
      if (said === 'start') return { op: { op: 'move_slide', slideId: deck.slides[s.index]!.id, to: 'start' }, line: `Move ${pos(s.index)} to the start` };
      const a = said === 'end' || said === 'last' ? { index: deck.slides.length - 1 } : slideAt(deck, op['after'], 'it goes after');
      if ('result' in a) return a;
      if (a.index === s.index) return { result: refused('A slide cannot go after itself.') };
      return { op: { op: 'move_slide', slideId: deck.slides[s.index]!.id, after: deck.slides[a.index]!.id }, line: `Move ${pos(s.index)} after ${pos(a.index)}` };
    }
    case 'remove_slide': {
      const s = at('slide', 'to remove'); if ('result' in s) return s;
      if (deck.slides.length <= 1) return { result: refused('A deck keeps at least one slide.') };
      const t = deck.slides[s.index]!.title;
      return { op: { op: 'remove_slide', slideId: deck.slides[s.index]!.id }, line: `Remove ${pos(s.index)}${t ? ` (${quoted(t)})` : ''}` };
    }
    case 'set_chart': {
      const s = at('slide', 'to fill'); if ('result' in s) return s;
      const kind = typeof op['kind'] === 'string' ? op['kind'] : 'bar';
      const report = typeof op['report'] === 'string' ? op['report'] : '';
      if (!report) return { result: refused('Filling a chart needs the report; list kind deck-report names them.') };
      const period = typeof op['period'] === 'string' ? op['period'] : undefined;
      const label = REPORT_LABELS[report] ?? report;
      return {
        op: { op: 'set_chart', slideId: deck.slides[s.index]!.id, kind: kind as 'bar', report: { report, ...(period ? { params: { period } } : {}) } },
        // The report names the slide (docs/deck-edit-operations.md, set_chart): the card says the rename before it happens.
        line: `Fill ${pos(s.index)} with ${article(CHART_WORDS[kind] ?? kind)} ${CHART_WORDS[kind] ?? kind} chart from ${label}${period ? ` (${period === 'month' ? 'this month' : `the last ${period === '7d' ? '7' : '30'} days`})` : ''}${reportRenameClause(deck.slides[s.index]!.title, report, period)}`,
      };
    }
    case 'set_theme': {
      const theme = typeof op['theme'] === 'string' ? op['theme'] : '';
      if (theme === 'workspace') return { op: { op: 'set_theme', theme: { ref: tenant } }, line: 'Use this workspace\'s own theme' };
      if (!THEME_WORDS[theme]) return { result: refused('The themes are product, engineering, plain, or this workspace\'s own.') };
      return { op: { op: 'set_theme', theme: theme as 'product' }, line: `Use the ${THEME_WORDS[theme]} theme` };
    }
    case 'set_style': {
      const style = typeof op['style'] === 'string' ? op['style'] : '';
      if (!(DECK_STYLE_NAMES as readonly string[]).includes(style)) return { result: refused(`The styles are ${DECK_STYLE_NAMES.join(', ')}.`) };
      return { op: { op: 'set_style', style }, line: `Compose the deck in the ${style} style` };
    }
    case 'change_layout': {
      // A click confirms it (clickFor): what the new layout does not draw is dropped.
      const s = at('slide', 'to change'); if ('result' in s) return s;
      const layout = typeof op['layout'] === 'string' ? op['layout'] : '';
      if (!(DECK_LAYOUTS as readonly string[]).includes(layout)) return { result: refused('Say the layout to change it to (cards, process, big number…).') };
      if (deck.slides[s.index]!.layout === layout) return { result: refused(`Slide ${s.index + 1} is already a ${layoutWords(layout)} slide.`) };
      const w = layoutWords(layout);
      return { op: { op: 'change_layout', slideId: deck.slides[s.index]!.id, layout }, line: `Change ${pos(s.index)} to ${article(w)} ${w} slide (what it cannot show is dropped)` };
    }
    case 'set_decoration': {
      const s = at('slide', 'to decorate'); if ('result' in s) return s;
      const graphic = typeof op['graphic'] === 'string' ? op['graphic'].trim().toLowerCase().replace(/\s+/g, '-') : '';
      if (!graphic) return { result: refused('Say the graphic (blob, waves, dots, rocket…) or none.') };
      if (graphic === 'none') return { op: { op: 'set_decoration', slideId: deck.slides[s.index]!.id, decoration: 'none' }, line: `Clear the decoration from ${pos(s.index)}` };
      return { op: { op: 'set_decoration', slideId: deck.slides[s.index]!.id, decoration: { graphic } }, line: `Put ${article(graphic)} ${graphic.replace(/-/g, ' ')} on ${pos(s.index)}` };
    }
    case 'set_icon': {
      const s = at('slide', 'with the item'); if ('result' in s) return s;
      const slide = deck.slides[s.index]!;
      const items = slide.items ?? [];
      if (!items.length) return { result: refused(`Slide ${s.index + 1} has no cards or steps to give an icon; icons go on cards and process slides.`) };
      const n = typeof op['n'] === 'number' ? op['n'] : 0;
      if (!Number.isInteger(n) || n < 1 || n > items.length) return { result: refused(`Say which item, 1 to ${items.length}.`) };
      const icon = typeof op['icon'] === 'string' ? op['icon'].trim().toLowerCase().replace(/\s+/g, '-') : '';
      if (!icon) return { result: refused('Say the icon (rocket, shield, users…).') };
      const next = items.map((it, i) => (i === n - 1 ? { ...it, icon } : { ...it }));
      return { op: { op: 'set_fields', slideId: slide.id, fields: { items: next } }, line: `Give item ${n} on ${pos(s.index)} (${quoted(items[n - 1]!.title)}) the ${icon} icon` };
    }
    case 'set_emphasis': {
      const s = at('slide', 'to mark'); if ('result' in s) return s;
      const said = typeof op['emphasis'] === 'string' ? op['emphasis'] : '';
      if (said !== 'none' && !(DECK_EMPHASIS_NAMES as readonly string[]).includes(said)) return { result: refused(`The emphases are ${DECK_EMPHASIS_NAMES.join(', ')}, or none.`) };
      const m = /^\s*(\d{1,2})\s*(?:-|to)?\s*(\d{1,2})?\s*$/.exec(typeof op['words'] === 'string' ? op['words'] : String(op['words'] ?? ''));
      const from = m ? Number(m[1]) : 0;
      const to = m?.[2] ? Number(m[2]) : from;
      if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < from) return { result: refused('Say which words by number, counting from 1 ("words 2 to 3").') };
      const bullet = typeof op['n'] === 'number' && Number.isInteger(op['n']) ? op['n'] : null;
      const where = bullet ? `bullet ${bullet}` : 'the title';
      const words = from === to ? `word ${from}` : `words ${from} to ${to}`;
      const emphasis = said === 'none' ? null : said;
      return {
        op: { op: 'set_emphasis', slideId: deck.slides[s.index]!.id, target: bullet ? { bullet } : 'title', from, ...(to !== from ? { to } : {}), emphasis },
        line: emphasis ? `Give ${words} of ${where} on ${pos(s.index)} ${emphasis} emphasis` : `Clear the emphasis on ${words} of ${where} on ${pos(s.index)}`,
      };
    }
    default:
      return { result: refused('A deck takes add_slide, set_title, move_slide, remove_slide, set_chart, set_theme, set_style, change_layout, set_decoration, set_icon or set_emphasis.') };
  }
}

/** The card for `update { ref: deck, fields: { operations } }`: the deck in view, every operation in words. */
export function planDeckOperations(ref: string, fields: Rec, ctx: ToolContext): { plan: ConfirmPlan } | { result: ToolResult } {
  const others = Object.keys(fields).filter((k) => k !== 'operations');
  if (others.length) return { result: refused('A deck takes one change here: operations.') };
  const open = openDeck(ctx, ref);
  if ('result' in open) return open;
  const action = UPDATE_ACTIONS[ctx.tenant]?.['deck']?.['operations'];
  if (action === undefined) return { result: refused('Decks are not changed by voice in this workspace.') };
  if (action && !ctx.can(action)) return { result: refused("I can't change this deck with your role.") };
  const said = Array.isArray(fields['operations']) ? fields['operations'] as Rec[] : [];
  if (!said.length) return { result: refused('Say what to change on the deck.') };
  const ops: DeckOperation[] = []; const lines: string[] = [];
  for (const o of said) {
    const one = planOne(o, open.deck, ctx.tenant);
    if ('result' in one) return one;
    ops.push(one.op); lines.push(one.line);
  }
  const deck = open.deck;
  const title = ctx.page?.()?.record?.title ?? 'this deck';
  const data: DeckOpsPlan = {
    key: `deck-ops ${deck.id} ${deck.headRevisionId} ${JSON.stringify(ops)}`,
    tenant: deck.tenant, deckId: deck.id, baseRevisionId: deck.headRevisionId!, operations: ops,
    done: lines.length === 1 ? lines[0]! : `${lines.length} changes to ${title}`,
  };
  return { plan: { title: `Change ${quoted(title)}`, detail: [...lines.map((l) => `${l}.`), 'It saves a new version; the current one stays in the history.'], data } };
}

async function post(ctx: ToolContext, plan: DeckOpsPlan, base: string): Promise<{ res: Response | null; body: Rec | null }> {
  try {
    const res = await ctx.fetch(deckOpPaths.operations(plan.tenant, plan.deckId), {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevisionId: base, operations: plan.operations }),
    });
    return { res, body: await res.json().catch(() => null) as Rec | null };
  } catch {
    return { res: null, body: null };
  }
}

/** Sends the confirmed operations once (the ledger); a stale head re-reads the page context once. */
export function runDeckOperations(ctx: ToolContext, plan: DeckOpsPlan): Promise<ToolResult> {
  return once(ctx, plan.key, async () => {
    let base = plan.baseRevisionId;
    let { res, body } = await post(ctx, plan, base);
    if (res && res.status === 409 && typeof body?.['activeRevisionId'] === 'string') {
      // Someone saved meanwhile. The page reloads to the newest head when it has no unsaved edits: read it once.
      const now = ctx.page?.()?.deck ?? null;
      if (now && now.id === plan.deckId && !now.dirty && now.headRevisionId && now.headRevisionId !== base) {
        base = now.headRevisionId;
        ({ res, body } = await post(ctx, plan, base));
      } else {
        return refused('Someone saved a newer version of this deck; nothing was changed. Once the editor shows it, ask again.', { code: 'stale-revision' });
      }
    }
    if (!res) return failed('Could not reach the server; the deck was not changed.');
    const raw = typeof body?.['error'] === 'string' && body['error'].trim() ? body['error'].trim() : null;
    // The validator's lines said plainly ("Slide 2 needs a title."), as the page says them.
    const error = raw ? plainDeckRefusal(raw, Array.isArray(body?.['errors']) ? (body!['errors'] as unknown[]).filter((e): e is string => typeof e === 'string') : []) : null;
    if (!res.ok) {
      // The server's own sentence: a report below the role's tier, nothing to chart, a locked slide, a stale head.
      if (res.status === 409 && typeof body?.['activeRevisionId'] === 'string') return refused('Someone saved a newer version of this deck again; nothing was changed. Ask again in a moment.', { code: 'stale-revision' });
      if (res.status >= 400 && res.status < 500) return refused(`The deck was not changed: ${error ?? `the server refused it (${res.status})`}.`);
      return failed(`The deck was not changed (HTTP ${res.status})${error ? `: ${error}` : ''}.`);
    }
    const revision = (body?.['revision'] ?? null) as Rec | null;
    const revisionId = typeof revision?.['id'] === 'string' ? revision['id'] : null;
    if (revisionId) announceDeckRevision(plan.deckId, revisionId);
    const summary = typeof body?.['summary'] === 'string' ? body['summary'] : plan.done;
    // Spoken: the card's own words in the past tense ("Filled slide 4 with a pie chart from Runs by outcome"), never ids.
    const examples = Array.isArray(body?.['exampleSourceSlideIds']) ? (body!['exampleSourceSlideIds'] as unknown[]).length : 0;
    return done('updated', {
      ref: `deck:${plan.deckId}`, ...(revisionId ? { revisionId } : {}), summary,
      say: `${spokenDone(plan.done)}${examples ? ` ${examples === 1 ? 'One slide still cites' : `${examples} slides still cite`} example content.` : ''}`,
    }, summary);
  }, () => done('updated', { ref: `deck:${plan.deckId}`, already: true }, `${plan.done} already; nothing was sent again`));
}
