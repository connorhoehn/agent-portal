// The composer's operations mode (docs/deck-edit-operations.md, "Proposals"):
// a request that changes a deck's structure, layout, style, decoration,
// emphasis or charts is answered with a short reply and a PROPOSED list of
// typed operations, never a saved revision.
//
// The drafter agent is given the deck's outline (slide ids, layouts, titles and
// bullets as plain text) and the operations schema, in its tenant's operations
// mode (narrative-modes.ts), with the same money rule as a revise: held before
// the call, booked after (spend.ts). Its list then goes through every check
// `applyDeckOperations` makes (`planDeckOperations`), and nothing is saved: the
// person applies it with their own authority through `POST <deck>/:id/operations`.
//
// A list the validator refuses comes back as `refusal` beside the reply, so the
// composer can say why plainly; a refused spend takes the deterministic
// proposer (`offlineProposal`), as the revise takes its deterministic reviser.

import { DECK_DECORATION_PLACEMENTS, DECK_EMPHASES, plainText, type DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { BUILTIN_THEMES, DECK_STYLES, GRAPHIC_NAMES } from '@connorhoehn/realtime-modules/deck/layout';
import { config } from '../../config.js';
import { agentcore } from '../../providers/index.js';
import { MAX_INSTRUCTION_CHARS } from './revise.js';
import { DECK_OPERATIONS_MODE_BY_TENANT, operationsModeAllowed } from './narrative-modes.js';
import { DECK_OPERATION_KINDS, MAX_DECK_OPERATIONS, SLIDE_LAYOUTS, planDeckOperations, type ApplyOperationsInput, type OperationsOut } from './operations.js';
import { meteredDeckInvoke } from './spend.js';
import { deckStyleOf, themeChoice, type DeckHostTenant } from './themes.js';
import type { Result } from './types.js';

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the model is told about the deck: positions, ids, layouts and the words on each slide, as plain text. */
export interface DeckOutline {
  title: string;
  theme: string;
  style: string;
  slides: Array<{ position: number; slideId: string; layout: string; title: string; bullets?: string[]; locked?: true }>;
}

export interface ProposeInput {
  instruction: string;
  /** The slide on the stage, when the request is about one. */
  slideId?: string;
  outline: DeckOutline;
  /** What each operation may name (docs/deck-edit-operations.md). */
  schema: {
    maxOperations: number; kinds: readonly string[]; layouts: readonly string[]; styles: readonly string[];
    themes: readonly string[]; emphases: readonly string[]; placements: readonly string[]; graphics: readonly string[];
    reports: Array<{ id: string; description: string }>;
  };
}

export interface ProposeOut {
  /** The model's short reply, said in the composer above the card. */
  reply: string;
  /** The head the proposal was checked on; Apply sends it as `baseRevisionId`. */
  baseRevisionId: string;
  /** The proposed operations as the contract takes them, at most ten. Empty: nothing to change. */
  operations: unknown[];
  /** One plain line per operation, in order ("Change slide 3 from bullets to kpi"). */
  lines: string[];
  /** True when any operation removes a slide: the card says so and Apply is the only way it happens. */
  destructive: boolean;
  touchedSlideIds: string[];
  findings: OperationsOut['findings'];
  /** Set when the validator refused the list: nothing can be applied, and this says why. */
  refusal?: { reason: string; errors?: string[] };
  engine: 'agent' | 'offline' | 'fallback';
  /** Set only when the deterministic proposer answered because the spend was refused. */
  reason?: string;
}

export interface ProposeOptions {
  /** The same input the operations route gives `applyDeckOperations` (resolver, record source, lookup). */
  apply: Omit<ApplyOperationsInput, 'body'>;
  agentId: string;
  /** The initiative the call is charged to (null: unattributed, the requester's alone). */
  initiativeId: string | null;
  /** The chart reports this caller may read on this deck (`GET <deck>/:id/chart-reports`). */
  reports?: Array<{ id: string; description: string }>;
  body: { instruction?: unknown; slideId?: unknown; baseRevisionId?: unknown };
}

/** The deck as the model reads it. Bullets are kept so an emphasis can name word numbers. */
export function deckOutline(spec: DeckSpec, tenant: DeckHostTenant, locked: readonly string[]): DeckOutline {
  const choice = themeChoice(spec.theme);
  return {
    title: plainText(spec.title as never) || 'Untitled deck',
    theme: choice.base ?? 'product',
    style: deckStyleOf(spec.theme, tenant),
    slides: spec.slides.map((s, i) => ({
      position: i + 1, slideId: s.id, layout: s.layout, title: plainText(s.title).slice(0, 160),
      ...(s.bullets?.length ? { bullets: s.bullets.slice(0, 8).map((b) => plainText(b).slice(0, 160)) } : {}),
      ...(locked.includes(s.id) ? { locked: true as const } : {}),
    })),
  };
}

// ── the deterministic proposer (offline, or a refused spend) ─────────────────

const LAYOUT_WORDS: Readonly<Record<string, string>> = {
  kpi: 'kpi', 'key figures': 'key-figures', 'key figure': 'key-figures', 'big number': 'big-number', 'two column': 'two-column',
  'two-column': 'two-column', 'image text': 'image-text', 'big quote': 'big-quote', 'full image': 'image-full',
};
function layoutFrom(words: string): string | null {
  const w = words.trim().toLowerCase().replace(/\s+/g, ' ');
  if (LAYOUT_WORDS[w]) return LAYOUT_WORDS[w]!;
  const dashed = w.replace(/ /g, '-');
  return (SLIDE_LAYOUTS as readonly string[]).includes(dashed) ? dashed : null;
}

/** A slide said by number, "this", or by a word of its title (or layout: "the agenda"). */
function slideNamed(outline: DeckOutline, said: string | undefined, selected?: string): string | null {
  const s = (said ?? '').trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+slide$/, '');
  if (!s || s === 'this' || s === 'this one') return selected ?? null;
  const n = /^(?:slide\s*)?(\d{1,2})$/.exec(s);
  if (n) return outline.slides[Number(n[1]) - 1]?.slideId ?? null;
  const hit = outline.slides.find((x) => x.title.toLowerCase().includes(s) || x.layout === s);
  return hit?.slideId ?? null;
}

