// Record what the server actually sends back from a WRITE.
//
//   cd middleware && npx tsx src/mock/core/wire/capture-writes.ts
//   (or `capture.ts`, which runs the GET sweep and then this one.)
//
// The GET sweep proves a fixture against a response the server can be asked for
// as often as you like. A write response cannot be asked for that way: it only
// exists after an act. So this replays the writes `write-policy.ts` allows —
// and ONLY those — against a scenario-reset server, and snapshots the shapes
// that come back. Everything it refuses, and everything whose body it could not
// build, is written into the snapshot with the reason, because a gap that is
// printed is a gap somebody can close.
//
// TWO SAFETY PROPERTIES, both of which the policy leans on:
//
//   * `POST /api/__mock/reset` runs immediately BEFORE every replay, so no
//     shape is ever captured against a world an earlier write left behind, and
//     a run that dies halfway leaves the last reset's world rather than a
//     half-applied one. The final reset runs in a `finally`.
//   * Nothing here invents a value. A body is built from literals the
//     handler's own validation spells and from rows the server just handed
//     back (`BodyContext`), which is the same rule the fixtures themselves are
//     held to — a harness that made up its request bodies would be checking
//     fiction against fiction.
//
// AND ONE PRECONDITION, read before anything is replayed. Several specs are
// safe only because the process being captured binds a mock provider in place
// of a real one — `mockAgentCore` instead of a Browser session, `mockGuardrails`
// instead of a Bedrock guardrail, the local-compute fixtures instead of the RDS
// Data API. Whether that is true is a fact about the SERVER, and this script
// can be pointed at any server with `WIRE_BASE_URL`, so it is asked rather than
// assumed: `GET /api/health` reports `mocks`, and a spec's `intercepts` list is
// checked against it. An unreadable or shapeless `/api/health` is FATAL here,
// not a shrug — with no answer, every interception-dependent spec would be
// refused and the run would quietly produce a snapshot that looks like a policy
// decision instead of a broken connection.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BASE,
  PERSONAS,
  firstIdIn,
  get,
  login,
  resolvePath,
  send,
  type Persona,
  type PersonaName,
} from './http.js';
import { snapshotDir, WRITES_SNAPSHOT } from './paths.js';
import { enumerateRoutes, routeKey, type RouteRecord } from './routes.js';
import { describe, sortShape, type Json, type Shape } from './shape.js';
import {
  classifyWrite,
  isUnsynthesisable,
  type BodyContext,
  type Intercepted,
  type MockProvider,
  type WriteSpec,
} from './write-policy.js';

/** Above this many distinct values a field is an open set, not an enum. */
const MAX_ENUM = 120;

export interface WriteCapture {
  persona?: string;
  status?: number;
  shape?: Shape;
  values?: Record<string, string[]>;
  /** The request body's top-level keys — what was sent, without the values. */
  sent?: string[];
  /** Refused by policy: the rule id and the rule, verbatim. */
  refused?: { rule: string; reason: string };
  /** Allowed, but nothing came back to record. Always says why. */
  skipped?: string;
}

export interface WritesSnapshot {
  capturedAt: string;
  /** See WireSnapshot.serverHandlerSha — same contract, same reason. */
  serverHandlerSha: string | null;
  baseUrl: string;
  policy: string;
  /**
   * Which providers the captured server said IT was intercepting, from its own
   * `GET /api/health`. Recorded because it is half of the decision: a route
   * refused as `not-intercepted` is only explicable beside the answer that
   * refused it, and a snapshot taken against a server running fewer mocks is a
   * different snapshot, not a stale one.
   */
  intercepted: MockProvider[];
  routes: Record<string, WriteCapture>;
}

const MOCK_PROVIDERS: readonly MockProvider[] = ['aurora', 'agentcore', 'guardrails', 'cloudwatch'];

/**
 * Ask the server what it is running. Throws rather than degrading: see the
 * precondition note at the top of this file.
 */
