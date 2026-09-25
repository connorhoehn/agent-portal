// The bits of the capture that are about talking to a running dev:mock server,
// rather than about what is captured: the personas, the cookie jar, and the
// trick of filling a `:param` from the collection that owns it.
//
// This module was factored out of `capture.ts` when the capture stopped being
// GET-only. The GET sweep and the write replay have to sign in the same way,
// resolve `:id` the same way, and honour the same base URL — and two copies of
// the cookie-jar rule below is exactly the kind of near-duplicate that drifts
// until one of them is subtly wrong.

import { pathParams } from './routes.js';
import { type Json } from './shape.js';

export { pathParams };

export const BASE = process.env['WIRE_BASE_URL'] ?? 'http://127.0.0.1:3011';

/**
 * Who we sign in as. `u-operator` holds `admin` in both tenants, and `admin`
 * is the only cross-tenant wildcard role, so two sessions reach the whole
 * surface. `anonymous` runs last and only picks up what the other two could
 * not — the machine-callback routes that take no session.
 */
export const PERSONAS = [
  { name: 'orgiq/admin', userId: 'u-operator', tenant: 'orgiq', role: 'admin' },
  { name: 'assessment/admin', userId: 'u-operator', tenant: 'assessment', role: 'admin' },
  { name: 'anonymous', userId: null, tenant: null, role: null },
] as const;

export type PersonaSpec = (typeof PERSONAS)[number];
export type PersonaName = PersonaSpec['name'];

export interface Persona {
  name: string;
  cookie: string;
}

/**
 * A cookie jar, because `POST /login` sends TWO Set-Cookie headers for the same
 * name: it clears any prior identity's cookie before minting the new one
 * (defense in depth, `routes/session.ts`). Concatenating both produces
 * `orgiq.session=; orgiq.session=<jwt>` and cookie-parser takes the FIRST — an
 * empty session. That single detail is why an earlier version of this script
 * captured only the ungated third of the surface and wrote "HTTP 403" against
 * the rest, which would have baked a two-thirds-empty snapshot into the repo.
 * Last non-empty value per name wins.
 */
export function absorb(jar: Map<string, string>, res: Response): void {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}