/**
 * A few plain requests turned into operations without a model: what the local
 * mock and a refused spend answer. Anything else gets an empty list and a reply
 * saying to phrase it as one of these, or to use the editor.
 */
export function offlineProposal(input: ProposeInput): { reply: string; operations: Rec[] } {
  const text = input.instruction.trim().replace(/[.!]+$/, '');
  const { outline } = input;
  const ops: Rec[] = [];
  let m: RegExpExecArray | null;
  if ((m = /\b(?:make|turn|change)\s+(slide\s*\d{1,2}|this slide|it)\s+(?:into\s+|to\s+)?(?:an?\s+)?([a-z -]+?)\s+(?:slide|layout)\b/i.exec(text))) {
    const slideId = m[1]!.toLowerCase() === 'it' ? input.slideId ?? null : slideNamed(outline, m[1], input.slideId);
    const layout = layoutFrom(m[2]!);
    if (slideId && layout) {
      ops.push({ op: 'change_layout', slideId, layout });
      // A chart or KPI slide needs its chart in the same list: the first report this caller may read.
      const report = input.schema.reports[0];
      if ((layout === 'kpi' || layout === 'chart') && report) ops.push({ op: 'set_chart', slideId, kind: layout === 'kpi' ? 'line' : 'bar', report: { report: report.id } });
    }
  } else if ((m = /\badd\s+(?:an?\s+)?([a-z -]+?)\s+slide(?:\s+(?:after|following)\s+(.+))?$/i.exec(text))) {
    const layout = layoutFrom(m[1]!);
    const after = m[2] ? slideNamed(outline, m[2]) : null;
    if (layout && (!m[2] || after)) ops.push({ op: 'add_slide', layout, ...(after ? { after } : {}) });
  } else if ((m = /\b(?:switch|change|move|set)\s+(?:it\s+|the deck\s+)?(?:to|into)\s+(?:the\s+|an?\s+)?([a-z]+)\s+style\b/i.exec(text))
    || (m = /\buse\s+(?:the\s+|an?\s+)?([a-z]+)\s+style\b/i.exec(text))) {
    const style = m[1]!.toLowerCase();
    if ((DECK_STYLES as readonly string[]).includes(style)) ops.push({ op: 'set_style', style });
  } else if ((m = /\b(?:switch\s+to|use)\s+(?:the\s+)?([a-z]+)\s+theme\b/i.exec(text))) {
    const theme = m[1]!.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(BUILTIN_THEMES, theme)) ops.push({ op: 'set_theme', theme });
  } else if ((m = /\b(?:remove|delete|drop)\s+(slide\s*\d{1,2}|this slide)\b/i.exec(text))) {
    const slideId = slideNamed(outline, m[1], input.slideId);
    if (slideId) ops.push({ op: 'remove_slide', slideId });
  } else if ((m = /\bmove\s+(slide\s*\d{1,2})\s+(?:to the start|after\s+(.+))$/i.exec(text))) {
    const slideId = slideNamed(outline, m[1]);
    const after = m[2] ? slideNamed(outline, m[2]) : null;
    if (slideId && (!m[2] || after)) ops.push({ op: 'move_slide', slideId, ...(after ? { after } : { to: 'start' }) });
  } else if ((m = /\bemphasi[sz]e\s+['"‘“](.+?)['"’”]\s+in\s+the\s+title(?:\s+(?:of|on)\s+(slide\s*\d{1,2}))?/i.exec(text))) {
    const slideId = m[2] ? slideNamed(outline, m[2]) : input.slideId ?? outline.slides[0]?.slideId ?? null;
    const slide = outline.slides.find((s) => s.slideId === slideId);
    const words = slide ? slide.title.split(/\s+/).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) : [];
    const want = m[1]!.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''));
    const at = words.findIndex((_, i) => want.every((w, j) => words[i + j] === w));
    if (slide && at >= 0) ops.push({ op: 'set_emphasis', slideId: slide.slideId, target: 'title', from: at + 1, to: at + want.length, emphasis: 'highlight' });
  } else if ((m = /\bput\s+(?:the\s+|a\s+)?(.+?)\s+(pie|bar|line)(?:\s+chart)?\s+on\s+(slide\s*\d{1,2}|this slide)\b/i.exec(text))) {
    const slideId = slideNamed(outline, m[3], input.slideId);
    const said = m[1]!.toLowerCase();
    const report = input.schema.reports.find((r) => r.id.split('-').some((w) => w.length > 3 && said.includes(w)));
    if (slideId && report) ops.push({ op: 'set_chart', slideId, kind: m[2]!.toLowerCase(), report: { report: report.id } });
  }
  return ops.length
    ? { reply: 'Here is the change. Apply it to save a new version.', operations: ops }
    : { reply: 'I could not turn that into deck changes. Try "make slide 3 a KPI slide", "switch to the editorial style" or "add a process slide after the agenda", or edit the slide directly.', operations: [] };
}

