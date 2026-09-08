// Read the captured truth back as something a fixture can be measured against:
// one entry per OBJECT the server actually sends, carrying that object's key
// set and the wire-shaped values of its own fields.
//
// Per object, not per API. An earlier version pooled every `status` string the
// whole surface emits into one set and checked fixtures against that; it
// produced 679 findings, nearly all of them wrong, because a correct
// `status: 'queued'` from the job queue was compared against a union that
// happened to be dominated by assessment team statuses. A union across routes
// is not a fact about any response. `GET /api/assessment/knowledge/tree`'s
// `sections[].key` is.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { snapshotDir, WIRE_SNAPSHOT, WRITES_SNAPSHOT } from './paths.js';
import { fieldName, keyNamesOf, type Shape } from './shape.js';
import { type MockProvider } from './write-policy.js';

export interface CapturedRoute {
  persona?: string;
  status?: number;
  shape?: Shape;
  values?: Record<string, string[]>;
  skipped?: string;
}

export interface WireSnapshotFile {
  capturedAt: string;
  baseUrl: string;
  personas: string[];
  routes: Record<string, CapturedRoute>;
  vocabulary: Record<string, { open: boolean; values: string[] }>;
}

/** One object the server sends, at one place in one response. */
export interface ObjectShapeRef {
  /** `GET /api/assessment/knowledge/tree` */
  route: string;
  /** `sections[]`, or `$` for the response root. */
  path: string;
  /** The keys that object carries. */
  keys: Set<string>;
  /** Wire-shaped field on THIS object -> the values the server sends there. */
  values: Map<string, Set<string>>;
}

/**
 * One replayed write, as `capture-writes.ts` files it. Refused and uncaptured
 * entries carry a reason instead of a shape — the gap is part of the record.
 */
export interface CapturedWrite {
  persona?: string;
  status?: number;
  shape?: Shape;
  values?: Record<string, string[]>;
  sent?: string[];
  refused?: { rule: string; reason: string };
  skipped?: string;
}

export interface WritesSnapshotFile {
  capturedAt: string;
  baseUrl: string;
  policy: string;
  /**
   * Which mock providers the captured SERVER reported for itself. Half of the
   * write decision lives here: a route recorded as `not-intercepted` is only
   * readable beside the answer that refused it, and a snapshot taken against a
   * server running fewer mocks is a different snapshot rather than a stale one.
   * Optional only so a snapshot taken before this field existed still parses —
   * the policy test asserts it is present, which is the prompt to recapture.
   */
  intercepted?: MockProvider[];
  routes: Record<string, CapturedWrite>;
}

export interface Vocabulary {
  capturedAt: string;
  /** Every object shape the server sends, across every captured route. */
  objects: ObjectShapeRef[];
  /** Every key name the server sends anywhere — used only in messages. */
  keyNames: Set<string>;
  /** Routes with no captured shape, and why. */
  uncaptured: Array<{ route: string; reason: string }>;
  routeCount: number;
  capturedCount: number;
  /** The write half. Zero when no writes snapshot has been taken yet. */
  writeRouteCount: number;
  writeCapturedCount: number;
  /** Write routes the policy refused, by rule id — printed, never silent. */
  writeRefusedByRule: Record<string, number>;
}

export function snapshotPath(): string {
  return join(snapshotDir(), WIRE_SNAPSHOT);
}

export function writesSnapshotPath(): string {
  return join(snapshotDir(), WRITES_SNAPSHOT);
}

export function hasSnapshot(): boolean {
  return existsSync(snapshotPath());
}

export function hasWritesSnapshot(): boolean {
  return existsSync(writesSnapshotPath());
}

/**
 * The write replay's snapshot, or `null` when none has been taken. Optional on
 * purpose: the GET half must keep working on a checkout that predates the
 * write capture, rather than failing with a missing-file error that tells a
 * reader nothing about which half is missing.
 */
export function readWritesSnapshot(): WritesSnapshotFile | null {
  const file = writesSnapshotPath();
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as WritesSnapshotFile;
}

