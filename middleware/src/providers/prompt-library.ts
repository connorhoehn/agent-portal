// The asset library — one catalog for everything the fleet is instructed by.
//
// Until now "prompt management" meant six agent system prompts in a flat
// Bedrock namespace, and anything else that turned up there was labelled
// "unused · not wired to anything". That framing cannot hold a prompt a person
// runs with inputs, an evaluator a pipeline calls with no human in it, or a
// skill the model discovers for itself — and those are most of the real use
// cases.
//
// So the catalog is keyed on two declared properties rather than on which
// agent happens to consume it:
//
//   KIND  — who invokes it (system | prompt | evaluator | skill | insight)
//   TIER  — how far the blast radius reaches (sandbox | internal | endpoint)
//
// A skill browser is therefore not a separate product: it is this list
// filtered to kind='skill'. Same for evaluators. One index, one search, one
// set of facets — which is also what an AGENT needs, because progressive
// disclosure is the same question ("which of these matches what I'm doing?")
// asked by a model instead of a person.
//
// Mock-first, like design-reviews: the offline demo catalog (dev:mock
// exercises every surface without Bedrock or Aurora) lives in
// mock/prompt-library.ts behind the `library-assets` fixture, so a reader
// can ask for the empty or the failed-load world instead of editing rows.
// The asset ids and their fields are unchanged — other work depends on them
// verbatim.
//
// LIVE MODE is a merge of two sources that each know half the story:
//
//   BEDROCK PROMPT MANAGEMENT is the catalog of record for template text and
//   versions, but it stores no type information at all — no kind, no tier,
//   no contract, no owner, no eval history. Every prompt it returns looks
//   identical: a name, a description, a version. That absence is the whole
//   reason `observability.prompt_version_meta` exists (see
//   schema/prompt_contract_schema.sql): it is the portal-side row that says
//   WHAT a prompt is and WHO answers for it, keyed on (prompt_id, version).
//
//   So a live asset is `LEFT JOIN`-shaped: every prompt Bedrock knows about
//   appears, decorated with its Aurora meta row when one exists. The six
//   seeded agent system prompts predate prompt_version_meta, so most of them
//   have no row yet — for those we infer what we honestly can from the NAME
//   (`orgiq-<agent>-system-prompt` → kind 'system', usedBy [`orgiq-<agent>`])
//   and default the rest (tier 'sandbox', empty contract, no owner, no eval).
//
//   Each side degrades independently rather than failing the whole page:
//   Bedrock unreachable → render Aurora's rows alone; Aurora unreachable →
//   render Bedrock's rows with defaults. A half-loaded library beats a 500,
//   the same posture bots.ts takes with its safeExec reads — writes elsewhere
//   in this app stay loud, but this is a read.

import { config } from '../config.js';
import {
  BedrockAgentClient,
  ListPromptsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { exec as auroraExec } from './aurora.js';
import {
  EMPTY_CONTRACT, type PromptContract, type PromptKind, type PromptTier,
} from '../lib/prompt-contract.js';
// The offline catalog is a registered fixture (`library-assets`), so
// `GET /api/__mock/state` can see it and an auditor can ask for the empty
// or the failed-load world over HTTP. `mockLibraryAssets` is where a stored
// row meets the latest eval run's pass rate.
import { mockLibraryAssets } from '../mock/prompt-library.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LibraryAsset {
  id: string;
  name: string;
  /** One line. For a skill this is load-bearing: it is ALL the model sees
   *  until the skill activates, so it has to say when to reach for it. */
  description: string;
  kind: PromptKind;
  tier: PromptTier;
  /** Which roles this is meant for — the facet that answers "what can I use?" */
  roles: string[];
  tags: string[];
  ownerName: string | null;
  version: string;
  lifecycleStatus: string;
  contract: PromptContract;
  evalPassRate: number | null;
  /** Consumers: agent ids, bot names, or endpoints. Empty = nothing calls it
   *  yet, which is a fact worth showing rather than a label saying "unused". */
  usedBy: string[];
  updatedAt: string;
  /** The template text. Held here so the release gate can check the contract
   *  against what the template actually references — an undeclared variable
   *  would render as untrusted, which is safe but unintended. */
  template: string;
  /** Sign-offs recorded against this version. The endpoint tier needs two,
   *  and they come from the design-review thread that ratified it. */
  signoffs: number;
  /** The ADR that ratified this asset, when one did. Closes the loop between
   *  a design decision and the thing that implements it. */
  designReviewId?: string | null;
}

