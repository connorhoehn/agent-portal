// The preview / spec / save / download service every tenant's deck provider
// shares. A provider supplies its revision store and how it looks a deck up
// (a visibility rule belongs inside that lookup: return null to hide the deck);
// everything else — validation, CAS append, the SVG preview, the .pptx and its
// filename — is here once.

import { config } from '../../config.js';
import { agentcore } from '../../providers/index.js';
import { validateDeckSpec, type DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { previewDeckSpec } from '@connorhoehn/realtime-modules/deck';
import { renderPptx } from '@connorhoehn/realtime-modules/deck';
import { SOURCES_SLIDE_ID } from '@connorhoehn/realtime-modules/deck';
import { clip, type DeckFacts } from './plan.js';
import { mergeDraft, mockDraftResult, mockReviseResult, type ReviseDeckInput } from './narrative.js';
import { DECK_REVISE_MODE_BY_TENANT, narrativeModeAllowed, reviseModeAllowed, type DeckReviseTenant } from './narrative-modes.js';
import { revisionLabel, type ArtifactRevision, type ArtifactRevisionStore } from '../flow-artifacts/index.js';
import type { DeckPreviewOut, DeckRevisionSummary, NarrativeOutcome, Result } from './types.js';

export const summaryOf = (r: Omit<ArtifactRevision<DeckSpec>, 'spec'>): DeckRevisionSummary => ({
  id: r.id, label: r.label, createdAt: r.createdAt, producedBy: r.producedBy,
});

/** The minimum of a deck row the service needs. */
export interface DeckHead { id: string; title: string; headRevisionId: string | null }

export type DeckLookup<D extends DeckHead> = () => Promise<D | null>;

/**
 * The spec of a revision. Pass `lookup` when the tenant hides some decks from
 * some callers (a hidden deck's revisions are null too); omit it when the
 * revision store, keyed by deck id, is authority enough.
 */
export async function getRevisionSpec<D extends DeckHead>(
  revisions: ArtifactRevisionStore<DeckSpec>, lookup: DeckLookup<D> | null, deckId: string, revisionId: string,
): Promise<DeckSpec | null> {
  if (lookup && !(await lookup())) return null;
  return (await revisions.getRevision(deckId, revisionId))?.spec ?? null;
}

/** A person's edit: validates the body, then appends on the deck's head (409 when the base is stale). */
export async function savePersonRevision<D extends DeckHead>(
  revisions: ArtifactRevisionStore<DeckSpec>, lookup: DeckLookup<D>, deckId: string,
  body: { spec?: unknown; baseRevisionId?: unknown; lockedSlideIds?: unknown; label?: unknown }, sub: string | null,
): Promise<Result<DeckRevisionSummary>> {
  if (!revisions.isRevisionId(body.baseRevisionId)) return { ok: false, status: 400, reason: 'baseRevisionId must name a revision' };
  const valid = validateDeckSpec(body.spec);
  if (!valid.ok) return { ok: false, status: 400, reason: 'invalid DeckSpec', details: { errors: valid.errors } };
  let locked: string[] | undefined;
  if (body.lockedSlideIds !== undefined) {
    if (!Array.isArray(body.lockedSlideIds) || body.lockedSlideIds.some((id) => typeof id !== 'string' || !valid.spec.slides.some((s) => s.id === id))) {
      return { ok: false, status: 400, reason: 'lockedSlideIds must name slides of this spec' };
    }
    locked = [...new Set(body.lockedSlideIds as string[])];
  }
  if (body.label !== undefined && (typeof body.label !== 'string' || !body.label.trim())) return { ok: false, status: 400, reason: 'label must be a non-empty string' };
  const deck = await lookup();
  if (!deck) return { ok: false, status: 404, reason: 'deck not found' };
  const base = deck.headRevisionId === body.baseRevisionId ? await revisions.getRevision(deckId, body.baseRevisionId) : null;
  if (!base) return { ok: false, status: 409, reason: 'the deck has a newer revision', details: { activeRevisionId: deck.headRevisionId } };
  const appended = await revisions.append({
    id: revisions.newRevisionId(), deckId, baseRevisionId: base.id,
    label: typeof body.label === 'string' ? clip(body.label, 80) : 'Edited',
    spec: valid.spec, lockedSlideIds: (locked ?? base.lockedSlideIds).filter((id) => valid.spec.slides.some((s) => s.id === id)),
    producedBy: `person:${sub ?? 'unknown'}`, createdBy: sub, summary: null,
  });
  if (!appended.ok) {
    return appended.reason === 'missing'
      ? { ok: false, status: 404, reason: 'deck not found' }
      : { ok: false, status: 409, reason: 'the deck has a newer revision', details: { activeRevisionId: appended.head } };
  }
  return { ok: true, value: summaryOf(appended.revision) };
}

/** Renders any DeckSpec the caller sends (nothing is stored). */
export function previewSpec(spec: unknown): Result<DeckPreviewOut> {
  const outcome = previewDeckSpec(spec);
  if (!outcome.ok) return { ok: false, status: outcome.status, reason: 'invalid DeckSpec', details: { errors: outcome.errors } };
  return {
    ok: true,
    value: {
      slides: outcome.preview.slides.map((s) => ({
        id: s.id, svg: s.svg, title: s.title, ...(s.id === SOURCES_SLIDE_ID ? { generated: true } : {}),
      })),
      warnings: outcome.preview.warnings,
    },
  };
}

/** Preview of a spec, for a deck the caller may open (404 otherwise). */
export async function previewDeck<D extends DeckHead>(lookup: DeckLookup<D>, spec: unknown): Promise<Result<DeckPreviewOut>> {
  if (!(await lookup())) return { ok: false, status: 404, reason: 'deck not found' };
  return previewSpec(spec);
}

/** The .pptx of one revision of a deck the caller may open, with its filename; null when either is missing. */
export async function renderRevisionFile<D extends DeckHead>(
  revisions: ArtifactRevisionStore<DeckSpec>, lookup: DeckLookup<D>, deckId: string, revisionId: string, fallbackSlug: string,
): Promise<{ bytes: Buffer; filename: string } | null> {
  const deck = await lookup();
  if (!deck) return null;
  const revision = await revisions.getRevision(deckId, revisionId);
  if (!revision) return null;
  const slug = deck.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || fallbackSlug;
  return { bytes: await renderPptx(revision.spec), filename: `${slug}-${revisionLabel(revision.seq)}.pptx` };
}

// ─── Narrative (generate-with-prose) ─────────────────────────────────────────

/** Which drafter runs, and what it is told. Each tenant names its own agent. */
export interface NarrativeAgent { tenant: string; mode: string; message: string; agentId: string }

/** Nova prose for the narrative slides, or the reason it was not used. */
async function draftNarrative(
  facts: DeckFacts, input: { slides: unknown[] }, sub: string | null, agent: NarrativeAgent,
): Promise<{ result?: unknown; unavailable?: string }> {
  if (!input.slides.length) return { unavailable: 'no slide has evidence to narrate' };
  // The mode/tenant pair is checked here and again inside the agent; a mismatch
  // never fails the deck, it keeps the template prose.
  if (!narrativeModeAllowed(agent.mode, agent.tenant)) return { unavailable: `forbidden: ${agent.mode} is not a ${agent.tenant} mode` };
  if (config.mock.agentcore) return { result: mockDraftResult(input as never, facts) };
  if (process.env['DEV_OFFLINE'] === 'true') return { unavailable: 'the drafter agent is offline' };
  try {
    const res = await agentcore.invokeAgent(agent.agentId, {
      message: agent.message,
      structuredInput: { tenant: agent.tenant, mode: agent.mode, ...input, auth: { tenant: agent.tenant, sub } },
      timeoutMs: 120_000,
    });
    if (res.raw && typeof res.raw === 'object' && 'error' in res.raw) return { unavailable: String((res.raw as { error: unknown }).error) };
    if (!res.text.trim()) return { unavailable: 'the drafter returned an empty result' };
    return { result: JSON.parse(res.text) };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : 'the drafter failed' };
  }
}

