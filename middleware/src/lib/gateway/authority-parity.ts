// The one-release parity assertion between the realtime-modules 0.116
// authority engine (the live verdict, lib/gateway/authority.ts) and the host
// copies it replaced (lib/gateway/authority-legacy.ts for the shape guards,
// lib/live-principal.ts's channel / call / lobby-read primitives for the
// fresh-per-request decisions). Plan: docs/upstream-refinement-plan-2026-10-14.md
// R2 "Risk" and C3 step 4.
//
// The ENGINE always decides. Outside production the host copy is asked as well
// and a different verdict throws `AuthorityParityError` (after a console.error
// naming the decision, the name and the user), so a drift fails the test or the
// dev request that found it instead of shipping. A throw inside a realtime
// hook is a refusal, so a mismatch fails closed.
//
// Modes (AUTHORITY_PARITY):
//   - `throw` (default outside production): sync guards AND async decisions;
//   - `sync`: the shape guards only (no second directory read per decision);
//   - `off` (default in production): the engine alone.
// The async half doubles directory / policy / row reads per decision, which is
// why production never runs it, and why the shared dev BFF samples it: the
// fraction of async decisions also asked of the host copy is
// AUTHORITY_PARITY_SAMPLE (0..1), default 1 under jest and 0.05 otherwise —
// at 2,000 sockets fanning out presence every decision twice starved the dev
// event loop (2026-10-14). A directory write that lands between the two runs
// can produce an honest mismatch in dev; the throw is then a refusal and the
// next frame re-asks.
//
// DELETE this file, authority-legacy.ts and the live-principal host copies at
// the next realtime-modules pin move (0.117).

export type AuthorityParityMode = 'off' | 'sync' | 'throw';

export function authorityParityMode(env: NodeJS.ProcessEnv = process.env): AuthorityParityMode {
  const v = (env['AUTHORITY_PARITY'] ?? '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return 'off';
  if (v === 'sync') return 'sync';
  if (v === 'throw' || v === 'on' || v === '1' || v === 'true') return 'throw';
  return env['NODE_ENV'] === 'production' ? 'off' : 'throw';
}

export class AuthorityParityError extends Error {
  constructor(readonly decision: string, readonly engine: unknown, readonly legacy: unknown, readonly subject: string) {
    super(`authority parity: ${decision} engine=${JSON.stringify(engine)} legacy=${JSON.stringify(legacy)} for ${subject}`);
    this.name = 'AuthorityParityError';
  }
}

/** Every mismatch this process has seen (newest last, bounded) — for tests and /api/health-style probes. */
export const authorityParityMismatches: AuthorityParityError[] = [];

function describe(args: readonly unknown[]): string {
  const parts: string[] = [];
  for (const arg of args) {
    if (typeof arg === 'string') parts.push(arg);
    else if (arg && typeof arg === 'object') {
      const o = arg as Record<string, unknown>;
      const ctx = (o['ctx'] && typeof o['ctx'] === 'object' ? o['ctx'] : o) as Record<string, unknown>;
      if (typeof o['channel'] === 'string') parts.push(`channel=${o['channel']}`);
      if (typeof o['kind'] === 'string') parts.push(`kind=${o['kind']}`);
      if (typeof o['lobbyName'] === 'string') parts.push(`lobby=${o['lobbyName']}`);
      if (typeof ctx['userId'] === 'string') parts.push(`user=${ctx['userId']}@${String(ctx['org'] ?? '?')}`);
    }
  }
  return parts.join(' ') || '(no subject)';
}

function mismatch(decision: string, engine: unknown, legacy: unknown, args: readonly unknown[]): never {
  const error = new AuthorityParityError(decision, engine, legacy, describe(args));
  authorityParityMismatches.push(error);
  if (authorityParityMismatches.length > 100) authorityParityMismatches.shift();
  console.error(`[authority-parity] ${error.message}`);
  throw error;
}

/** A sync shape guard: the engine's verdict, compared with the host copy unless parity is off. */
export function paritySync<A extends unknown[]>(decision: string, engine: (...args: A) => boolean, legacy: (...args: A) => boolean): (...args: A) => boolean {
  return (...args: A) => {
    const verdict = engine(...args);
    if (authorityParityMode() === 'off') return verdict;
    const before = legacy(...args);
    return verdict === before ? verdict : mismatch(decision, verdict, before, args);
  };
}

/** The fraction of async decisions compared (AUTHORITY_PARITY_SAMPLE; default 1 under jest, 0.05 otherwise). */
export function authorityParitySample(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['AUTHORITY_PARITY_SAMPLE']);
  if (env['AUTHORITY_PARITY_SAMPLE'] !== undefined && Number.isFinite(raw)) return Math.min(1, Math.max(0, raw));
  return env['NODE_ENV'] === 'test' || env['JEST_WORKER_ID'] !== undefined ? 1 : 0.05;
}

/** A fresh-per-request decision: the engine's verdict, compared with the host copy in `throw` mode (sampled). */
export function parityAsync<A extends unknown[], R>(decision: string, engine: (...args: A) => Promise<R>, legacy: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const verdict = await engine(...args);
    if (authorityParityMode() !== 'throw') return verdict;
    const sample = authorityParitySample();
    if (sample < 1 && Math.random() >= sample) return verdict;
    const before = await legacy(...args);
    return verdict === before ? verdict : mismatch(decision, verdict, before, args);
  };
}
