// The two-persona property's machinery (G14, catalogue v2 V2-14): each
// persona is a World of fixtures (what that persona's own GETs answer, the
// providers its shell holds, the page it rendered); a tool call runs as that
// persona through prepare, plan and run, and the property holds when no
// name, id or href in a refused, ambiguous or failed payload is absent from
// that persona's own reads, and nothing of the other persona's world appears
// in it at all. visibility.test.ts runs it for orgiq, visibilityTenants.test.ts
// for the other four tenants.

import assert from 'node:assert/strict';
import { VOICE_PLANNERS, VOICE_RUNNERS } from '../actions.ts';
import { accessRequestHref, BUDGET_READ_ITEM_ID, planPreparedCall, prepareToolCall, ResultMemory, runPreparedCall, type CallAccess, type ComputeAccess, type PresenceAccess, type SocialAccess, type ToolResult, type VoiceComputer } from '../tools.ts';
import { PALETTE, toolContext, type LoggedRequest } from './voiceHarness.ts';
import type { PublishedPage } from '../pageContext.ts';
import type { Action } from '../../capabilities';

export interface World {
  /** The session's tenant and role (default orgiq, member). */
  tenant?: string;
  role?: string;
  /** What this persona's own GETs answer, by path prefix. */
  reads: Record<string, unknown>;
  computers: VoiceComputer[];
  roster: PresenceAccess;
  allow: Action[];
  social: boolean;
  socialRequestItemId: string | null;
  /** What this persona's page rendered (G21): the page context the dock may read with scope "this-page". */
  page: PublishedPage;
}

export type Mode = 'world' | 'forbidden' | 'down';

