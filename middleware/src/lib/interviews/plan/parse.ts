// How Milo's draft plan is read (docs/interviews-tenant-plan.md decisions 6 and 8; row I3.10; contract E0).
//
// Strict JSON, exactly `{ questions: [{ questionId, why }] }`; anything else is `malformed` and dropped whole. Then:
//   * an id that is not in the bank given is dropped (counted as off-bank); a repeated id is dropped (counted);
//   * a `why` that is empty, longer than MAX_WHY_CHARS, or that `guardSuggestion` catches (it rates, ranks, recommends,
//     or speaks of a person) drops that question (counted);
//   * more than the cap: the first `cap` are kept, in the order given;
//   * nothing left: no plan (`null`), with the counts.
// Dropped text is never kept or logged: only counts.
import { extractJson } from '../../meeting-assistant/decision-prompt.js';
import { guardSuggestion } from '../coach/parse.js';
import { MAX_WHY_CHARS } from './prompt.js';

export interface PlanQuestion { questionId: string; why: string }
export interface PlanDrops { offBank: number; duplicate: number; why: number; overCap: number }
export type PlanParseResult = { ok: true; plan: PlanQuestion[] | null; drops: PlanDrops } | { ok: false; code: 'malformed' };

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function parsePlan(raw: string | null, bankIds: ReadonlySet<string>, cap: number): PlanParseResult {
  const json = raw === null ? null : extractJson(raw);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, code: 'malformed' };
  const o = json as Record<string, unknown>;
  if (Object.keys(o).length !== 1 || !Array.isArray(o['questions'])) return { ok: false, code: 'malformed' };
  const drops: PlanDrops = { offBank: 0, duplicate: 0, why: 0, overCap: 0 };
  const seen = new Set<string>();
  const kept: PlanQuestion[] = [];
  for (const item of o['questions'] as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, code: 'malformed' };
    const r = item as Record<string, unknown>;
    const keys = Object.keys(r);
    if (keys.length !== 2 || typeof r['questionId'] !== 'string' || typeof r['why'] !== 'string') return { ok: false, code: 'malformed' };
    const id = r['questionId'];
    const why = squash(r['why']);
    if (!bankIds.has(id)) { drops.offBank++; continue; }
    if (seen.has(id)) { drops.duplicate++; continue; }
    if (!why || why.length > MAX_WHY_CHARS || guardSuggestion(why)) { drops.why++; continue; }
    seen.add(id);
    if (kept.length >= cap) { drops.overCap++; continue; }
    kept.push({ questionId: id, why });
  }
  return { ok: true, plan: kept.length ? kept : null, drops };
}
