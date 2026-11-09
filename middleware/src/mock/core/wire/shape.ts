// Turn a real response body into the thing worth remembering: its key paths
// and its wire-shaped string values. Never its data.
//
// A snapshot of values would rot every time the seed moved and would tell a
// reader nothing. A snapshot of *paths* is stable across seed changes and is
// exactly the axis the `enterprise` / `enterprise_context` bug lived on: the
// portal read a key the server does not send.
//
// Array indices collapse to `[]`, so a 200-row list contributes one path per
// field, and the shape of row 1 and row 200 are merged (a field only some rows
// carry still shows up — that is the point, a fixture may omit, never invent).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** `sections[].key` -> `"string"`, or `"string|null"` when rows disagree. */
export type Shape = Record<string, string>;

const ROOT = '$';

function typeOf(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v;
}

function add(shape: Shape, path: string, type: string): void {
  const existing = shape[path];
  if (existing === undefined) {
    shape[path] = type;
    return;
  }
  if (existing === type) return;
  const parts = new Set(existing.split('|'));
  parts.add(type);
  shape[path] = [...parts].sort().join('|');
}

/**
 * A dictionary is an object used as a map: many keys, all values the same
 * primitive type. `GET /api/session/capabilities` sends its capability names
 * that way (`actions: { Search: true, ManageBots: false, ... }`), so the
 * capability vocabulary is only reachable by noticing this. Its keys are
 * recorded as VALUES of the containing field, not as key paths — otherwise a
 * renamed capability would read as 30 removed paths and one added one.
 */
export function looksLikeDictionary(v: Json): v is { [k: string]: Json } {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length < 8) return false;
  const types = new Set(keys.map((k) => typeOf(v[k]!)));
  if (types.size !== 1) return false;
  const only = [...types][0]!;
  return only === 'boolean' || only === 'number' || only === 'string';
}

export interface ShapeResult {
  shape: Shape;
  /**
   * Key PATH -> the string values seen there. Keyed by path, not by field
   * name: a union of every `status` the whole API sends is not a fact about
   * any one response, and checking a fixture against it flags a correct
   * `status` from route A because route B never sends it. `sections[].key`
   * is a fact; `key` is not.
   */
  values: Map<string, Set<string>>;
}

/** Last path segment, minus array marks: `a.b[].section_key` -> `section_key`. */
export function fieldName(path: string): string {
  const last = path.split('.').pop() ?? path;
  return last.replace(/\[\]$/, '');
}

/**
 * Field names whose string values are wire vocabulary — a closed-ish set the
 * server chooses from, not free text or an id. These are the strings that bite:
 * a fixture inventing `enterprise` for a `key`, `running` for a `status`,
 * `ViewKnowledge` for a capability.
 *
 * Deliberately excludes `id`, `name`, `title`, `path`, `summary` and friends:
 * those are open sets, and asserting a fixture may only use ids the seed
 * happens to contain is the parity harness's job, not this one's.
 */
export const WIRE_FIELDS = new Set([
  'action',
  'actions',
  'capability',
  'category',
  'classification',
  'decision',
  'direction',
  'gate',
  'kind',
  'level',
  'mode',
  'outcome',
  'phase',
  'requiredTenant',
  'role',
  'roles',
  'scenario',
  'section',
  'sectionKey',
  'section_key',
  'severity',
  'stage',
  'state',
  'status',
  'tenant',
  'tenants',
  'type',
  'verdict',
  'key',
]);

/**
 * Routes whose response carries a WIRE_FIELDS name as FREE TEXT. A decision's
 * `outcome` is the rationale the decider typed (or an option label), so on the
 * decisions routes it is not an enum and its values must never be witnessed.
 * Keyed by route ("METHOD /path"), matched as a prefix on the path.
 */
const FREE_TEXT_BY_ROUTE: ReadonlyArray<{ route: RegExp; fields: ReadonlySet<string> }> = [
  { route: /^(GET|POST) \/api\/graph\/decisions(\/|$)/, fields: new Set(['outcome']) },
  { route: /^GET \/api\/graph\/projects\/[^/]+\/decisions(\/|$)/, fields: new Set(['outcome']) },
  { route: /^GET \/api\/graph\/work-items\/[^/]+\/decisions\//, fields: new Set(['outcome']) },
];

/** The WIRE_FIELDS names that are free text on this route (empty when none, or no route given). */
export function freeTextFieldsFor(route: string | undefined): ReadonlySet<string> {
  if (!route) return NO_FIELDS;
  for (const e of FREE_TEXT_BY_ROUTE) if (e.route.test(route)) return e.fields;
  return NO_FIELDS;
}
const NO_FIELDS: ReadonlySet<string> = new Set();

function harvest(values: Map<string, Set<string>>, path: string, value: string, skip: ReadonlySet<string>): void {
  const name = fieldName(path);
  if (!WIRE_FIELDS.has(name) || skip.has(name)) return;
  let set = values.get(path);
  if (!set) values.set(path, (set = new Set()));
  set.add(value);
}

/** Walk one response body. Merges into `into` so several bodies can share a shape. */
export function describe(body: Json, into?: ShapeResult, route?: string): ShapeResult {
  const skip = freeTextFieldsFor(route);
  const out: ShapeResult = into ?? { shape: {}, values: new Map() };

  const walk = (v: Json, path: string): void => {
    if (looksLikeDictionary(v)) {
      add(out.shape, path, 'object(dictionary)');
      for (const k of Object.keys(v)) harvest(out.values, path, k, skip);
      return;
    }
    add(out.shape, path, typeOf(v));
    if (typeof v === 'string') harvest(out.values, path, v, skip);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, `${path}[]`);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k]!, path === ROOT ? k : `${path}.${k}`);
    }
  };

  walk(body, ROOT);
  return out;
}

/** Sorted, so a snapshot diff reads as added/removed lines and nothing else. */
export function sortShape(shape: Shape): Shape {
  const out: Shape = {};
  for (const k of Object.keys(shape).sort()) out[k] = shape[k]!;
  return out;
}

/** Every key name the shape mentions — `sections[].key` contributes `key`. */
export function keyNamesOf(shape: Shape): Set<string> {
  const out = new Set<string>();
  for (const p of Object.keys(shape)) {
    if (p === ROOT) continue;
    for (const seg of p.split('.')) {
      const name = seg.replace(/\[\]$/, '');
      if (name && name !== ROOT) out.add(name);
    }
  }
  return out;
}