export function readSnapshot(): WireSnapshotFile {
  const file = snapshotPath();
  if (!existsSync(file)) {
    throw new Error(
      `wire: no snapshot at ${file}. Regenerate it:\n` +
        `  cd middleware && npm run dev:mock       # one terminal\n` +
        `  cd middleware && npx tsx src/mock/core/wire/capture.ts`,
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as WireSnapshotFile;
}

/** Is `child` a direct child path of `parent`? `a.b` is; `a.b.c` is not. */
function directChild(parent: string, child: string): string | null {
  if (child === parent || child === '$') return null;
  const rest = parent === '$' ? child : child.startsWith(`${parent}.`) ? child.slice(parent.length + 1) : null;
  if (rest === null || rest.includes('.')) return null;
  const name = rest.replace(/\[\]$/, '');
  return name || null;
}

/**
 * Every object the server sends inside ONE captured response, as shape refs.
 * Shared by the GET and the write halves: a `POST /api/bots` 201 carrying
 * `{ bot: {...} }` is exactly as good a witness to what `bot` looks like as a
 * `GET /api/bots` row is, and the check must not care which verb produced it.
 */
function objectsIn(route: string, shape: Shape, values: Record<string, string[]> | undefined): ObjectShapeRef[] {
  const out: ObjectShapeRef[] = [];
  for (const [path, type] of Object.entries(shape)) {
    if (!type.includes('object')) continue;
    const keys = new Set<string>();
    for (const p of Object.keys(shape)) {
      const name = directChild(path, p);
      if (name) keys.add(name);
    }
    if (keys.size === 0) continue;
    const own = new Map<string, Set<string>>();
    for (const [vpath, list] of Object.entries(values ?? {})) {
      const name = directChild(path, vpath);
      if (name && fieldName(vpath) === name) own.set(name, new Set(list));
    }
    out.push({ route, path, keys, values: own });
  }
  return out;
}

export function buildVocabulary(
  snapshot: WireSnapshotFile,
  writes: WritesSnapshotFile | null = null,
): Vocabulary {
  const objects: ObjectShapeRef[] = [];
  const keyNames = new Set<string>();
  const uncaptured: Array<{ route: string; reason: string }> = [];
  let capturedCount = 0;

  for (const [route, cap] of Object.entries(snapshot.routes)) {
    if (!cap.shape) {
      uncaptured.push({ route, reason: cap.skipped ?? 'unknown' });
      continue;
    }
    capturedCount += 1;
    for (const k of keyNamesOf(cap.shape)) keyNames.add(k);
    objects.push(...objectsIn(route, cap.shape, cap.values));
  }

  // The write half. A refused route is NOT listed as uncaptured: it is a
  // decision with a reason attached (write-policy.ts), not a gap.
  let writeCapturedCount = 0;
  const writeRefusedByRule: Record<string, number> = {};
  for (const [route, cap] of Object.entries(writes?.routes ?? {})) {
    if (cap.refused) {
      writeRefusedByRule[cap.refused.rule] = (writeRefusedByRule[cap.refused.rule] ?? 0) + 1;
      continue;
    }
    if (!cap.shape) {
      uncaptured.push({ route, reason: cap.skipped ?? 'unknown' });
      continue;
    }
    writeCapturedCount += 1;
    for (const k of keyNamesOf(cap.shape)) keyNames.add(k);
    objects.push(...objectsIn(route, cap.shape, cap.values));
  }

  return {
    capturedAt: snapshot.capturedAt,
    objects,
    keyNames,
    uncaptured,
    routeCount: Object.keys(snapshot.routes).length,
    capturedCount,
    writeRouteCount: Object.keys(writes?.routes ?? {}).length,
    writeCapturedCount,
    writeRefusedByRule,
  };
}

export function loadVocabulary(): Vocabulary {
  return buildVocabulary(readSnapshot(), readWritesSnapshot());
}

export interface Match {
  /** The shape to name in a message — the smallest, i.e. most specific. */
  ref: ObjectShapeRef;
  /**
   * EVERY shape the fixture could be. A three-key `{id, name, status}` matches
   * dozens of responses exactly, and picking one of them at random and then
   * calling its `status` values authoritative is how a correct fixture gets
   * accused. A value is only invented when NONE of these sends it.
   */
  refs: ObjectShapeRef[];
  /** Fixture keys the matched shape does NOT carry. Empty for an exact match. */
  missing: string[];
  /** How much of the fixture the shape accounts for, 0–1. */
  coverage: number;
}

/** Union of the values every candidate shape sends for `field`. */
export function valuesFor(match: Match, field: string): Set<string> {
  const out = new Set<string>();
  for (const ref of match.refs) for (const v of ref.values.get(field) ?? []) out.add(v);
  return out;
}

/**
 * Which server object, if any, this fixture is standing in for.
 *
 * EXACT means every key of the fixture exists on some single real object —
 * the fixture omits, which is allowed, and invents nothing. Among exact
 * matches the SMALLEST shape wins: it is the most specific claim, and its
 * per-field value sets are the tightest.
 *
 * NEAR means one real object accounts for most of the fixture but not all.
 * Those leftover keys are the interesting ones — that is a fixture describing
 * a response with a field the response has not got. The bar is deliberately
 * high (four or more matching keys, three quarters covered) because below it
 * an ordinary local object with a `name` and an `id` starts to look like a
 * response and the check turns into noise.
 *
 * NO MATCH means this object is not pretending to be a server response at all
 * — a domain function's options bag, a component's props — and is left alone.
 */
export function matchObject(vocab: Vocabulary, keys: readonly string[]): Match | null {
  if (keys.length < 3) return null;
  const unique = [...new Set(keys)];

  const exact: ObjectShapeRef[] = [];
  let near: Match | null = null;

  for (const ref of vocab.objects) {
    let hits = 0;
    for (const k of unique) if (ref.keys.has(k)) hits += 1;
    if (hits < 3) continue;

    if (hits === unique.length) {
      exact.push(ref);
      continue;
    }
    const coverage = hits / unique.length;
    if (hits >= 4 && coverage >= 0.75 && (!near || coverage > near.coverage)) {
      near = { ref, refs: [ref], missing: unique.filter((k) => !ref.keys.has(k)), coverage };
    }
  }

  if (exact.length > 0) {
    const smallest = exact.reduce((a, b) => (b.keys.size < a.keys.size ? b : a));
    return { ref: smallest, refs: exact, missing: [], coverage: 1 };
  }
  return near;
}

/** Where fixtures live. Both packages, because the bug was in the portal's. */
export const fixtureFilesRoots = ['middleware/src', 'portal/src'];