/**
 * The facts deck, optionally with Nova prose merged over it (verbatim-grounded
 * by `mergeDraft`). `input` is the tenant's draft input built from the facts.
 */
export async function applyNarrative(
  facts: DeckFacts, input: { slides: unknown[] }, requested: boolean, sub: string | null,
  agent: NarrativeAgent, defaultSummary: string,
): Promise<{ spec: DeckSpec; outcome: NarrativeOutcome; summary: string }> {
  let spec = facts.spec;
  let outcome: NarrativeOutcome = { requested, status: 'none', templatedSlideIds: [] };
  let summary = defaultSummary;
  if (requested) {
    const drafted = await draftNarrative(facts, input, sub, agent);
    if (drafted.unavailable !== undefined) {
      outcome = { requested, status: 'unavailable', templatedSlideIds: [], reason: drafted.unavailable };
    } else {
      const merged = mergeDraft(facts, drafted.result);
      spec = merged.spec;
      summary = merged.summary;
      const narrated = facts.slides.filter((s) => s.prose !== 'none').map((s) => s.slideId);
      const templated = merged.templated.filter((id) => narrated.includes(id));
      outcome = { requested, status: templated.length === 0 ? 'applied' : templated.length === narrated.length ? 'fallback' : 'partial', templatedSlideIds: templated };
    }
  }
  return { spec, outcome, summary };
}

// ─── Revise (instruct the agent on a slide) ──────────────────────────────────

export interface ReviseAnswer {
  /** The drafter's (or deterministic reviser's) answer, for `mergeRevise`. */
  answer: unknown;
  /** agent: the drafter answered · fallback: refused/unavailable, the deterministic reviser answered · offline: MOCK_AGENTCORE. */
  engine: 'agent' | 'fallback' | 'offline';
}

/**
 * Asks the tenant's own revise mode for a revised spec. The mode comes from the
 * tenant (never the caller) and is checked against the guard table here and
 * again inside the agent. A refusal, an error or an empty answer yields the
 * deterministic reviser's answer (`mockReviseResult`, stateless and reset-safe),
 * so a revise never fails because the drafter did; `mergeRevise` then applies
 * the same grounding and CAS rules as before.
 */
export async function reviseWithAgent(
  tenant: DeckReviseTenant, input: ReviseDeckInput, facts: DeckFacts, sub: string | null, agentId: string,
): Promise<ReviseAnswer> {
  const deterministic = (engine: ReviseAnswer['engine']): ReviseAnswer => ({ answer: mockReviseResult(input, facts), engine });
  if (config.mock.agentcore) return deterministic('offline');
  const mode = DECK_REVISE_MODE_BY_TENANT[tenant];
  if (!reviseModeAllowed(mode, tenant) || process.env['DEV_OFFLINE'] === 'true') return deterministic('fallback');
  try {
    const res = await agentcore.invokeAgent(agentId, {
      message: `Execute deck command ${mode}`,
      structuredInput: { tenant, mode, ...input, auth: { tenant, sub } },
      timeoutMs: 120_000,
    });
    if (res.raw && typeof res.raw === 'object' && 'error' in res.raw) return deterministic('fallback');
    if (!res.text.trim()) return deterministic('fallback');
    return { answer: JSON.parse(res.text), engine: 'agent' };
  } catch { return deterministic('fallback'); }
}
