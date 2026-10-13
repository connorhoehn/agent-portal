// THE route inventory (audit 2026-10-07 T4): every page the shell can open,
// per tenant, with the seeded user a sweep signs in as, the kind of content it
// holds, its rail depth, the judges that apply to it and the specs whose
// assertions cover it. Every route list a judge or sweep needs lives here —
// layout-cascade.spec.ts, type-scale-sweep.spec.ts, the rail measurement in
// validate-rail-parity.sh, the nav-parity judge (through route-sources.ts) and
// the journey freshness rule (scripts/journeys/, docs/journeys.md) all read
// it. Do not add a route list anywhere else; add the route here.
//
// Static routes come from the shell registry (the palette + rail path
// literals, route-sources.ts), every social/pipelines surface, the section
// landings and the parameterised routes below, resolved against seeded
// fixture ids. App.tsx's <Route> tree supplies the pattern a concrete URL
// belongs to.
//
// Plain TypeScript with erasable syntax only, so `node` runs it directly:
//   node portal/e2e/route-inventory.ts routes            # the static inventory, JSON
//   node portal/e2e/route-inventory.ts subjects <set>    # rail-social | rail-communication | list-rail, one URL per line
//   node portal/e2e/route-inventory.ts key <url>...      # the inventory key each URL is judged under
//   node portal/e2e/route-inventory.ts coverage          # route key -> specs whose assertions cover it, JSON
//   node portal/e2e/route-inventory.ts source-digest     # the digest a contract measurement is taken against
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SOCIAL_SURFACE_IDS } from '../src/pages/social/socialSurfaces.ts';
import { PIPELINES_SURFACE_IDS } from '../src/pages/pipelines/pipelinesSurfaces.ts';
import { REPO_ROOT, readRouteSources, type AppRoute } from './route-sources.ts';

export type Tenant = 'orgiq' | 'assessment' | 'social' | 'pipelines' | 'access';
export const TENANTS: readonly Tenant[] = ['orgiq', 'assessment', 'social', 'pipelines', 'access'];

/** One sign-in per tenant: the seeded admin holds a grant in all four
 *  (middleware/src/providers/identity.ts), so every gated page renders. */
export const SWEEP_USER = 'u-operator';

export type Invariant = 'rails' | 'list-rail' | 'crumbs-first' | 'gutter' | 'title' | 'footer' | 'hscroll';

/** The judges a route can fall under. `cascade` and `type-scale` are the
 *  per-route sweeps; the others are the scenario lists further down. */
export type Judge = 'cascade' | 'type-scale' | 'list-rail' | 'rail-chat' | 'depth' | 'state' | 'palette' | 'table';
/** What the content column holds — the shape a walk and a sweep look at. */
export type RouteKind = 'landing' | 'list' | 'record' | 'editor' | 'chat' | 'page';

export interface ParamResolve { url: string; pick: (json: unknown) => string | undefined }
export interface ParamRoute {
  tenant: Tenant;
  /** The App.tsx pattern, for the report. */
  pattern: string;
  /** `:id` replaced by the id. */
  template: string;
  id?: string;
  resolve?: ParamResolve;
  fallback?: string;
}

export interface InventoryRoute {
  tenant: Tenant;
  path: string;
  source: 'registry' | 'surface' | 'landing' | 'param';
  pattern?: string;
  /** The seeded user a sweep signs in as. */
  user?: string;
  kind?: RouteKind;
  /** The library rail model's depth for this URL (docs/layout-cascade.md rule 8). */
  depth?: number;
  judges?: Judge[];
}

/** Pages whose design deliberately differs on one invariant, with the
 *  decision that says so. Nothing else may skip a check. */
export const EXEMPT: ReadonlyArray<{ match: RegExp; invariants: Invariant[]; reason: string }> = [
  {
    match: /^\/social\/(channels|dms|teams|rooms|calls|recordings)(\/|$|\?)/,
    invariants: ['crumbs-first', 'gutter', 'title'],
    reason: 'docs/rail-parity-goal.md decision 6: the chat workspace is rail + conversation, no crumb row or PageHeader above the rail',
  },
];

