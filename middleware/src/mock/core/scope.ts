// Request-scoped worlds — one browser context's scenario, never the process's.
//
// WHY THIS EXISTS. `POST /api/__mock/scenario` switches the ONE world every
// session shares. Two audits running at once could not both have what they
// needed: the one asking for `empty` emptied the other's table, and a write
// made while auditing landed in the shared rows the next auditor read. A scope
// is a world that only requests carrying its id see (the `orgiq.mock-scope`
// cookie or the `x-mock-scope` header, see routes/mock-control.ts), and it is
// copy-on-write: the first read of a fixture inside a scope materializes the
// scope's OWN rows (a clone of the shared rows, or the scenario's factory), so
// a POST under a scope mutates the scope's copy and nothing else.
//
// HOW A READ FINDS ITS SCOPE. `AsyncLocalStorage`: the control plane's
// middleware runs the rest of the request inside `runInMockScope`, so every
// `fixture.rows()` the handler reaches — however deep, across awaits and
// timers it starts — resolves through the scope. Nothing outside a request
// (boot, the realtime gateway's socket handlers, a director's timer started
// before the scope) sees one. What that leaves unscoped is written out in
// middleware/src/mock/core/contract.ts § Scopes.
//
// DATA STATES. A scope can ask for every registry scenario, plus three states
// the registry derives for any fixture without the fixture declaring them:
//   long-text  default rows with human-text fields (names, titles, emails,
//              labels, summaries) padded to 80 characters
//   many       at least MANY_ROWS rows (the fixture's `large` when it declares
//              one that big, else the default rows replicated with fresh ids)
//   loading    default rows, every response held back `delayMs` (bounded)
// and, when the scope names a fixture explicitly, a generic `empty` ([]) and
// `error` (the read throws) for fixtures that never declared them. A
// whole-world `empty`/`error` scope keeps the registry's rule — only declared
// branches — because emptying a fixture nobody designed an empty state for
// (the capability catalogue, the cast) breaks the page rather than showing its
// empty state.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { ScenarioName } from './contract.js';

export type DataState = 'long-text' | 'many' | 'loading';
export type ScopeScenario = ScenarioName | DataState;

export const DATA_STATES: Record<DataState, string> = {
  'long-text': 'Default rows with every name, title, email, label and summary padded to 80 characters.',
  many: 'At least 200 rows per fixture: its declared `large` when that is big enough, else the default rows replicated with fresh ids.',
  loading: 'Default rows, every response in the scope held back (default 2.5 s, at most 10 s) so loading states can be seen.',
};

export function isDataState(value: unknown): value is DataState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DATA_STATES, value);
}

/** Rows a `many` state guarantees per non-empty fixture. */
export const MANY_ROWS = 200;
/** Length every padded human-text field reaches under `long-text`. */
export const LONG_TEXT_LENGTH = 80;
export const DEFAULT_LOADING_DELAY_MS = 2_500;
export const MAX_DELAY_MS = 10_000;
export const DEFAULT_SCOPE_TTL_MS = 30 * 60_000;
export const MAX_SCOPE_TTL_MS = 6 * 60 * 60_000;
/** Scopes are cheap but each holds its own rows; a runaway loop must not grow the heap without bound. */
export const MAX_SCOPES = 64;

export interface MockScope {
  readonly id: string;
  readonly label: string | null;
  /** The world every fixture not named in `fixtures` resolves to. */
  readonly base: ScopeScenario;
  /** Fixtures switched on their own inside the scope. */
  readonly fixtures: Readonly<Record<string, ScopeScenario>>;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Held before every scoped response; 0 unless a `loading` state is in play or asked for. */
  readonly delayMs: number;
  /** fixture object → scenario → this scope's own rows. Keyed by object, so two registries never collide. */
  readonly rows: WeakMap<object, Map<string, unknown[]>>;
  /** Keys of fixtures read inside the scope, for the control plane's report. */
  readonly touched: Set<string>;
}

const storage = new AsyncLocalStorage<MockScope>();
const scopes = new Map<string, MockScope>();

/** Wall time for expiry. Not the fixture clock: a frozen test clock must not keep a scope alive forever. */
const wallNow = (): number => Date.now();

/** The scope the current request runs in, if any. */
export function currentMockScope(): MockScope | undefined {
  return storage.getStore();
}