// ── the agent call ───────────────────────────────────────────────────────────

/** The model's answer, read leniently: a reply string and a list (anything else is dropped). */
function readAnswer(text: string): { reply: string; operations: Rec[] } | null {
  try {
    const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as unknown;
    if (!isObj(raw)) return null;
    const reply = typeof raw['reply'] === 'string' ? raw['reply'].trim().slice(0, 600) : '';
    const operations = Array.isArray(raw['operations']) ? raw['operations'].filter(isObj) : [];
    return { reply, operations };
  } catch { return null; }
}

export async function proposeWithAgent(
  tenant: DeckHostTenant, input: ProposeInput, sub: string | null, agentId: string, initiativeId: string | null,
): Promise<{ reply: string; operations: Rec[]; engine: ProposeOut['engine']; reason?: string }> {
  const deterministic = (engine: ProposeOut['engine']) => ({ ...offlineProposal(input), engine });
  if (config.mock.agentcore) return deterministic('offline');
  const mode = DECK_OPERATIONS_MODE_BY_TENANT[tenant];
  if (!operationsModeAllowed(mode, tenant) || process.env['DEV_OFFLINE'] === 'true') return deterministic('fallback');
  try {
    // Money (ledger P-12): held before the call, booked after, as a revise is; a refusal takes the deterministic proposer.
    const metered = await meteredDeckInvoke({ tenant, action: 'propose', actorId: sub, initiativeId }, () => agentcore.invokeAgent(agentId, {
      message: `Execute deck command ${mode}`,
      structuredInput: { tenant, mode, ...input, auth: { tenant, sub } },
      timeoutMs: 60_000,
    }));
    if (metered.kind === 'refused') return { ...deterministic('fallback'), reason: metered.reason };
    const { res } = metered;
    if (res.raw && typeof res.raw === 'object' && 'error' in res.raw) return deterministic('fallback');
    const answer = readAnswer(res.text);
    if (!answer) return deterministic('fallback');
    return { reply: answer.reply || (answer.operations.length ? 'Here is the change.' : 'There is nothing to change for that.'), operations: answer.operations, engine: 'agent' };
  } catch { return deterministic('fallback'); }
}