export function tenantOf(p: string): Tenant {
  return p.startsWith('/assessment') ? 'assessment' : p.startsWith('/social') ? 'social'
    : p.startsWith('/pipelines') ? 'pipelines' : p.startsWith('/access') ? 'access' : 'orgiq';
}

export const LANDINGS: ReadonlyArray<[Tenant, string]> = [
  ['orgiq', '/iq'],
  ['orgiq', '/iq/projects?nav=section'],
  ['orgiq', '/iq/designs?nav=section'],
  ['orgiq', '/iq/library?nav=section'],
  ['orgiq', '/iq/distillation/knowledge?nav=distillation'],
  ['assessment', '/assessment'],
  ['social', '/social'],
  ['pipelines', '/pipelines'],
  ['access', '/access'],
];

/** Who opens each tenant's landings in section-landings.spec.ts (a role whose
 *  home is that tenant), and the landing whose list must show its first row
 *  above the fold. */
export const LANDING_USERS: Readonly<Record<Tenant, string>> = { orgiq: 'u-mia', assessment: 'u-asha', social: 'u-sana', pipelines: 'u-ines', access: 'u-rhea' };
export const LANDING_LIST = '/iq/projects?nav=section';

export const first = (key: string, field = 'id') => (json: unknown): string | undefined => {
  const list = Array.isArray(json) ? json : (json as Record<string, unknown> | null)?.[key];
  const row = Array.isArray(list) ? list[0] as Record<string, unknown> | undefined : undefined;
  const value = row?.[field];
  return typeof value === 'string' ? value : undefined;
};