export async function readIntercepted(): Promise<Intercepted> {
  const fail = (why: string): never => {
    throw new Error(
      `could not read ${BASE}/api/health, so no write that depends on a mock provider may be replayed: ${why}`,
    );
  };
  let body: unknown;
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (!res.ok) fail(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    fail((err as Error).message);
  }
  const mocks = (body as { mocks?: unknown } | null)?.mocks;
  if (mocks === null || typeof mocks !== 'object' || Array.isArray(mocks)) {
    fail('the response carries no `mocks` object');
  }
  const on = mocks as Record<string, unknown>;
  return new Set(MOCK_PROVIDERS.filter((p) => on[p] === true));
}

/** The `BodyContext` a spec's `build` is handed. Reads only. */
function bodyContext(persona: Persona, path: string, counter: { n: number }): BodyContext {
  const fetchJson = async (path: string): Promise<Json | null> => {
    const res = await get(`${BASE}${path}`, persona).catch(() => null);
    if (!res || res.status !== 200 || res.body === undefined) return null;
    return res.body;
  };
  return {
    path,
    get: fetchJson,
    pick: async (path, field) => {
      const body = await fetchJson(path);
      return body === null ? null : firstIdIn(body, field);
    },
    label: () => `wire-capture-${(counter.n += 1)}`,
  };
}

async function reset(persona: Persona): Promise<void> {
  await send(`${BASE}/api/__mock/reset`, persona, { method: 'POST', body: {} }).catch(() => null);
}

function accepted(spec: WriteSpec, status: number): boolean {
  if (status >= 200 && status < 300) return true;
  return (spec.alsoAccept ?? []).includes(status);
}

/** A one-line reason from an error body, so a failure is readable in the snapshot. */
function why(status: number, body: Json | undefined, note: string): string {
  if (note) return `${note} (HTTP ${status})`;
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const err = body['error'] ?? body['message'];
    if (typeof err === 'string' && err) return `HTTP ${status}: ${err}`;
  }
  return `HTTP ${status}`;
}

