// Record what the server actually sends. Regenerates the committed snapshots.
//
//   cd middleware && npm run dev:mock          # in one terminal
//   cd middleware && npx tsx src/mock/core/wire/capture.ts
//
// It enumerates every route from the routers (`routes.ts`), signs in as each
// persona below, GETs everything it can reach, and writes the KEY PATHS — never
// the values — to `snapshots/`. Values are recorded only for the wire-shaped
// fields in `shape.ts`'s `WIRE_FIELDS`, because those are the strings a fixture
// invents.
//
// This file is the GET sweep. The WRITE sweep lives in `capture-writes.ts`
// and runs straight after it from `main()` below, against the same server —
// its policy (which writes are replayed at all, and why) is `write-policy.ts`.
// GET runs first, deliberately: a write replay mutates the world, and the GET
// shapes must come from the untouched one.
//
// PERSONAS ARE SWEPT ONE AT A TIME, not interleaved per route, and each signs
// in immediately before its own pass. Switching tenant bumps
// `app_users.session_epoch`, and the grants refresh (GRANTS_REFRESH_S, 120s)
// drops any cookie below the stored epoch — so a second persona's sign-in kills
// the first one's cookie about two minutes later. Interleaved, a full sweep
// takes longer than that and silently degrades to anonymous halfway through,
// writing "HTTP 403" against most of the surface. One persona per pass keeps
// every cookie current for the whole of its own sweep.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { captureWrites, writeWritesSnapshot } from './capture-writes.js';
import { BASE, PERSONAS, get, login, resolvePath, type Fetched, type Persona } from './http.js';
import { snapshotDir, ROUTES_SNAPSHOT, WIRE_SNAPSHOT } from './paths.js';
import { enumerateRoutes, routeKey, type RouteRecord } from './routes.js';
import { describe, fieldName, sortShape, type ShapeResult } from './shape.js';

/**
 * Query strings a route needs before it will answer at all. A capture aid, not
 * a route list — the route table itself is enumerated, and a route that 400s
 * for want of a parameter is reported as `skipped` so the gap stays visible.
 */
const QUERY_HINTS: Record<string, string> = {
  'GET /api/assessment/knowledge/doc': 'id=ec%3Astandards%2Fci-cd-standards.md',
  'GET /api/assessment/knowledge/doc/versions': 'id=ec%3Astandards%2Fci-cd-standards.md',
  // Use the populated thread so root/reply fields are actually witnessed.
  'GET /api/assessment/knowledge/doc/comments': 'id=prompt%3Aclassify-transcript.md',
  'GET /api/assessment/knowledge/doc/reactions': 'id=ec%3Astandards%2Fci-cd-standards.md',
  // Rubric Overview carries the seeded legacy thread, so the capture witnesses
  // the one-time import's rows (scope, parentCommentId, importedFrom) and its
  // `import` status in platform-api's comment shape.
  'GET /api/assessment/knowledge/doc/workflows/comments': 'id=page%3A100002',
  'GET /api/graph/help': 'q=auth',
  'GET /api/scores/by-skill': 'skill=Kubernetes',
  'GET /api/scores/radar': 'personId=p-001',
  // The route requires a sprint and 400s without one — `scope=all` was a
  // hint for a shape it never had. spr-auth-s2 is the two-grant sprint, so
  // the capture sees a list, not a single row.
  'GET /api/grants': 'sprintId=spr-auth-s2',
  // The seeded binding (mock/social-bindings.ts), so the capture witnesses a
  // bound context rather than `binding: null`.
  'GET /api/social/bindings': 'context=initiative%3Ap-auth-migration',
};