export const PARAM_ROUTES: readonly ParamRoute[] = [
  // Org
  { tenant: 'orgiq', pattern: '/iq/projects/:id', template: '/iq/projects/:id', id: 'p-auth-migration' },
  { tenant: 'orgiq', pattern: '/iq/projects/:id?item=', template: '/iq/projects/p-auth-migration?item=:id', id: 'wi-auth-e1-s1' },
  { tenant: 'orgiq', pattern: '/iq/decisions/:id', template: '/iq/decisions/:id', id: 'd-aurora' },
  { tenant: 'orgiq', pattern: '/iq/agents/:agentId', template: '/iq/agents/:id', id: 'orgiq-supervisor' },
  { tenant: 'orgiq', pattern: '/iq/designs/:id', template: '/iq/designs/:id', id: 'des-auth-rotation' },
  { tenant: 'orgiq', pattern: '/iq/documents/:documentId', template: '/iq/documents/:id', id: 'page:A100003' },
  { tenant: 'orgiq', pattern: '/iq/runs/:id', template: '/iq/runs/:id', resolve: { url: '/api/runs', pick: first('runs') }, fallback: 'run-missing' },
  { tenant: 'orgiq', pattern: '/iq/work/:jobId', template: '/iq/work/:id', resolve: { url: '/api/work/jobs?limit=1', pick: first('jobs') }, fallback: 'job-missing' },
  { tenant: 'orgiq', pattern: '/iq/library/:assetId', template: '/iq/library/:id', resolve: { url: '/api/library?limit=1', pick: first('assets') }, fallback: 'asset-missing' },
  { tenant: 'orgiq', pattern: '/iq/decks/:deckId', template: '/iq/decks/:id', id: 'deck-missing' },
  { tenant: 'orgiq', pattern: '/iq/distillation/review?sample=', template: '/iq/distillation/review?sample=:id', id: 'rev-027' },
  { tenant: 'orgiq', pattern: '/iq/distillation/knowledge?item=', template: '/iq/distillation/knowledge?item=:id', id: 'art-001' },
  { tenant: 'orgiq', pattern: '/iq/distillation/knowledge?view=notes', template: '/iq/distillation/knowledge?view=:id', id: 'notes' },
  { tenant: 'orgiq', pattern: '/iq/distillation/activity?view=graph', template: '/iq/distillation/activity?view=:id', id: 'graph' },
  // Assessment
  { tenant: 'assessment', pattern: '/assessment/teams/:teamId', template: '/assessment/teams/:id', id: 'TEAM-001' },
  // A submission record beside its list rail; the id is a group's original envelope (a revision's id opens its group too).
  { tenant: 'assessment', pattern: '/assessment/submissions/:submissionId', template: '/assessment/submissions/:id', resolve: { url: '/api/assessment/submissions', pick: (json: unknown) => ((json as { envelopes?: Array<{ envelope_id?: string }> }).envelopes ?? []).find((e) => e.envelope_id && !/-r\d+$/.test(e.envelope_id))?.envelope_id }, fallback: 'submission-missing' },
  { tenant: 'assessment', pattern: '/assessment/decks/:deckId', template: '/assessment/decks/:id', resolve: { url: '/api/assessment/decks', pick: first('decks') }, fallback: 'deck-missing' },
  // Social
  { tenant: 'social', pattern: '/social/channels/:slug', template: '/social/channels/:id', id: 'general' },
  { tenant: 'social', pattern: '/social/decks/:deckId', template: '/social/decks/:id', resolve: { url: '/api/chat/decks?channel=social%3Ach%3Ageneral', pick: first('decks') }, fallback: 'deck-missing' },
  // Pipelines
  { tenant: 'pipelines', pattern: '/pipelines/runs/:id', template: '/pipelines/runs/:id', resolve: { url: '/api/pipelines/runs?limit=1', pick: first('runs') }, fallback: 'run-missing' },
  { tenant: 'pipelines', pattern: '/pipelines/decks/:deckId', template: '/pipelines/decks/:id', resolve: { url: '/api/pipelines/decks', pick: first('decks') }, fallback: 'deck-missing' },
  // Access — the seeded request (middleware/src/mock/access-requests.ts, schema/access_schema.sql); a record (kindOf: param).
  { tenant: 'access', pattern: '/access/requests/:id', template: '/access/requests/:id', id: 'req-0001' },
  // The seeded review campaign (middleware/src/mock/access-reviews.ts, schema/access_schema.sql); a collection record.
  { tenant: 'access', pattern: '/access/reviews/:id', template: '/access/reviews/:id', id: 'rev-0001' },
  // The seeded separation-of-duties policy (middleware/src/mock/access-policies.ts, schema/access_schema.sql);
  // a collection record beside its list rail (CollectionRecordFrame), kindOf: param → record.
  { tenant: 'access', pattern: '/access/policies/:id', template: '/access/policies/:id', id: 'sod-001' },
];

/**
 * Routes a journey walks that the judged inventory does not hold. The sweeps
 * MEASURE them — their cascade and type-scale contract is recorded, so a walk
 * of them can be judged fresh or stale (docs/journeys.md) — but never JUDGE
 * them: they are outside the cascade baseline and the type-scale burn-down,
 * and moving one into PARAM_ROUTES (or the registry) is what makes it judged.
 */
export const OBSERVED_ROUTES: readonly ParamRoute[] = [
  { tenant: 'orgiq', pattern: '/iq/communication/channels/:slug', template: '/iq/communication/channels/:id?view=shared', id: 'general' },
  { tenant: 'assessment', pattern: '/assessment/communication/channels/:slug', template: '/assessment/communication/channels/:id?view=shared', id: 'general' },
  { tenant: 'pipelines', pattern: '/pipelines/communication/channels/:slug', template: '/pipelines/communication/channels/:id?view=shared', id: 'general' },
  { tenant: 'orgiq', pattern: '/admin/identity/roles', template: '/admin/identity/:id', id: 'roles' },
  { tenant: 'orgiq', pattern: '/admin/bots/:id', template: '/admin/bots/:id', id: '32970d0a-e28e-5100-8fb0-a5cbb87dac99' },
  { tenant: 'social', pattern: '/social/dms/:lobby', template: '/social/dms/:id', id: 'social:dm:u-operator:u-sana' },
];

// ── Scenario lists (each was a private list in a spec or a validator) ──────

