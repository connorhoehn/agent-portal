// Synchronous agent revise, shared by the tenants whose deck editors have a
// Revise… box but no flow run behind it (orgiq initiative decks, Social decks):
// validate -> CAS check on the head -> ask the tenant's reviser
// (`reviseWithAgent`, with its deterministic fallback) -> `mergeRevise` (facts
// re-applied, locked slides kept, stated constraints checked) -> append ONE
// revision on the head the request named. Same 409 `{ error, activeRevisionId }`
// as a person's save.
//
// IDEMPOTENCY. A client may send `requestId`; the revision id is then derived
// from (deck, base revision, requestId), so a retry of the same request finds
// its revision already there and gets the first answer back (`replayed: true`)
// without asking the agent again — even though the head has moved on.

import { createHash } from 'node:crypto';
import type { DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import type { ArtifactRevisionStore } from '../flow-artifacts/index.js';
import { clip, type DeckFacts } from './plan.js';
import { buildReviseInput, mergeRevise } from './narrative.js';
import { reviseWithAgent, type DeckHead, type DeckLookup, type ReviseAnswer } from './service.js';
import type { DeckReviseTenant } from './narrative-modes.js';
import type { Result } from './types.js';

export const MAX_INSTRUCTION_CHARS = 2000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,80}$/;

export interface DeckReviseOut {
  /** The revision written; null when the edit was refused by the grounding rules or changed nothing. */
  revisionId: string | null;
  summary: string;
  changedSlideIds: string[];
  engine: ReviseAnswer['engine'];
  /** True when this is the answer to an earlier request with the same requestId. */
  replayed: boolean;
}

/** `<prefix>-<uuid-shaped digest>` — a stable revision id for one (deck, base, requestId). */
export function idempotentRevisionId(prefix: string, deckId: string, baseRevisionId: string, requestId: string): string {
  const h = createHash('sha256').update(`${deckId}\n${baseRevisionId}\n${requestId}`).digest('hex');
  return `${prefix}-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface ReviseOptions<D extends DeckHead> {
  tenant: DeckReviseTenant;
  revisions: ArtifactRevisionStore<DeckSpec>;
  lookup: DeckLookup<D>;
  deckId: string;
  /** The tenant's revision id prefix (`irev`, `srev`). */
  revisionPrefix: string;
  /** Rebuilds the deck's facts from the tenant's CURRENT record (null: the subject is gone). */
  facts: (deck: D, base: DeckSpec) => Promise<DeckFacts | null>;
  /**
   * Re-applies facts-only slides (a citation list, a title's sources) from the
   * CURRENT facts before the agent runs and again after the merge, so a slide
   * that cites something the reviser can no longer read is rewritten even when
   * the agent leaves it alone. Locked slides are never touched.
   */
  refresh?: (base: DeckSpec, facts: DeckFacts, locked: readonly string[]) => DeckSpec;
  agentId: string;
  sub: string | null;
  body: { instruction?: unknown; slideId?: unknown; baseRevisionId?: unknown; requestId?: unknown };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function reviseDeckSync<D extends DeckHead>(o: ReviseOptions<D>): Promise<Result<DeckReviseOut>> {
  const { body, revisions, deckId } = o;
  if (typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > MAX_INSTRUCTION_CHARS) {
    return { ok: false, status: 400, reason: `instruction must be 1–${MAX_INSTRUCTION_CHARS} characters` };
  }
  if (!revisions.isRevisionId(body.baseRevisionId)) return { ok: false, status: 400, reason: 'baseRevisionId must name a revision' };
  if (body.slideId !== undefined && typeof body.slideId !== 'string') return { ok: false, status: 400, reason: 'slideId must be a string' };
  if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId))) {
    return { ok: false, status: 400, reason: 'requestId must be 8–80 letters, digits or . _ : -' };
  }
  const instruction = body.instruction.trim();
  const baseId = body.baseRevisionId;
  const slideId = body.slideId as string | undefined;
  const requestId = body.requestId as string | undefined;
  const deck = await o.lookup();
  if (!deck) return { ok: false, status: 404, reason: 'deck not found' };
  const base = await revisions.getRevision(deckId, baseId);

  // A retry of a request that already landed: answer with what it wrote.
  const revisionId = requestId ? idempotentRevisionId(o.revisionPrefix, deckId, baseId, requestId) : null;
  if (revisionId) {
    const written = await revisions.getRevision(deckId, revisionId);
    if (written && base) {
      const changedSlideIds = written.spec.slides.filter((s, i) => !sameJson(s, base.spec.slides[i])).map((s) => s.id);
      return { ok: true, value: { revisionId: written.id, summary: written.summary ?? 'Deck revised as instructed.', changedSlideIds, engine: 'agent', replayed: true } };
    }
  }

  if (deck.headRevisionId !== baseId || !base) {
    return { ok: false, status: 409, reason: 'the deck has a newer revision', details: { activeRevisionId: deck.headRevisionId } };
  }
  if (slideId && !base.spec.slides.some((s) => s.id === slideId)) return { ok: false, status: 400, reason: 'slideId does not name a slide in this revision' };
  if (slideId && base.lockedSlideIds.includes(slideId)) return { ok: false, status: 409, reason: `slide ${slideId} is locked` };
  const facts = await o.facts(deck, base.spec);
  if (!facts) return { ok: false, status: 404, reason: 'the deck\'s source record was not found' };

  const working = o.refresh ? o.refresh(base.spec, facts, base.lockedSlideIds) : base.spec;
  const input = buildReviseInput(working, facts, instruction, slideId);
  const { answer, engine } = await reviseWithAgent(o.tenant, input, facts, o.sub, o.agentId);
  const mergedRaw = mergeRevise(working, answer, facts, { instruction, ...(slideId ? { slideId } : {}), locked: base.lockedSlideIds });
  if (!mergedRaw.ok) return { ok: false, status: 400, reason: mergedRaw.reason };
  // A refresh that changed a slide is itself a change, even when the agent changed nothing.
  const refreshed = !sameJson(working, base.spec);
  const merged = mergedRaw.changed
    ? { ...mergedRaw, changedSlideIds: mergedRaw.spec.slides.filter((s, i) => !sameJson(s, base.spec.slides[i])).map((s) => s.id) }
    : refreshed
      ? { ...mergedRaw, changed: true as const, spec: working, changedSlideIds: working.slides.filter((s, i) => !sameJson(s, base.spec.slides[i])).map((s) => s.id),
          summary: 'Updated the cited pages to what you can read now.' }
      : mergedRaw;
  if (!merged.changed) return { ok: true, value: { revisionId: null, summary: merged.summary, changedSlideIds: [], engine, replayed: false } };
  // The head may have moved while the agent ran: the append is the CAS.
  const appended = await revisions.append({
    id: revisionId ?? revisions.newRevisionId(), deckId, baseRevisionId: base.id,
    label: clip(`Agent: ${instruction}`, 80), spec: merged.spec, lockedSlideIds: base.lockedSlideIds,
    producedBy: `agent:${o.tenant}`, createdBy: o.sub, summary: merged.summary,
  });
  if (!appended.ok) {
    return appended.reason === 'missing'
      ? { ok: false, status: 404, reason: 'deck not found' }
      : { ok: false, status: 409, reason: 'the deck has a newer revision', details: { activeRevisionId: appended.head } };
  }
  return { ok: true, value: { revisionId: appended.revision.id, summary: `${merged.summary} Saved revision ${appended.revision.seq}.`, changedSlideIds: merged.changedSlideIds, engine, replayed: false } };
}