interface Capture {
  persona?: string;
  status?: number;
  shape?: Record<string, string>;
  /**
   * Wire-shaped string values, keyed by the PATH they sat at in THIS response
   * (`sections[].key` -> ['enterprise_context', ...]). Per route, because a
   * cross-route union of every `status` in the API is not a fact about any one
   * response — see shape.ts.
   */
  values?: Record<string, string[]>;
  /** Why nothing was captured. Present iff `shape` is absent. */
  skipped?: string;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface WireSnapshot {
  capturedAt: string;
  /**
   * The digest of the handler sources the SERVER booted from, as it reports
   * them. This is what makes freshness a content question: a sweep run against
   * a process started before an edit records the old digest, and the validator
   * catches it however new the snapshot FILE is. `null` when the server does
   * not report one (an older build, or a non-mock process).
   */
  serverHandlerSha: string | null;
  baseUrl: string;
  personas: string[];
  routes: Record<string, Capture>;
  vocabulary: Record<string, { open: boolean; values: string[] }>;
}

/** Above this many distinct values a field is an open set, not an enum. */
const MAX_ENUM = 120;

export async function capture(log: (s: string) => void = () => {}): Promise<WireSnapshot> {
  const table = enumerateRoutes();
  const gets = table.routes.filter((r: RouteRecord) => r.method === 'GET');

  const merged: ShapeResult = { shape: {}, values: new Map() };
  const captures = new Map<string, Capture>();
  const reasons = new Map<string, string[]>();
  const paramCache = new Map<string, string | null>();
  const personaNames: string[] = [];
  const note = (key: string, msg: string): void => {
    const list = reasons.get(key);
    if (list) list.push(msg);
    else reasons.set(key, [msg]);
  };

  for (const spec of PERSONAS) {
    const persona = await login(spec);
    personaNames.push(persona.name);
    let hits = 0;
    for (const route of gets) {
      const key = routeKey(route);
      if (captures.has(key)) continue;

      const resolved = await resolvePath(route.path, persona, paramCache);
      if ('skipped' in resolved) {
        note(key, `${resolved.skipped} (${persona.name})`);
        continue;
      }
      const hint = QUERY_HINTS[key];
      const url = `${BASE}${resolved.path}${hint ? `?${hint}` : ''}`;
      let res: Fetched;
      try {
        res = await get(url, persona);
      } catch (err) {
        const why = (err as Error).name === 'AbortError' ? 'timed out after 6s — never sent response headers' : (err as Error).message;
        note(key, `${why} (${persona.name})`);
        continue;
      }
      if (res.status !== 200 || res.body === undefined) {
        const why = res.note || `HTTP ${res.status}`;
        note(key, `${why} (${persona.name})`);
        continue;
      }
      describe(res.body, merged);
      const one = describe(res.body);
      const values: Record<string, string[]> = {};
      for (const path of [...one.values.keys()].sort()) {
        const seen = [...one.values.get(path)!].sort();
        // An open set proves nothing, and 120 ids in a snapshot is not a shape.
        if (seen.length <= MAX_ENUM) values[path] = seen;
      }
      captures.set(key, {
        persona: persona.name,
        status: res.status,
        shape: sortShape(one.shape),
        values,
      });
      hits += 1;
    }
    log(`  ${persona.name}: captured ${hits} route(s)`);
  }

  const routes: Record<string, Capture> = {};
  for (const route of gets) {
    const key = routeKey(route);
    routes[key] = captures.get(key) ?? { skipped: (reasons.get(key) ?? ['unreachable']).join('; ') };
  }

  // A by-field-name roll-up, for a human reading the snapshot. The CHECK never
  // uses it — it uses the per-route `values` above — because the roll-up mixes
  // routes and would call a correct value invented.
  const byField = new Map<string, Set<string>>();
  for (const [path, set] of merged.values) {
    const field = fieldName(path);
    const into = byField.get(field) ?? new Set<string>();
    for (const v of set) into.add(v);
    byField.set(field, into);
  }
  const vocabulary: WireSnapshot['vocabulary'] = {};
  for (const field of [...byField.keys()].sort()) {
    const values = [...byField.get(field)!].sort();
    vocabulary[field] = values.length > MAX_ENUM ? { open: true, values: [] } : { open: false, values };
  }

  return {
    capturedAt: new Date().toISOString(),
    serverHandlerSha: await serverHandlerSha(),
    baseUrl: BASE,
    personas: personaNames,
    routes: Object.fromEntries(Object.keys(routes).sort().map((k) => [k, routes[k]!])),
    vocabulary,
  };
}

/** Ask the running server which sources it booted from. */
async function serverHandlerSha(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/api/__mock/state`);
    if (!res.ok) return null;
    const body = (await res.json()) as { handlerSha?: unknown };
    return typeof body.handlerSha === 'string' && body.handlerSha ? body.handlerSha : null;
  } catch {
    return null;
  }
}

export async function main(): Promise<void> {
  const dir = snapshotDir();
  mkdirSync(dir, { recursive: true });

  const table = enumerateRoutes();
  writeFileSync(
    join(dir, ROUTES_SNAPSHOT),
    `${JSON.stringify({ routes: table.routes, unresolved: table.unresolved }, null, 2)}\n`,
  );
  console.log(`wire: ${table.routes.length} routes enumerated from src/index.ts`);

  const wire = await capture((s) => console.log(s));
  writeFileSync(join(dir, WIRE_SNAPSHOT), `${JSON.stringify(wire, null, 2)}\n`);

  const total = Object.keys(wire.routes).length;
  const captured = Object.values(wire.routes).filter((c) => c.shape).length;
  console.log(`wire: ${captured}/${total} GET routes captured from ${BASE}`);
  console.log(`wire: ${Object.keys(wire.vocabulary).length} wire-field vocabularies`);
  for (const [k, c] of Object.entries(wire.routes)) {
    if (!c.shape) console.log(`  uncaptured  ${k}  — ${c.skipped}`);
  }

  // The write sweep, LAST — it mutates the world the GET sweep just read.
  // Its snapshot is a separate file so a stale one is visibly stale on its own
  // and so rule 4's GET half never mistakes a refused write for a broken GET.
  const writes = await captureWrites((s) => console.log(s));
  writeWritesSnapshot(writes);
}

// `npx tsx src/mock/core/wire/capture.ts`
if (process.argv[1]?.endsWith('capture.ts')) {
  main().catch((err: unknown) => {
    console.error(`wire capture failed: ${(err as Error).message}`);
    console.error(`Is dev:mock running on ${BASE}?  cd middleware && npm run dev:mock`);
    process.exit(1);
  });
}