/** Rule 5 (docs/layout-cascade.md): every list page draws a flush list rail
 *  beside the section rail. `record`: a record is open beside the list rail
 *  (the selection level — the primary rail folds). `editor`: the record is an
 *  EditorShell whose header, body and docked composer share one left edge.
 *  Read by layout-cascade.spec.ts and validate-rail-parity.sh's list-rail measurement. */
export interface ListPage { path?: string; param?: ParamRoute; repoInRail: boolean; record?: boolean; editor?: boolean }
export const LIST_PAGES: readonly ListPage[] = [
  { path: '/iq/distillation/review?sample=rev-027&panel=sources&sourceView=graph', repoInRail: true, record: true, editor: true },
  { path: '/iq/distillation/review?tab=decided', repoInRail: true, record: true },
  { path: '/iq/distillation/review?view=promotions', repoInRail: true },
  { path: '/iq/distillation/knowledge?view=guides', repoInRail: true },
  { path: '/iq/distillation/knowledge?view=patterns', repoInRail: true },
  { path: '/iq/distillation/knowledge?view=notes', repoInRail: true },
  { path: '/iq/distillation/knowledge?item=art-001', repoInRail: true, record: true, editor: true },
  { path: '/iq/distillation/activity?view=runs', repoInRail: true },
  { path: '/iq/designs/des-auth-rotation', repoInRail: false, record: true },
  { param: PARAM_ROUTES.find((r) => r.pattern === '/iq/library/:assetId')!, repoInRail: false, record: true },
];

/** The table rules (docs/layout-cascade.md "Tables", table-rules.spec.ts): every
 *  route whose content is a table of records, walked as each tenant's own
 *  seeded manager so no sign-in needs a tenant switch (a switch bumps the
 *  shared admin's session epoch under every other walker). Enterprise /
 *  Workspace / Prompts / Rules are document explorers and /iq/work/changes a
 *  feed of review cards — rule 1's non-tabular lists, not here. */
export const TABLE_USERS: Readonly<Record<Tenant, string>> = { orgiq: 'u-operator', assessment: 'u-farah', pipelines: 'u-dara', social: 'u-theo', access: 'u-priya' };
export const TABLE_ROUTES: ReadonlyArray<{ tenant: Tenant; path: string; stats?: boolean }> = [
  { tenant: 'social', path: '/social/contacts' },
  { tenant: 'assessment', path: '/assessment/teams', stats: true },
  { tenant: 'assessment', path: '/assessment/submissions', stats: true },
  { tenant: 'assessment', path: '/assessment/reports', stats: true },
  { tenant: 'assessment', path: '/assessment/feedback', stats: true },
  { tenant: 'assessment', path: '/assessment/decks' },
  { tenant: 'assessment', path: '/assessment/runs' },
  { tenant: 'orgiq', path: '/iq/work' },
  { tenant: 'orgiq', path: '/iq/work/queue' },
  { tenant: 'orgiq', path: '/iq/work/findings' },
  { tenant: 'orgiq', path: '/iq/projects?scope=all&view=table' },
  { tenant: 'orgiq', path: '/iq/projects?lens=sprints' },
  { tenant: 'orgiq', path: '/iq/runs' },
  { tenant: 'pipelines', path: '/pipelines/runs' },
  { tenant: 'pipelines', path: '/pipelines/definitions' },
  { tenant: 'pipelines', path: '/pipelines/approvals' },
  { tenant: 'pipelines', path: '/pipelines/artifacts' },
  { tenant: 'pipelines', path: '/pipelines/bots' },
  { tenant: 'pipelines', path: '/pipelines/agents' },
  { tenant: 'pipelines', path: '/pipelines/commands' },
  { tenant: 'pipelines', path: '/pipelines/runbooks' },
  // Access: the lists whose rows the access admin reads in full (her own Requests may be empty).
  { tenant: 'access', path: '/access/catalog' },
  { tenant: 'access', path: '/access/approvals' },
  { tenant: 'access', path: '/access/policies' },
  { tenant: 'access', path: '/access/audit' },
];