async function writeServerHandlerSha(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/api/__mock/state`);
    if (!res.ok) return null;
    const body = (await res.json()) as { handlerSha?: unknown };
    return typeof body.handlerSha === 'string' && body.handlerSha ? body.handlerSha : null;
  } catch {
    return null;
  }
}

export async function captureWrites(log: (s: string) => void = () => {}): Promise<WritesSnapshot> {
  const table = enumerateRoutes();
  const writes = table.routes
    .filter((r: RouteRecord) => r.method !== 'GET')
    .map(routeKey)
    .filter((k, i, all) => all.indexOf(k) === i)
    .sort();

  // Before anything is replayed: what does this server say it is running?
  const intercepted = await readIntercepted();
  log(`  writes: ${BASE} reports mocks ${[...intercepted].sort().join(', ') || '(none)'}`);

  const routes: Record<string, WriteCapture> = {};
  const personas = new Map<PersonaName, Persona>();
  const paramCache = new Map<string, string | null>();
  const counter = { n: 0 };

  const personaFor = async (name: PersonaName): Promise<Persona> => {
    const have = personas.get(name);
    if (have) return have;
    const spec = PERSONAS.find((p) => p.name === name);
    if (!spec) throw new Error(`write-policy names an unknown persona: ${name}`);
    const p = await login(spec);
    personas.set(name, p);
    return p;
  };

  // Any session will do for the reset itself — the control plane takes none.
  const resetter = await personaFor('orgiq/admin');

  let replayed = 0;
  let refused = 0;
  try {
    for (const route of writes) {
      const verdict = classifyWrite(route, intercepted);
      if (verdict.kind === 'refused') {
        routes[route] = { refused: { rule: verdict.rule, reason: verdict.reason } };
        refused += 1;
        continue;
      }

      const spec = verdict.spec;
      const persona = await personaFor(spec.persona);
      const [method, path] = route.split(' ') as [string, string];

      // Reset FIRST: the ids resolved below must come from the seeded world,
      // not from whatever the previous replay created in it.
      await reset(resetter);

      const resolved = await resolvePath(path, persona, paramCache);
      if ('skipped' in resolved) {
        routes[route] = { skipped: `${resolved.skipped} (${persona.name})` };
        continue;
      }

      let body: Json | undefined;
      if (spec.build) {
        let built: Json | { unsynthesisable: string };
        try {
          built = await spec.build(bodyContext(persona, resolved.path, counter));
        } catch (err) {
          routes[route] = { skipped: `body could not be built: ${(err as Error).message}` };
          continue;
        }
        if (isUnsynthesisable(built)) {
          routes[route] = { skipped: `no body: ${built.unsynthesisable}` };
          continue;
        }
        body = built;
      } else {
        body = {};
      }

      let res;
      try {
        res = await send(`${BASE}${resolved.path}`, persona, {
          method,
          body,
          timeoutMs: 10_000,
          ...(spec.headers ? { headers: spec.headers } : {}),
        });
      } catch (err) {
        const msg = (err as Error).name === 'AbortError'
          ? 'timed out after 10s — never sent response headers'
          : (err as Error).message;
        routes[route] = { skipped: `${msg} (${persona.name})` };
        continue;
      }

      const sent = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? Object.keys(body).sort()
        : [];

      if (!accepted(spec, res.status) || res.body === undefined) {
        routes[route] = { skipped: `${why(res.status, res.body, res.note)} (${persona.name})`, sent };
        continue;
      }

      const one = describe(res.body);
      const values: Record<string, string[]> = {};
      for (const p of [...one.values.keys()].sort()) {
        const seen = [...one.values.get(p)!].sort();
        if (seen.length <= MAX_ENUM) values[p] = seen;
      }
      routes[route] = { persona: persona.name, status: res.status, shape: sortShape(one.shape), values, sent };
      replayed += 1;
    }
  } finally {
    // Put the world back even if the sweep threw — this server may be a
    // long-lived dev:mock somebody else is looking at.
    await reset(resetter);
  }

  log(`  writes: replayed ${replayed}, refused ${refused}, ${writes.length - replayed - refused} allowed but uncaptured`);

  return {
    capturedAt: new Date().toISOString(),
    serverHandlerSha: await writeServerHandlerSha(),
    baseUrl: BASE,
    policy: 'middleware/src/mock/core/wire/write-policy.ts',
    intercepted: [...intercepted].sort(),
    routes: Object.fromEntries(Object.keys(routes).sort().map((k) => [k, routes[k]!])),
  };
}

export function writeWritesSnapshot(snapshot: WritesSnapshot): void {
  const dir = snapshotDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, WRITES_SNAPSHOT), `${JSON.stringify(snapshot, null, 2)}\n`);

  const all = Object.entries(snapshot.routes);
  const captured = all.filter(([, c]) => c.shape);
  const refusedBy = new Map<string, number>();
  for (const [, c] of all) {
    if (!c.refused) continue;
    refusedBy.set(c.refused.rule, (refusedBy.get(c.refused.rule) ?? 0) + 1);
  }
  console.log(`wire: ${captured.length}/${all.length} write routes captured from ${snapshot.baseUrl}`);
  for (const [rule, n] of [...refusedBy].sort((a, b) => b[1] - a[1])) {
    console.log(`  refused ${String(n).padStart(3)}  ${rule}`);
  }
  for (const [k, c] of all) {
    if (!c.shape && !c.refused) console.log(`  uncaptured  ${k}  — ${c.skipped}`);
  }
}

export async function main(): Promise<void> {
  writeWritesSnapshot(await captureWrites((s) => console.log(s)));
}

// `npx tsx src/mock/core/wire/capture-writes.ts`
if (process.argv[1]?.endsWith('capture-writes.ts')) {
  main().catch((err: unknown) => {
    console.error(`wire write capture failed: ${(err as Error).message}`);
    console.error(`Is a mock server running on ${BASE}?  cd middleware && npm run dev:mock`);
    process.exit(1);
  });
}