export function runInMockScope<T>(scope: MockScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Run `fn` outside any scope (the control plane's own global reads). */
export function runOutsideMockScope<T>(fn: () => T): T {
  return storage.exit(fn);
}

/** The scenario a fixture resolves to inside `scope`. */
export function scopeScenarioFor(scope: MockScope, key: string): ScopeScenario {
  return scope.fixtures[key] ?? scope.base;
}

/** Whether `key` was named on its own (generic empty/error apply only then). */
export function scopeNamesFixture(scope: MockScope, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(scope.fixtures, key);
}

function prune(): void {
  const now = wallNow();
  for (const [id, scope] of scopes) if (scope.expiresAt <= now) scopes.delete(id);
}

export interface CreateScopeInput {
  base: ScopeScenario;
  fixtures?: Record<string, ScopeScenario>;
  label?: string | null;
  ttlMs?: number;
  delayMs?: number;
}

export class ScopeLimitError extends Error {}

export function createMockScope(input: CreateScopeInput): MockScope {
  prune();
  if (scopes.size >= MAX_SCOPES) throw new ScopeLimitError(`at most ${MAX_SCOPES} live mock scopes; DELETE one or POST /api/__mock/reset`);
  const fixtures = { ...(input.fixtures ?? {}) };
  const loading = input.base === 'loading' || Object.values(fixtures).includes('loading');
  const asked = typeof input.delayMs === 'number' && Number.isFinite(input.delayMs) ? input.delayMs : undefined;
  const delayMs = Math.max(0, Math.min(MAX_DELAY_MS, Math.round(asked ?? (loading ? DEFAULT_LOADING_DELAY_MS : 0))));
  const ttl = typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) && input.ttlMs > 0
    ? Math.min(input.ttlMs, MAX_SCOPE_TTL_MS)
    : DEFAULT_SCOPE_TTL_MS;
  const createdAt = wallNow();
  const scope: MockScope = {
    // 128 random bits: the id is the only credential a scope has, so it must not be guessable.
    id: `ms-${randomBytes(16).toString('hex')}`,
    label: input.label ?? null,
    base: input.base,
    fixtures,
    createdAt,
    expiresAt: createdAt + ttl,
    delayMs,
    rows: new WeakMap(),
    touched: new Set(),
  };
  scopes.set(scope.id, scope);
  return scope;
}

/** A live scope by id; an expired one is dropped and reads as unknown. */
export function getMockScope(id: string): MockScope | undefined {
  const scope = scopes.get(id);
  if (!scope) return undefined;
  if (scope.expiresAt <= wallNow()) { scopes.delete(id); return undefined; }
  return scope;
}

export function deleteMockScope(id: string): boolean {
  return scopes.delete(id);
}

export function listMockScopes(): MockScope[] {
  prune();
  return [...scopes.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** Drop every scope (full reset). Their rows go with them. */
export function clearMockScopes(): number {
  const n = scopes.size;
  scopes.clear();
  return n;
}

export function describeMockScope(scope: MockScope): {
  id: string; label: string | null; scenario: ScopeScenario; fixtures: Record<string, ScopeScenario>;
  createdAt: string; expiresAt: string; delayMs: number; touched: string[];
} {
  return {
    id: scope.id,
    label: scope.label,
    scenario: scope.base,
    fixtures: { ...scope.fixtures },
    createdAt: new Date(scope.createdAt).toISOString(),
    expiresAt: new Date(scope.expiresAt).toISOString(),
    delayMs: scope.delayMs,
    touched: [...scope.touched].sort(),
  };
}

// ── The generic data states ─────────────────────────────────────────────────

/** Copy rows so a scope's writes never reach the array they came from. */
export function cloneRows<Row>(rows: Row[]): Row[] | null {
  try {
    return structuredClone(rows);
  } catch {
    // A row holding a function or a class the structured-clone algorithm
    // refuses; the caller falls back to the factory, which is a fresh copy too.
    return null;
  }
}

const HUMAN_TEXT_KEY = /(name|title|email|label|headline|summary|subject|description|caption)$/i;
const NOT_PROSE = /^(https?:|\/|\d{4}-\d{2}-\d{2}T)/;
const FILLER = ' with a deliberately long value the audit uses to find clipping and overflow';

function padEmail(value: string): string {
  const at = value.indexOf('@');
  const local = value.slice(0, at), domain = value.slice(at);
  let padded = local;
  const suffix = '.with-a-much-longer-address';
  while (padded.length + domain.length < LONG_TEXT_LENGTH) padded += suffix;
  return (padded.slice(0, LONG_TEXT_LENGTH - domain.length) + domain);
}

function padText(value: string): string {
  let padded = value;
  while (padded.length < LONG_TEXT_LENGTH) padded += FILLER;
  return padded.slice(0, LONG_TEXT_LENGTH);
}

/**
 * Pad human-text fields. A field qualifies by its KEY (name, title, email…) and
 * by looking like prose: it holds a space or an `@`. That second test is what
 * keeps wire keys alone — `name: 'orgiq-supervisor'` is an identifier other
 * code looks rows up by, `name: 'Vera Green'` is something a person reads.
 */
export function lengthen(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => lengthen(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && HUMAN_TEXT_KEY.test(key) && v.length < LONG_TEXT_LENGTH && !NOT_PROSE.test(v)) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) out[key] = padEmail(v);
      else if (/\s/.test(v)) out[key] = padText(v);
      else out[key] = v;
    } else {
      out[key] = lengthen(v, depth + 1);
    }
  }
  return out;
}

/** Replicate rows to at least MANY_ROWS, giving each copy its own `id`. */
export function multiply<Row>(rows: Row[]): Row[] {
  if (rows.length === 0 || rows.length >= MANY_ROWS) return rows;
  const out: Row[] = [...rows];
  for (let copy = 1; out.length < MANY_ROWS; copy++) {
    for (const row of rows) {
      if (out.length >= MANY_ROWS) break;
      const clone = (cloneRows([row]) ?? [row])[0] as Row;
      if (clone && typeof clone === 'object') {
        const r = clone as Record<string, unknown>;
        if (typeof r['id'] === 'string') r['id'] = `${r['id']}-m${copy}`;
        else if (typeof r['id'] === 'number') r['id'] = (r['id'] as number) + copy * 1_000_000;
      }
      out.push(clone);
    }
  }
  return out;
}

/** The error a generic `error` state throws — the same shape the declared ones use. */
export function scopedUnavailable(key: string): Error {
  return new Error(`${key} unavailable: relation does not exist (mock scope error state)`);
}

/** Test seam. */
export function __resetMockScopes(): void {
  scopes.clear();
}