/** The chat-rail frame measurements (docs/rail-parity-goal.md decision 6), each as its user.
 *  The bare /iq/communication opens the user's default conversation (a depth-3
 *  record that folds the primary rail by rule 8), so the shallow destinations
 *  carry the frame measurement. */
export const RAIL_CHAT_SETS: Readonly<Record<'rail-social' | 'rail-communication', { user: string; tenant?: Tenant; paths: string[] }>> = {
  'rail-social': { user: 'u-mira', paths: ['/social/channels', '/social/dms', '/social/teams', '/social/rooms', '/social/calls', '/social/recordings'] },
  'rail-communication': { user: 'u-vera', tenant: 'orgiq', paths: ['/iq/communication/calls', '/iq/communication/teams', '/iq/communication/rooms'] },
};

/** Rule 8: which rail gives way. Depth 1–2 keeps both rails open; from three
 *  levels down the primary rail folds to its strip. `deep` is a URL or a
 *  parameterised route resolved at sweep time; `key` is the deep route's inventory key. */
export const DEPTH_PAIRS: ReadonlyArray<{ name: string; tenant: Tenant; shallow: string; deep: string | ParamRoute; key?: string }> = [
  { name: 'initiative / work item', tenant: 'orgiq', shallow: '/iq/projects/p-observability', deep: '/iq/projects/p-observability?scope=all&tab=work&item=wi-obs-e2-b4' },
  { name: 'team / dimension', tenant: 'assessment', shallow: '/assessment/teams/TEAM-001', deep: '/assessment/teams/TEAM-001?dimension=1' },
  { name: 'runs / run', tenant: 'pipelines', shallow: '/pipelines/runs', deep: PARAM_ROUTES.find((r) => r.pattern === '/pipelines/runs/:id')!, key: '/pipelines/runs/:id' },
  { name: 'search / document', tenant: 'orgiq', shallow: '/iq/search', deep: '/iq/documents/page:A100003', key: '/iq/documents/:documentId' },
  // A record open beside a list rail is the selection level.
  { name: 'knowledge / guide', tenant: 'orgiq', shallow: '/iq/distillation/knowledge?view=guides', deep: '/iq/distillation/knowledge?item=art-001', key: '/iq/distillation/knowledge?item=' },
  { name: 'designs / design', tenant: 'orgiq', shallow: '/iq/designs', deep: '/iq/designs/des-auth-rotation', key: '/iq/designs/:id' },
];

/** Routes judged as another user's state (type-scale-sweep.spec.ts): the
 *  Communication plane's no-grant state, and a granted default conversation
 *  that is reported, not judged (its offenders are the library chat surface's). */
export const STATE_ROUTES: ReadonlyArray<{ key: string; user: string; path: string; judged: boolean }> = [
  { key: '/iq/communication · no grant (u-hr)', user: 'u-hr', path: '/iq/communication', judged: true },
  { key: '/pipelines/communication · no grant (u-kofi)', user: 'u-kofi', path: '/pipelines/communication', judged: true },
  { key: '/iq/communication · granted default (u-nora)', user: 'u-nora', path: '/iq/communication', judged: false },
];

// ── Derivations ────────────────────────────────────────────────────────────

let sourcesCache: ReturnType<typeof readRouteSources> | null = null;
const sources = () => (sourcesCache ??= readRouteSources());

/** The shell registry: every concrete path literal in the palette and the rail. */
export function readRegistryPaths(): string[] { return sources().registryPaths; }

/** App.tsx's <Route> patterns (all of them, parameterised included). */
export function appRoutes(): AppRoute[] { return sources().routes; }