/** The persona's fetch: its own reads (or every read 403 / 500), logging what it answered. */
export function worldFetch(world: World, mode: Mode) {
  const answered: unknown[] = [];
  const log: LoggedRequest[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    log.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (mode !== 'world') return new Response('{}', { status: mode === 'forbidden' ? 403 : 500 });
    const key = Object.keys(world.reads).sort((a, b) => b.length - a.length).find((k) => url === k || url.startsWith(`${k}?`));
    if (!key) return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
    answered.push(world.reads[key]);
    return new Response(JSON.stringify(world.reads[key]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch, answered, log };
}

export function compute(world: World): ComputeAccess | null {
  if (!world.allow.includes('ManageDevbox')) return null;
  return {
    canManage: true, computers: () => world.computers,
    create: async () => { throw new Error('the property never confirms a start'); },
    remove: async () => { throw new Error('not yours to remove'); },
    openShell: () => ({ ok: false, reason: 'at-capacity' }),
    runCommand: async () => { throw new Error('not allowlisted in safe mode'); },
  };
}

export const social = (world: World): SocialAccess | null => (world.social
  ? { api: (world.tenant ?? 'orgiq') === 'social' ? '/api/social' : '/api/social/plane', unavailable: null, send: async () => { throw new Error('no receipt'); }, presence: null, deliveries: new Map() } : null);
export const calls: CallAccess = { unavailable: null, active: () => null, callConversation: () => {}, callPeople: () => {} };

/** Keys whose values name a row: a person, a record, a link. */
const IDENT_KEYS = new Set(['id', 'name', 'title', 'label', 'href', 'ref', 'path', 'initiative', 'initiativeId', 'computerId', 'userId', 'channel', 'item', 'requester', 'for', 'decidedBy', 'bot', 'sweep', 'to', 'with', 'in', 'computer', 'team', 'run', 'beneficiary']);

export function strings(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

/** Keys whose values are the fixtures' vocabulary (a status, a kind, a label), not a row's name: never "foreign". */
// `path`: a page's route (the page in view's), which both personas reach; a row's own link is its href (G50: a near-name choice names the persona's own rows' hrefs, which begin with it).
const VOCAB_KEYS = new Set(['rowsLabel', 'status', 'kind', 'type', 'priority', 'visibility', 'direction', 'severity', 'path']);

/** The strings of a world that name its rows: every string but the vocabulary's. */
export function rowStrings(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => rowStrings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!VOCAB_KEYS.has(k)) rowStrings(x, out);
  return out;
}

export function identifiers(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => identifiers(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (IDENT_KEYS.has(k) && typeof x === 'string') out.push(x);
      else identifiers(x, out);
    }
  }
  return out;
}

const capped = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

export async function runAs(world: World, mode: Mode, name: string, args: unknown): Promise<{ results: ToolResult[]; universe: Set<string> }> {
  const { fetch, answered } = worldFetch(world, mode);
  const ctx = toolContext({
    tenant: world.tenant ?? 'orgiq', role: world.role ?? 'member', allow: world.allow, fetch, compute: compute(world), social: social(world), calls, presence: world.roster,
    socialRequestItemId: world.socialRequestItemId, results: new ResultMemory(), jobs: { track: () => {} },
    page: () => world.page,
  });
  const results: ToolResult[] = [];
  const prepared = prepareToolCall(name, args, ctx);
  if (!prepared.ok) results.push(prepared.result);
  else {
    const planned = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
    if (planned && 'result' in planned) results.push(planned.result);
    else results.push(await runPreparedCall(prepared.call, ctx, VOICE_RUNNERS, planned?.plan.data));
  }
  // What this persona may be told: its own reads, the providers its own shell holds, its own words, and the
  // request link its own capabilities read named.
  const universe = strings([answered, world.computers, world.roster.roster(), world.page, args]);
  // The dock's own fixed words for that link are not a row.
  if (world.socialRequestItemId) for (const s of [world.socialRequestItemId, accessRequestHref(world.socialRequestItemId), 'Request Social access']) universe.add(s);
  // And the budgets tier's own request link (budget's offer): fixed words and the catalog item, never a row.
  for (const s of [BUDGET_READ_ITEM_ID, accessRequestHref(BUDGET_READ_ITEM_ID), 'Request budget visibility']) universe.add(s);
  // The palette's own pages (open's nearest page) are the UI the persona already sees, not rows.
  for (const p of PALETTE.pages) { universe.add(p.label); if (p.pageId) universe.add(p.pageId); }
  return { results, universe };
}

/** What one sweep saw: payloads checked, per tool and per queue_work kind. */
export interface PropertyStats { checked: number; perTool: Map<string, number>; perQueueKind: Map<string, number>; ambiguous: number; rowsNamed: number }

/**
 * Run every variant of every tool as each persona, in three modes (its own
 * reads, every read forbidden, every read down), and assert the property on
 * every refused, ambiguous or failed payload.
 */
export async function assertPersonaProperty(
  worlds: ReadonlyArray<readonly [string, World, World]>, names: readonly string[], variants: Readonly<Record<string, readonly unknown[]>>,
): Promise<PropertyStats> {
  const stats: PropertyStats = { checked: 0, perTool: new Map(), perQueueKind: new Map(), ambiguous: 0, rowsNamed: 0 };
  for (const tool of names) assert.ok(variants[tool], `${tool} has variants in this property`);
  for (const [who, mine, other] of worlds) {
    const own = strings([Object.values(mine.reads), mine.computers, mine.roster.roster(), mine.page]);
    const foreign = new Set([...rowStrings([Object.values(other.reads), other.computers, other.roster.roster(), other.page])].filter((s) => s.length > 3 && !own.has(s)));
    for (const tool of names) {
      for (const args of variants[tool]!) {
        for (const mode of ['world', 'forbidden', 'down'] as const) {
          const { results, universe } = await runAs(mine, mode, tool, args);
          for (const r of results) {
            if (r.outcome === 'done' || r.outcome === 'cancelled') continue;
            stats.checked++;
            stats.perTool.set(tool, (stats.perTool.get(tool) ?? 0) + 1);
            const kind = tool === 'queue_work' && args && typeof args === 'object' ? String((args as Record<string, unknown>)['kind']) : null;
            if (kind) stats.perQueueKind.set(kind, (stats.perQueueKind.get(kind) ?? 0) + 1);
            if (r.output['kind'] === 'ambiguous') stats.ambiguous++;
            const where = `${who} ${tool} ${JSON.stringify(args)} ${mode}`;
            // How many payloads named a row of the persona's own reads (the property is not only checking empty refusals).
            if (identifiers(r.output).some((id) => id.length > 3 && own.has(id))) stats.rowsNamed++;
            for (const id of identifiers(r.output)) {
              // A typed ref (`kind:id`, catalogue v2) names a row by the id the persona's own read returned.
              const typed = /^[a-z][a-z-]*:(.+)$/.exec(id)?.[1];
              const known = (x: string) => universe.has(x) || [...universe].some((u) => capped(u) === x);
              // A portal link the dock built from such an id (kinds.ts href) names the same row: one of its segments is the id.
              const linked = id.startsWith('/') && decodeURIComponent(id).split(/[/?=&]/).some((seg) => seg.length > 2 && known(seg.replace(/^[a-z][a-z-]*:/, '')));
              assert.ok(known(id) || (typed != null && known(typed)) || linked, `${where}: "${id}" is not in this persona's own reads`);
            }
            const text = JSON.stringify(r.output) + r.summary;
            for (const f of foreign) assert.ok(!text.includes(f), `${where}: names the other persona's "${f}"`);
          }
        }
      }
    }
  }
  return stats;
}
