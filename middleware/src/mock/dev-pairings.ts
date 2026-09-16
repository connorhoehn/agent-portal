// Machines you paired by hand, surviving a dev restart.
//
// WHY THIS EXISTS. Under `dev:mock` the compute_nodes fixture is rebuilt from
// its seed on every boot, and `tsx watch` reboots on every middleware file
// save. A laptop paired at runtime lives only in that fixture's row array, so
// each save silently unpairs it: the worker keeps polling, gets
// `401 invalid or revoked node token`, and a person has to mint a fresh code
// and re-run the pair command. That happened three times in one afternoon of
// ordinary editing, and every one of them cost someone their place.
//
// In production none of this applies — `compute_nodes` is an Aurora table and
// a restart changes nothing. This is a dev-loop fix, and it is scoped like one.
//
// WHAT KEEPS IT FROM LEAKING INTO THE CONTRACT. The mock floor requires a
// fixture's rows to be a pure function of its seed: the wire capture replays
// routes against a throwaway server and commits the shapes, and the jest
// suites assert seeded counts. A default scenario that silently grew a row
// from someone's laptop would poison both.
//
// So this is OFF unless `MOCK_PERSIST_PAIRINGS=1` is set, which only
// `npm run dev:mock` does. The capture harness, the test runner and CI all
// run without it and see exactly the seeded world they always did.
//
// `POST /api/__mock/reset` clears the file as well as the rows, so reset still
// means reset.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the file lives. Gitignored; nothing reads it but this module. */
const STORE = join(process.cwd(), '.dev-pairings.json');

/**
 * Deliberately an explicit opt-in rather than `NODE_ENV !== 'production'`.
 * The wire capture and the jest suites both run with NODE_ENV=development, so
 * an environment check would have turned this on for exactly the two callers
 * that must never see it.
 */
export function devPairingsEnabled(): boolean {
  return process.env['MOCK_PERSIST_PAIRINGS'] === '1';
}

/**
 * Rows to re-adopt at boot. Never throws: a corrupt or unreadable file means
 * you re-pair once, which is the old behaviour, and is a much better outcome
 * than a middleware that will not start.
 */
export function loadDevPairings<T>(): T[] {
  if (!devPairingsEnabled() || !existsSync(STORE)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(STORE, 'utf8'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Append one runtime-paired row. Best effort, for the same reason. */
export function saveDevPairing<T>(row: T): void {
  if (!devPairingsEnabled()) return;
  try {
    const all = loadDevPairings<T>();
    all.push(row);
    mkdirSync(dirname(STORE), { recursive: true });
    writeFileSync(STORE, JSON.stringify(all, null, 2));
  } catch {
    /* the pairing still works for this process; it just will not outlive it */
  }
}

/** Reset means reset — the rows AND the file they would come back from. */
export function clearDevPairings(): void {
  if (!devPairingsEnabled()) return;
  try {
    if (existsSync(STORE)) writeFileSync(STORE, '[]');
  } catch { /* nothing to do */ }
}