const require = createRequire(path.join(REPO_ROOT, 'portal', 'package.json'));
let depthSpec: { prefixes: string[]; drillParams: string[]; leafRoutes: RegExp[] } | null = null;
/** The shell's own rail-depth spec (Layout.tsx SHELL_RAIL_DEPTH), read from source so it cannot drift. */
function shellDepthSpec() {
  if (depthSpec) return depthSpec;
  const src = fs.readFileSync(path.join(REPO_ROOT, 'portal/src/components/shell/Layout.tsx'), 'utf8');
  const block = src.slice(src.indexOf('const SHELL_RAIL_DEPTH'), src.indexOf('};', src.indexOf('const SHELL_RAIL_DEPTH')));
  const strings = (name: string) => [...(block.match(new RegExp(`${name}:\\s*\\[([^\\]]*)\\]`))?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  const leaf = block.slice(block.indexOf('leafRoutes'));
  const leafRoutes = [...leaf.matchAll(/^\s*\/(.+)\/([gimsuy]*),\s*$/gm)].map((m) => new RegExp(m[1]!, m[2]));
  depthSpec = { prefixes: strings('prefixes'), drillParams: strings('drillParams'), leafRoutes };
  return depthSpec;
}
/** The library rail model's depth (`railDepth`) under the shell's spec. */
export function depthOf(url: string): number {
  const u = new URL(url, 'http://x');
  const { railDepth } = require('@connorhoehnslalom/ui-components/shared') as { railDepth: (l: { pathname: string; search?: string }, s: unknown) => number };
  return railDepth({ pathname: u.pathname, search: u.search }, shellDepthSpec());
}

function kindOf(r: InventoryRoute): RouteKind {
  const bare = r.path.split('?')[0]!;
  if (r.source === 'landing') return 'landing';
  if (EXEMPT.some((e) => e.match.test(r.path)) || /\/communication(\/|$)/.test(bare)) return 'chat';
  const list = LIST_PAGES.find((l) => l.path === r.path || (l.param && l.param.pattern === r.pattern));
  if (list) return list.editor ? 'editor' : list.record ? 'record' : 'list';
  if (/\/decks\/[^/]+$/.test(bare)) return 'editor';
  if (TABLE_ROUTES.some((t) => t.path.split('?')[0] === r.path)) return 'list';
  if (r.source === 'param') return 'record';
  return 'page';
}

function judgesOf(r: InventoryRoute): Judge[] {
  const key = r.pattern ?? r.path;
  const out: Judge[] = ['cascade', 'type-scale'];
  if (LIST_PAGES.some((l) => l.path === r.path || (l.param && l.param.pattern === key))) out.push('list-rail');
  if (Object.values(RAIL_CHAT_SETS).some((s) => s.paths.includes(r.path))) out.push('rail-chat');
  if (DEPTH_PAIRS.some((d) => d.shallow === r.path || d.key === key || d.deep === r.path)) out.push('depth');
  if (STATE_ROUTES.some((s) => s.path === r.path)) out.push('state');
  if (TABLE_ROUTES.some((t) => t.path.split('?')[0] === r.path)) out.push('table');
  if (sources().pages.some((p) => p.path === r.path)) out.push('palette');
  return out;
}

function enrich(r: InventoryRoute): InventoryRoute {
  const out: InventoryRoute = { ...r, user: r.user ?? SWEEP_USER };
  out.kind = kindOf(out);
  out.depth = depthOf(r.path);
  out.judges = judgesOf(out);
  return out;
}

/** The static part of the inventory; parameterised routes resolve in the sweep. */
export function staticInventory(): InventoryRoute[] {
  const out: InventoryRoute[] = [];
  const seen = new Set<string>();
  const add = (r: InventoryRoute) => { if (!seen.has(r.path)) { seen.add(r.path); out.push(enrich(r)); } };
  for (const p of sources().registryPaths) add({ tenant: tenantOf(p), path: p, source: 'registry' });
  for (const id of SOCIAL_SURFACE_IDS) add({ tenant: 'social', path: `/social/${id}`, source: 'surface' });
  for (const id of PIPELINES_SURFACE_IDS) add({ tenant: 'pipelines', path: `/pipelines/${id}`, source: 'surface' });
  for (const [tenant, p] of LANDINGS) add({ tenant, path: p, source: 'landing' });
  return out;
}

/** The parameterised routes as inventory rows, `:id` filled with the fixture id or fallback (no API). */
export function paramInventory(): InventoryRoute[] {
  return PARAM_ROUTES.map((r) => enrich({ tenant: r.tenant, path: r.template.replace(':id', encodeURIComponent(r.id ?? r.fallback ?? 'missing')), source: 'param', pattern: r.pattern }));
}

/** Resolve a parameterised route against the API (a sweep's request context). */
export async function resolveParam(r: ParamRoute, get: (url: string) => Promise<unknown>): Promise<string> {
  let id = r.id;
  if (!id && r.resolve) id = r.resolve.pick(await get(r.resolve.url).catch(() => null));
  return r.template.replace(':id', encodeURIComponent(id ?? r.fallback ?? 'missing'));
}

export function exemptions(route: string): Set<Invariant> {
  const out = new Set<Invariant>();
  for (const e of EXEMPT) if (e.match.test(route)) for (const i of e.invariants) out.add(i);
  return out;
}

/**
 * The inventory key a URL is judged under — the key the sweeps record their
 * measurements by (a parameterised route's pattern, else the static path) —
 * or null when no inventoried route renders it. A walk's `url:` resolves
 * through here (docs/journeys.md).
 */
export function routeKey(url: string): string | null {
  const clean = url.trim().replace(/#.*$/, '').replace(/[…).,;]+$/, '');
  if (!/^\/(iq|assessment|social|pipelines|access|admin|settings)(\/|\?|$)/.test(clean)) return null;
  const u = new URL(clean, 'http://x');
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  const inv = staticInventory();
  // A parameterised route keyed by a query param (`/iq/distillation/knowledge?item=`).
  for (const r of PARAM_ROUTES) {
    const [tp, tq] = r.template.split('?');
    if (!tq) continue;
    const [param, value] = tq.split('=');
    const tpRe = new RegExp(`^${tp!.replace(/:id/g, '[^/]+').replace(/\/p-auth-migration/, '/[^/]+')}$`);
    if (!tpRe.test(pathname) || !u.searchParams.has(param!)) continue;
    if (value === ':id' || u.searchParams.get(param!) === value) {
      // `?view=notes` / `?view=graph` key only that exact view.
      if (value !== ':id' && !r.pattern.endsWith(`=${u.searchParams.get(param!)}`)) continue;
      return r.pattern;
    }
  }
  const exact = inv.find((r) => r.path === `${pathname}${u.search}`) ?? inv.find((r) => r.path === pathname);
  if (exact) return exact.path;
  // A concrete URL under a parameterised App.tsx route.
  for (const r of [...PARAM_ROUTES, ...OBSERVED_ROUTES]) {
    const tp = r.template.split('?')[0]!;
    if (r.template.includes('?')) continue;
    if (new RegExp(`^${tp.replace(':id', '[^/]+')}$`).test(pathname)) return r.pattern;
  }
  for (const a of appRoutes()) {
    // The catch-all is the not-found page, not a route a URL belongs to.
    if (!/[:*]/.test(a.path) || a.path === '/*' || a.path === '*') continue;
    const re = new RegExp(`^${a.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/]+').replace(/\\\*|\*/g, '.*')}$`);
    if (re.test(pathname)) return a.path;
  }
  // A concrete App.tsx route that is not in the sweep inventory is still a page.
  if (appRoutes().some((a) => a.path === pathname)) return pathname;
  return null;
}

/** Every URL-looking token in a piece of journey-log text (the fields are free text). */
export function urlsOf(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s(,:→=`'"])(\/(?:iq|assessment|social|pipelines|access|admin|settings)(?:[/?][^\s,)`'"→]*)?)/g)].map((m) => m[1]!);
}

// ── Spec coverage: which specs assert something about which route ─────────

/** The per-route sweeps measure every route; their output is the measurement, not an assertion list. */
export const SWEEP_SPECS = ['layout-cascade.spec.ts', 'type-scale-sweep.spec.ts'];
const E2E = path.join(REPO_ROOT, 'portal', 'e2e');

/** Route key -> the spec files (basename) that name one of its URLs. */
export function specCoverage(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of fs.readdirSync(E2E).filter((n) => n.endsWith('.spec.ts') && !SWEEP_SPECS.includes(n)).sort()) {
    const src = fs.readFileSync(path.join(E2E, f), 'utf8');
    const urls = new Set<string>();
    for (const m of src.matchAll(/(['"`])(\/(?:iq|assessment|social|pipelines|access|admin)(?:[/?][^'"`\s]*)?)\1/g)) urls.add(m[2]!);
    for (const m of src.matchAll(/`(\/(?:iq|assessment|social|pipelines|access|admin)[^`]*)`/g)) urls.add(m[1]!.replace(/\$\{[^}]*\}/g, 'x'));
    for (const u of urls) {
      const k = routeKey(u);
      if (k) (out[k] ??= []).includes(f) || out[k]!.push(f);
    }
  }
  return out;
}

/**
 * The assertions a spec makes, normalised: every `expect(…)` statement inside
 * a `test(…)` body, whitespace collapsed. Helper functions (sign-in, opening a
 * page) are not assertions about a route, so moving them does not move this.
 */
export function specAssertions(file: string): string[] {
  const src = fs.readFileSync(path.join(E2E, file), 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/\btest(?:\.(?:only|skip|fixme))?\(\s*(['"`])((?:(?!\1).)*)\1/g)) {
    // The test body: from its title to the next top-level `test(` / `test.describe(` or the end.
    const start = m.index!;
    const next = src.slice(start + m[0].length).search(/\n(?:test|test\.describe)\(/);
    const body = src.slice(start, next < 0 ? undefined : start + m[0].length + next);
    out.push(`test ${m[2]}`);
    for (const e of body.matchAll(/expect(?:\.poll|\.soft)?\(([^;]*?)\)\s*(?:\.not)?\.(to[A-Za-z]+)\(([^;]*?)\);/gs)) out.push(`${e[1]!.replace(/\s+/g, ' ').trim()} .${e[2]}(${e[3]!.replace(/\s+/g, ' ').trim()})`);
  }
  return out;
}

// ── The measurement digest ─────────────────────────────────────────────────

/** What a contract measurement is taken against: every rendered source under
 *  portal/src (tests excluded) and the portal's dependency pins. */
export function sourceDigest(): string {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); }
      else if (!/\.(test|spec)\.[tj]sx?$/.test(e.name)) files.push(p);
    }
  })(path.join(REPO_ROOT, 'portal', 'src'));
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of [...files, path.join(REPO_ROOT, 'portal', 'package.json')]) {
    h.update(path.relative(REPO_ROOT, f)); h.update('\0'); h.update(fs.readFileSync(f)); h.update('\0');
  }
  return h.digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const print = (v: unknown) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);
  if (cmd === 'routes') print([...staticInventory(), ...paramInventory()]);
  else if (cmd === 'key') print(args.map((u) => `${u}\t${routeKey(u) ?? ''}`).join('\n'));
  else if (cmd === 'coverage') print(specCoverage());
  else if (cmd === 'source-digest') print(sourceDigest());
  else if (cmd === 'subjects') {
    const set = args[0] ?? '';
    if (set === 'list-rail') {
      // The library asset id is minted per process; ask the BFF, as the sweep does.
      const api = (args[1] ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
      const out: string[] = [];
      for (const l of LIST_PAGES) {
        if (l.path) { out.push(l.path); continue; }
        out.push(await resolveParam(l.param!, async (u) => (await fetch(api + u)).json()));
      }
      print(out.join(','));
    } else if (set in RAIL_CHAT_SETS) {
      const s = RAIL_CHAT_SETS[set as keyof typeof RAIL_CHAT_SETS];
      print(`${s.paths.join(',')}\t${s.user}\t${s.tenant ?? ''}`);
    } else { process.stderr.write(`unknown subject set: ${set}\n`); process.exit(2); }
  } else { process.stderr.write('usage: route-inventory.ts routes | key <url>… | coverage | source-digest | subjects <list-rail|rail-social|rail-communication> [api]\n'); process.exit(2); }
}