export const cookieHeader = (jar: Map<string, string>): string =>
  [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

export async function post(path: string, body: unknown, jar: Map<string, string>): Promise<Response> {
  const cookie = cookieHeader(jar);
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  absorb(jar, res);
  return res;
}

/**
 * Sign in, then switch tenant if needed — `POST /login` mints the user's
 * DEFAULT tenant and ignores a tenant in its body, so asking for the
 * assessment persona without the switch silently hands back an orgiq session.
 */
export async function login(p: PersonaSpec): Promise<Persona> {
  if (p.userId === null) return { name: p.name, cookie: '' };
  const jar = new Map<string, string>();
  const res = await post('/api/session/login', { userId: p.userId }, jar);
  if (!res.ok) throw new Error(`login as ${p.name} failed: ${res.status} ${await res.text()}`);
  const me = (await res.json()) as { tenant?: string; role?: string };
  if (p.tenant && me.tenant !== p.tenant) {
    const sw = await post('/api/session/tenant', { tenant: p.tenant, role: p.role }, jar);
    if (!sw.ok) throw new Error(`switch to ${p.tenant} failed: ${sw.status} ${await sw.text()}`);
  }
  const cookie = cookieHeader(jar);
  if (!cookie) throw new Error(`login as ${p.name} returned no cookie`);
  return { name: p.name, cookie };
}

export interface Fetched {
  status: number;
  body: Json | undefined;
  note: string;
}

/**
 * One request. An SSE route is detected by its content-type and abandoned
 * without reading the body — reading it would hang until the timeout, and there
 * is no "shape" of a stream that belongs in a snapshot anyway.
 */
export async function send(
  url: string,
  persona: Persona,
  init: { method?: string; body?: unknown; timeoutMs?: number; headers?: Readonly<Record<string, string>> } = {},
): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 6_000);
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(persona.cookie ? { cookie: persona.cookie } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        // Last, so a spec's own header wins: the machine-callback routes in
        // this app authenticate with a bearer token INSTEAD of a session, and
        // a persona cookie must never be able to shadow it.
        ...(init.headers ?? {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      await res.body?.cancel();
      return { status: res.status, body: undefined, note: 'server-sent event stream' };
    }
    if (!contentType.includes('application/json')) {
      await res.body?.cancel();
      return { status: res.status, body: undefined, note: `non-JSON (${contentType || 'no content-type'})` };
    }
    return { status: res.status, body: (await res.json()) as Json, note: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** One GET. */
export function get(url: string, persona: Persona): Promise<Fetched> {
  return send(url, persona);
}

// ---------------------------------------------------------------------------
// Param resolution — find a real id rather than inventing one
// ---------------------------------------------------------------------------

/**
 * Where to find a real value for a `:param` when the route's own literal
 * prefix is not itself a collection. An aid, not a route list: anything
 * unresolved is reported rather than skipped silently, and the values still
 * come from the server — never typed here.
 *
 * The key is `<param>@<prefix>`, where `<prefix>` is either the FILLED prefix
 * (`/api/assessment/teams`) or the TEMPLATED one, params still spelled
 * (`/api/assessment/teams/:id/exceptions`). The templated form is what a
 * second param needs: by the time `:dimensionId` is resolved the prefix in
 * front of it already carries a real team id, so it is a different string on
 * every server and cannot be a key.
 *
 * The value is `<path>` or `<path>#<field>` — `#field` names the field to read
 * when the collection spells the id something other than the param does
 * (`tasks[].task_id` for `:taskId`). A path of `.` means "GET the filled prefix
 * itself" and `^` means "GET its parent", which is how a nested collection is
 * read once its parent id is known.
 *
 * A `#field` containing a dot or a `[]` is a KEY PATH into the response —
 * `#deniedTopics[].name` — resolved exactly, top down, instead of by the
 * fuzzy search `firstIdIn` does. That distinction is load-bearing rather than
 * cosmetic: `firstIdIn` tries the param name and then `id`/`key`/`slug`/`name`
 * on every object it walks, so on `GET /api/capabilities/guardrail` it returns
 * the GUARDRAIL's own `name` (`orgiq-guardrail`) and `PATCH
 * /guardrail/topics/:name` 404s against a topic that does not exist. The same
 * shadowing hides `presence.sessions[].sessionId` behind the node's `id`.
 * Where a fuzzy match is ambiguous, name the path and the ambiguity is gone.
 */
export const PARAM_SOURCES: Record<string, string> = {
  'personId@/api/graph/people': '/api/scores/leaderboard#personId',
  'personId@/api/scores': '/api/scores/leaderboard#personId',
  'agentId@/api/agent-detail': '/api/agents#id',
  'id@/api/graph/decisions': '/api/graph/decisions',
  'id@/api/ingest/crawl': '/api/ingest/crawls',
  'jobId@/api/ingest/job': '/api/ingest/jobs',
  'id@/api/ingest/survey': '/api/ingest/surveys',
  'assetId@/api/library/evals': '/api/library',
  'libraryItemId@/api/distillation/library': '/api/library',
  'id@/api/observability/harness/runs': '/api/observability/harness/runs#runId',
  'invocationId@/api/observability/invocations': '/api/observability/recent-invocations#invocationId',
  'invocationId@/api/observability/drift/neighbors': '/api/observability/recent-invocations#invocationId',
  // Write-only prefixes: a `:id` under a path with no collection of its own,
  // or a collection that spells the id differently from the param.
  'id@/api/sdlc/changes': '/api/sdlc/changes#id',
  // `/api/agent-projects/runs` is a write-only prefix — there is no collection
  // there, and `pluralCandidate` gives up on a word that already ends in `s`.
  // The runs ride along on the project list instead, so a key path is the only
  // way in; `[]` skips the repositories that have no runs rather than stopping
  // at the first one.
  'runId@/api/agent-projects/runs': '/api/agent-projects#projects[].runs[].id',
  'id@/api/designs': '/api/designs#id',
  'id@/api/lab/consults': '/api/lab/consults#id',
  'id@/api/work/findings': '/api/work/findings?sweep=stale_docs#id',
  'id@/api/work/jobs': '/api/work/jobs?status=awaiting_review#id',
  'id@/api/work/proposals': '/api/work/proposals#id',
  // The status filter is the point: promote and dismiss both refuse a terminal
  // candidate, so an unfiltered read that happened to list the seeded
  // `promoted` one first would capture a 409 instead of the write. The server
  // does the filtering — `GET /api/promotions?status=` — so this is still a
  // real id off a real response, not a hand-picked one.
  'id@/api/promotions': '/api/promotions?status=candidate#id',
  'id@/api/graph/work-items': '/api/graph/work#id',
  // Key paths, not fuzzy searches — see the note above on why each of these
  // two resolves to the wrong string without one.
  'name@/api/capabilities/guardrail/topics': '/api/capabilities/guardrail#deniedTopics[].name',
  'sessionId@/api/local-compute/sessions': '/api/local-compute/nodes#nodes[].presence.sessions[].sessionId',
  // `GET /api/work/jobs` carries no auth guard at all (routes/work.ts), so the
  // `anonymous` persona these local-compute machine-callback writes replay as
  // can read it — and `agent_jobs` is the ONE table both surfaces share
  // (mock/agent-jobs.ts backs both `/api/work/jobs` and
  // `/api/local-compute/jobs/:jobId/*`), so a real, live id is available here
  // even though this node holds no claim on it. The specs below all bail out
  // via `unsynthesisable` before that ownership gap matters — see their
  // `safe`/`build` in write-policy.ts — but a resolvable `:jobId` is what lets
  // them reach `build` at all instead of failing earlier, at path resolution,
  // for a less exact reason.
  'jobId@/api/local-compute/jobs': '/api/work/jobs#id',
  'id@/api/distillation/review': '/api/distillation/review?verdict=pending#id',
  // Unfiltered, the collection's default sort (most-recently-updated first)
  // hands back a published artifact — publish would then 409. Filtering to
  // draft the same way `/promotions?status=candidate` does above keeps this
  // capture on the 200 branch.
  'id@/api/distillation/artifacts': '/api/distillation/artifacts?status=draft#id',
  'id@/api/observability/calibration/cases': '/api/observability/calibration/cases#calibrationId',
  'id@/api/observability/harness/cases': '/api/observability/harness/cases#testId',
  'id@/api/observability/approvals': '/api/observability/approvals#approvalId',
  'id@/api/identity/policies': '/api/identity/policies#policyId',
  'id@/api/grants': '/api/budgets/grants#id',
  'id@/api/assessment/teams': '/api/assessment/teams#id',
  'orgProjectId@/api/budgets': '/api/budgets#orgProjectId',
  'sprintId@/api/sprints': '/api/sprints#id',
  'taskId@/api/assessment/feedback': '/api/assessment/feedback#task_id',
  'runId@/api/assessment/runs': '/api/assessment/runs?status=running#id',
  'team@/api/assessment/submissions': '/api/assessment/submissions#team_id',
  // Templated prefixes — the string in front of a SECOND param carries a real
  // id by the time it is resolved, so only the templated form is a stable key.
  'dimensionId@/api/assessment/teams/:id/exceptions': '.#dimension_id',
  'envelope@/api/assessment/submissions/:team': '/api/assessment/submissions#envelope_id',
  'personId@/api/graph/projects/:id/contributors': '^#personId',
};

/**
 * Params whose value is a JOIN, not a lookup: the right id depends on a field
 * of an id already resolved earlier in the same path, which no single GET of a
 * `PARAM_SOURCES` path can express. Keyed by the templated form, like the
 * second-param entries above. Each reads the server and returns null when the
 * world offers no suitable row — that is reported as a skip, never guessed.
 */
type ParamResolver = (ctx: {
  values: Record<string, string>;
  read: (path: string) => Promise<Json | null>;
}) => Promise<string | null>;

const objectRows = (body: Json | null): { [k: string]: Json }[] =>
  Array.isArray(body)
    ? body.filter((v): v is { [k: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v))
    : [];

export const PARAM_RESOLVERS: Record<string, ParamResolver> = {
  // A decision links only to work on its OWN initiative, and never away from
  // another item (`decideDecisionLink`). The first decision on the board would
  // usually belong to some other initiative and pin nothing but the 409, so
  // read the item's initiative off the board, then take a decision on that
  // initiative that is unlinked or already linked to this very item.
  'decisionId@/api/graph/work-items/:id/decisions': async ({ values, read }) => {
    const itemId = values['id'];
    const item = objectRows(await read('/api/graph/work')).find((w) => w['id'] === itemId);
    const projectId = item?.['projectId'];
    if (typeof projectId !== 'string' || projectId.length === 0) return null;
    const decisions = objectRows(await read(`/api/graph/projects/${encodeURIComponent(projectId)}/decisions`));
    const free = decisions.find((d) => d['workItemId'] === null || d['workItemId'] === itemId);
    return typeof free?.['id'] === 'string' ? free['id'] : null;
  },
};

/** Keys an element of a collection might carry its identifier under. */
const ID_KEYS = ['id', 'key', 'slug', 'name'];

/** The first plausible value for `param` anywhere in a response body. */
export function firstIdIn(body: Json, param: string): string | null {
  const wanted = [param, param.replace(/Id$/, ''), ...ID_KEYS];
  const seen = new Set<Json>();
  const search = (v: Json, depth: number): string | null => {
    if (depth > 4 || v === null || typeof v !== 'object') return null;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = search(item, depth + 1);
        if (hit !== null) return hit;
      }
      return null;
    }
    for (const k of wanted) {
      const cand = v[k];
      if (typeof cand === 'string' && cand.length > 0 && !cand.includes('/')) return cand;
    }
    for (const child of Object.values(v)) {
      const hit = search(child, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  return search(body, 0);
}

/** Does this `#field` name a key path rather than a bare field name? */
export function isKeyPath(field: string): boolean {
  return field.includes('.') || field.includes('[]');
}

/**
 * The first non-empty string at an exact key path — `deniedTopics[].name`,
 * `nodes[].presence.sessions[].sessionId`. `[]` descends into an array and
 * takes the first element that yields a value, so a path still resolves when
 * the first row happens to carry an empty collection (the offline node whose
 * sessions are hidden is exactly that case).
 *
 * Unlike `firstIdIn` this NEVER falls back to another field: a caller that
 * spelled a path asked for that path, and a silent fallback to `id` is how a
 * `:name` gets filled with a guardrail's name instead of a topic's.
 */
export function firstAtPath(body: Json, path: string): string | null {
  const segments = path.split('.');
  const walk = (v: Json, i: number): string | null => {
    if (i === segments.length) return typeof v === 'string' && v.length > 0 ? v : null;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const seg = segments[i]!;
    const intoArray = seg.endsWith('[]');
    const next = (v as { [k: string]: Json })[intoArray ? seg.slice(0, -2) : seg];
    if (next === undefined) return null;
    if (!intoArray) return walk(next, i + 1);
    if (!Array.isArray(next)) return null;
    for (const item of next) {
      const hit = walk(item, i + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(body, 0);
}

/** `/api/ingest/crawl` -> `/api/ingest/crawls`: the collection beside the item. */
export function pluralCandidate(prefix: string): string | null {
  const m = /^(.*\/)([A-Za-z-]+)$/.exec(prefix);
  if (!m) return null;
  const word = m[2]!;
  if (word.endsWith('s')) return null;
  return `${m[1]}${word}${word.endsWith('y') ? '' : 's'}`;
}

/**
 * Fill `:param`s from the collection that owns them: for
 * `/api/assessment/teams/:id/evidence`, GET `/api/assessment/teams` and take
 * the first id it lists. That beats a table of hand-typed ids — the ids come
 * from the same server the shapes do, so they cannot go stale on their own.
 */
export async function resolvePath(
  path: string,
  persona: Persona,
  cache: Map<string, string | null>,
): Promise<{ path: string } | { skipped: string }> {
  let filled = path;
  const values: Record<string, string> = {};
  for (const param of pathParams(path)) {
    const prefix = filled.slice(0, filled.indexOf(`:${param}`)).replace(/\/$/, '');
    if (prefix.includes(':')) return { skipped: `nested param before :${param}` };
    // The same prefix with earlier params still spelled — a stable key.
    const template = path.slice(0, path.indexOf(`:${param}`)).replace(/\/$/, '');
    const cacheKey = `${persona.name} ${prefix} ${param}`;
    let value = cache.get(cacheKey);
    const resolver = PARAM_RESOLVERS[`${param}@${template}`];
    if (value === undefined && resolver) {
      value = await resolver({
        values,
        read: async (p) => {
          const res = await get(`${BASE}${p}`, persona).catch(() => null);
          return res && res.status === 200 && res.body !== undefined ? res.body : null;
        },
      });
      cache.set(cacheKey, value);
    }
    if (value === undefined) {
      const sources = [
        PARAM_SOURCES[`${param}@${prefix}`],
        PARAM_SOURCES[`${param}@${template}`],
        prefix,
        pluralCandidate(prefix),
      ].filter((s): s is string => typeof s === 'string');
      value = null;
      for (const source of sources) {
        const [rawPath, field] = source.split('#') as [string, string | undefined];
        // `.` is the filled prefix — how a nested collection is read once its
        // parent id is known; `^` is that prefix's parent, for a param whose
        // own collection has no GET but its owner's detail route lists it.
        const sourcePath =
          rawPath === '.' ? prefix
          : rawPath === '^' ? prefix.replace(/\/[^/]+$/, '')
          : rawPath;
        const res = await get(`${BASE}${sourcePath}`, persona).catch(() => null);
        if (res && res.status === 200 && res.body !== undefined) {
          value = field !== undefined && isKeyPath(field)
            ? firstAtPath(res.body, field)
            : firstIdIn(res.body, field ?? param);
          if (value !== null) break;
        }
      }
      cache.set(cacheKey, value);
    }
    if (value === null) return { skipped: `no value found for :${param} under ${prefix}` };
    values[param] = value;
    filled = filled.replace(`:${param}`, encodeURIComponent(value));
  }
  return { path: filled };
}