/** An asset as it is STORED offline. */
export type LibraryAssetRow = LibraryAsset;

export interface LibraryQuery {
  q?: string;
  kind?: string;
  tier?: string;
  role?: string;
  limit?: number;
}

export interface LibraryFacets {
  kind: Record<string, number>;
  tier: Record<string, number>;
  role: Record<string, number>;
}


// ─── Live sources ────────────────────────────────────────────────────────────

interface BedrockPromptSummary {
  id: string;
  name: string;
  description: string;
  version: string;
  updatedAt: string;
}

/** The columns `prompt_contract_schema.sql` added to `prompt_version_meta`,
 *  plus the base table's own description/lifecycle/published_at. Everything
 *  is read as `unknown` off the Data API and narrowed on the way out — see
 *  `str`/`numOrNull` below, the same shape `prompt-history.ts` uses. */
type MetaRow = Record<string, unknown>;

let _bedrockAgent: BedrockAgentClient | null = null;
function bedrockAgent(): BedrockAgentClient {
  if (!_bedrockAgent) _bedrockAgent = new BedrockAgentClient({ region: config.region });
  return _bedrockAgent;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * All prompts in the account, paginated.
 *
 * `ListPromptsCommand` truncates to one page without `nextToken` — the
 * documented gotcha (CLAUDE.md: "ListPrompts must be paginated: the
 * un-paginated call silently misses prompts"). Returns `null`, not `[]`, on
 * failure so the caller can tell "Bedrock has no prompts" apart from
 * "Bedrock did not answer" and degrade only in the second case.
 */
async function fetchBedrockPrompts(): Promise<BedrockPromptSummary[] | null> {
  try {
    const prompts: BedrockPromptSummary[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    const MAX_PAGES = 10;
    do {
      const out = await bedrockAgent().send(
        new ListPromptsCommand(nextToken ? { nextToken } : {}),
      );
      for (const p of out.promptSummaries ?? []) {
        prompts.push({
          id: p.id ?? '',
          name: p.name ?? '',
          description: p.description ?? '',
          version: p.version ?? '',
          updatedAt: p.updatedAt?.toISOString() ?? new Date().toISOString(),
        });
      }
      nextToken = out.nextToken;
      pages += 1;
    } while (nextToken && pages < MAX_PAGES);
    return prompts;
  } catch (err) {
    console.warn('[prompt-library] Bedrock ListPrompts unavailable, degrading to Aurora-only:', (err as Error).message);
    return null;
  }
}

/**
 * Every `prompt_version_meta` row in the account. The table is small (portal-
 * authored governance metadata, not per-invocation data) so one unfiltered
 * read is cheap and avoids binding an `= ANY(:ids)` array through the Data
 * API, which nothing else in this codebase does yet. `null` on failure, same
 * "can't tell vs. empty" reasoning as `fetchBedrockPrompts`.
 */
async function fetchAuroraMeta(): Promise<MetaRow[] | null> {
  try {
    return await auroraExec(
      `SELECT prompt_id, version, kind, tier, contract::text AS contract,
              owner_email, eval_pass_rate, description, lifecycle_status,
              published_at
         FROM observability.prompt_version_meta`,
    );
  } catch (err) {
    console.warn('[prompt-library] prompt_version_meta unavailable, degrading to Bedrock defaults:', (err as Error).message);
    return null;
  }
}

function groupByPromptId(rows: MetaRow[]): Map<string, MetaRow[]> {
  const map = new Map<string, MetaRow[]>();
  for (const r of rows) {
    const id = str(r['prompt_id']);
    const list = map.get(id) ?? [];
    list.push(r);
    map.set(id, list);
  }
  return map;
}

/** The one row to represent a prompt with when several versions carry meta:
 *  the exact version Bedrock's summary currently points at, if we have it —
 *  otherwise the most recently published row, so a superseded version never
 *  outranks a live one. */
function pickMeta(rows: MetaRow[] | undefined, preferVersion?: string): MetaRow | undefined {
  if (!rows || rows.length === 0) return undefined;
  if (preferVersion) {
    const exact = rows.find((r) => str(r['version']) === preferVersion);
    if (exact) return exact;
  }
  return [...rows].sort(
    (a, b) => str(b['published_at']).localeCompare(str(a['published_at'])),
  )[0];
}

function parseContractJson(raw: unknown): PromptContract {
  if (typeof raw !== 'string' || !raw) return EMPTY_CONTRACT;
  try {
    const parsed = JSON.parse(raw) as Partial<PromptContract>;
    if (!Array.isArray(parsed.variables)) return EMPTY_CONTRACT;
    return { ...EMPTY_CONTRACT, ...parsed } as PromptContract;
  } catch {
    return EMPTY_CONTRACT;
  }
}

/** `orgiq-<agent>-system-prompt` → the agent id. The only consumer fact we
 *  can know without a row anywhere: Bedrock doesn't store it and
 *  `prompt_version_meta` has no consumers column, but the naming convention
 *  (CLAUDE.md) IS the wiring for the six seeded agent prompts. */
const SYSTEM_PROMPT_RE = /^orgiq-(.+)-system-prompt$/;

function inferredKind(id: string): PromptKind {
  return SYSTEM_PROMPT_RE.test(id) ? 'system' : 'prompt';
}

function inferredUsedBy(id: string): string[] {
  const m = SYSTEM_PROMPT_RE.exec(id);
  return m ? [`orgiq-${m[1]}`] : [];
}

/** A Bedrock prompt, decorated with its Aurora meta row when one exists and
 *  with the documented defaults when it doesn't. `template` is left empty —
 *  fetching it would mean a `GetPromptCommand` per row just to render a list,
 *  which `getAsset` can afford for the one row a detail page actually shows. */
function assetFromBedrock(p: BedrockPromptSummary, meta: MetaRow | undefined): LibraryAsset {
  const kind = meta ? (str(meta['kind'], inferredKind(p.id)) as PromptKind) : inferredKind(p.id);
  const tier = meta ? (str(meta['tier'], 'sandbox') as PromptTier) : 'sandbox';
  return {
    id: p.id,
    name: p.name || p.id,
    description: (meta ? str(meta['description']) : '') || p.description,
    kind,
    tier,
    roles: [],
    tags: [],
    ownerName: meta ? (str(meta['owner_email']) || null) : null,
    version: p.version || (meta ? str(meta['version']) : '') || 'DRAFT',
    lifecycleStatus: meta ? str(meta['lifecycle_status'], 'published') : 'published',
    contract: meta ? parseContractJson(meta['contract']) : EMPTY_CONTRACT,
    evalPassRate: meta ? numOrNull(meta['eval_pass_rate']) : null,
    // Derived from the NAME, not from `meta` — prompt_version_meta carries no
    // consumers column, so this is the same inference whether or not a row
    // exists, per the "real, knowable consumer" instruction.
    usedBy: inferredUsedBy(p.id),
    updatedAt: p.updatedAt,
    template: '',
    signoffs: 0,
    designReviewId: null,
  };
}

/** Bedrock is unreachable but Aurora answered: build the best asset we can
 *  from governance metadata alone. `name` falls back to the prompt id since
 *  Aurora never stores a display name — Bedrock is the only source for that. */
function assetFromMetaOnly(promptId: string, rows: MetaRow[]): LibraryAsset {
  const meta = pickMeta(rows);
  return {
    id: promptId,
    name: promptId,
    description: meta ? str(meta['description']) : '',
    kind: meta ? (str(meta['kind'], inferredKind(promptId)) as PromptKind) : inferredKind(promptId),
    tier: meta ? (str(meta['tier'], 'sandbox') as PromptTier) : 'sandbox',
    roles: [],
    tags: [],
    ownerName: meta ? (str(meta['owner_email']) || null) : null,
    version: meta ? str(meta['version'], 'DRAFT') : 'DRAFT',
    lifecycleStatus: meta ? str(meta['lifecycle_status'], 'published') : 'published',
    contract: meta ? parseContractJson(meta['contract']) : EMPTY_CONTRACT,
    evalPassRate: meta ? numOrNull(meta['eval_pass_rate']) : null,
    usedBy: inferredUsedBy(promptId),
    updatedAt: (meta ? str(meta['published_at']) : '') || new Date().toISOString(),
    template: '',
    signoffs: 0,
    designReviewId: null,
  };
}

/**
 * The merge. Each source is fetched independently and each failure degrades
 * on its own: Bedrock down → Aurora's rows stand alone; Aurora down →
 * Bedrock's rows carry only the inferred defaults; both down → an empty
 * catalog, which is honest (there is nothing to show, not an error to hide).
 */
async function buildLiveAssets(): Promise<LibraryAsset[]> {
  const [bedrockPrompts, metaRows] = await Promise.all([
    fetchBedrockPrompts(),
    fetchAuroraMeta(),
  ]);
  const metaMap = metaRows ? groupByPromptId(metaRows) : new Map<string, MetaRow[]>();

  if (bedrockPrompts !== null) {
    return bedrockPrompts.map((p) => assetFromBedrock(p, pickMeta(metaMap.get(p.id), p.version)));
  }
  return [...metaMap.entries()].map(([promptId, rows]) => assetFromMetaOnly(promptId, rows));
}

async function loadAllAssets(): Promise<LibraryAsset[]> {
  return config.mock.aurora ? mockLibraryAssets() : buildLiveAssets();
}

// ─── Provider ────────────────────────────────────────────────────────────────

function matches(a: LibraryAsset, q: LibraryQuery): boolean {
  if (q.kind && q.kind !== 'all' && a.kind !== q.kind) return false;
  if (q.tier && q.tier !== 'all' && a.tier !== q.tier) return false;
  if (q.role && q.role !== 'all' && !a.roles.includes(q.role)) return false;
  const term = (q.q ?? '').trim().toLowerCase();
  if (!term) return true;
  // Description is searched deliberately: it is what a model matches on for
  // progressive disclosure, so a human searching the same field is testing
  // what the agent will see.
  return [a.name, a.description, a.ownerName ?? '', ...a.tags, ...a.roles]
    .join(' ').toLowerCase().includes(term);
}

function tally(assets: LibraryAsset[], pick: (a: LibraryAsset) => string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of assets) for (const key of pick(a)) out[key] = (out[key] ?? 0) + 1;
  return out;
}

export async function listAssets(q: LibraryQuery = {}): Promise<{
  assets: LibraryAsset[];
  facets: LibraryFacets;
  total: number;
}> {
  const all = await loadAllAssets();
  const filtered = all.filter((a) => matches(a, q));
  // Facets count the WHOLE catalog, not the filtered slice — a facet that
  // vanishes once you use it cannot be used to widen a search back out.
  return {
    assets: filtered
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.min(q.limit ?? 100, 200)),
    facets: {
      kind: tally(all, (a) => [a.kind]),
      tier: tally(all, (a) => [a.tier]),
      role: tally(all, (a) => a.roles),
    },
    total: filtered.length,
  };
}

export async function getAsset(id: string): Promise<LibraryAsset | null> {
  const all = await loadAllAssets();
  return all.find((a) => a.id === id) ?? null;
}

/**
 * Assets closest to this one — the "top-k derivatives" view.
 *
 * Ranked by shared tags, then same kind. Cheap and
 * explainable on purpose: every neighbour carries the REASON it is a
 * neighbour, because an unexplained similarity list is not something anyone
 * can act on.
 */
export async function relatedAssets(id: string, k = 5): Promise<Array<{
  asset: LibraryAsset; score: number; reason: string;
}>> {
  const all = await loadAllAssets();
  const self = all.find((a) => a.id === id);
  if (!self) return [];
  const selfTags = new Set(self.tags);

  return all
    .filter((a) => a.id !== id)
    .map((a) => {
      const sharedTags = a.tags.filter((t) => selfTags.has(t));
      const sameKind = a.kind === self.kind ? 1 : 0;
      const score = sharedTags.length * 2 + sameKind;
      const reason = sharedTags.length > 0
        ? `shares ${sharedTags.join(', ')}`
        : `another ${a.kind}`;
      return { asset: a, score, reason };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