const IMPERATIVE: Readonly<Record<string, string>> = {
  added: 'Add', removed: 'Remove', moved: 'Move', retitled: 'Rename', changed: 'Change', set: 'Set', edited: 'Edit',
  put: 'Put', gave: 'Give', cleared: 'Clear',
};
/** The validator's past-tense phrase as a card line: "changed slide 3 from bullets to kpi" → "Change slide 3 from bullets to kpi". */
export function cardLine(phrase: string): string {
  const [verb, ...rest] = phrase.split(' ');
  return [IMPERATIVE[verb ?? ''] ?? verb, ...rest].join(' ');
}

/** Ask, check, and answer the proposal. Nothing is written. */
export async function proposeDeckOperations(o: ProposeOptions): Promise<Result<ProposeOut>> {
  const { body, apply } = o;
  if (typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > MAX_INSTRUCTION_CHARS) {
    return { ok: false, status: 400, reason: `instruction must be 1–${MAX_INSTRUCTION_CHARS} characters` };
  }
  if (!apply.revisions.isRevisionId(body.baseRevisionId)) return { ok: false, status: 400, reason: 'baseRevisionId must name a revision' };
  if (body.slideId !== undefined && typeof body.slideId !== 'string') return { ok: false, status: 400, reason: 'slideId must be a string' };
  const deck = await apply.lookup();
  if (!deck) return { ok: false, status: 404, reason: 'deck not found' };
  const base = deck.headRevisionId === body.baseRevisionId ? await apply.revisions.getRevision(apply.deckId, body.baseRevisionId) : null;
  if (!base) return { ok: false, status: 409, reason: 'the deck has a newer revision', details: { activeRevisionId: deck.headRevisionId } };
  const slideId = body.slideId as string | undefined;
  if (slideId && !base.spec.slides.some((s) => s.id === slideId)) return { ok: false, status: 400, reason: 'slideId does not name a slide in this revision' };

  const input: ProposeInput = {
    instruction: body.instruction.trim(), ...(slideId ? { slideId } : {}),
    outline: deckOutline(base.spec, apply.tenant, base.lockedSlideIds),
    schema: {
      maxOperations: MAX_DECK_OPERATIONS, kinds: DECK_OPERATION_KINDS, layouts: SLIDE_LAYOUTS, styles: DECK_STYLES,
      themes: [...Object.keys(BUILTIN_THEMES), `{ ref: '${apply.tenant}' }`], emphases: DECK_EMPHASES, placements: DECK_DECORATION_PLACEMENTS,
      graphics: GRAPHIC_NAMES, reports: (o.reports ?? []).map((r) => ({ id: r.id, description: r.description })),
    },
  };
  const answer = await proposeWithAgent(apply.tenant, input, apply.sub, o.agentId, o.initiativeId);
  const why = answer.reason !== undefined ? { reason: answer.reason } : {};
  const empty = { touchedSlideIds: [], findings: [], lines: [], destructive: false };
  if (!answer.operations.length) {
    return { ok: true, value: { reply: answer.reply, baseRevisionId: base.id, operations: [], ...empty, engine: answer.engine, ...why } };
  }
  const destructive = answer.operations.some((op) => op['op'] === 'remove_slide');
  const planned = await planDeckOperations({ ...apply, body: { baseRevisionId: base.id, operations: answer.operations } });
  if (!planned.ok) {
    const errors = Array.isArray(planned.details?.['errors']) ? (planned.details['errors'] as unknown[]).filter((e): e is string => typeof e === 'string') : [];
    return {
      ok: true,
      value: {
        reply: answer.reply, baseRevisionId: base.id, operations: answer.operations, ...empty, destructive,
        refusal: { reason: planned.reason, ...(errors.length ? { errors } : {}) }, engine: answer.engine, ...why,
      },
    };
  }
  return {
    ok: true,
    value: {
      reply: answer.reply, baseRevisionId: base.id, operations: answer.operations, lines: planned.value.phrases.map(cardLine), destructive,
      touchedSlideIds: planned.value.touchedSlideIds, findings: planned.value.findings, engine: answer.engine, ...why,
    },
  };
}
