// Pure mapping between Aurora rows and FleetBox — no I/O, no config.
//
// Split out of providers/devbox-fleet-store.ts so it can be unit-tested:
// the store imports config.ts, which uses `import.meta` and therefore
// cannot be loaded under the CJS jest config (same constraint
// routes/devbox.ts documents). The timezone handling below is the
// load-bearing part of the whole persistence story, so it needs tests.

import { type FleetBox } from './devbox-fleet.js';

/**
 * Read an Aurora timestamp as the UTC instant it actually is.
 *
 * The Data API hands a TIMESTAMPTZ back as a NAIVE string —
 * `2026-09-09 17:49:44.532`, no zone marker — and `new Date()` reads a string
 * in that shape as LOCAL time. On a UTC-4 host that turned a box created at
 * 17:49Z into one created at 21:49Z: four hours in the FUTURE.
 *
 * That is not cosmetic. `decideReaping` computes `age = now - createdAt`, so a
 * future timestamp makes age negative and the lifetime ceiling never fires —
 * the exact defect `trustedCreatedAt` was written to stop a caller causing,
 * reintroduced through the back door by hydration, which deliberately bypasses
 * that clamp to keep stored ages honest. Measured on the running middleware:
 * a box one minute old came back reporting `lifetimeMsLeft` of ~5 hours
 * against a 60-minute ceiling.
 *
 * So: if the string carries no zone, it is UTC — because that is what the
 * column stores — and never whatever zone this process happens to run in.
 */
export function utcIso(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return new Date().toISOString();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
  const isoish = text.includes('T') ? text : text.replace(' ', 'T');
  const d = new Date(hasZone ? isoish : `${isoish}Z`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

export function rowToBox(r: Record<string, unknown>): FleetBox {
  const box: FleetBox = {
    id: String(r['id'] ?? ''),
    label: String(r['label'] ?? ''),
    sessionId: String(r['session_id'] ?? ''),
    status: (String(r['status'] ?? 'idle') as FleetBox['status']),
    createdAt: utcIso(r['created_at']),
    lastActivityAt: utcIso(r['last_activity_at']),
  };
  if (r['owner_id'] != null) box.ownerId = String(r['owner_id']);
  if (r['project_id'] != null) box.projectId = String(r['project_id']);
  if (r['active_model'] != null) box.activeModel = String(r['active_model']);
  if (r['spend_usd'] != null) box.spendUsd = Number(r['spend_usd']);
  if (r['tokens_used'] != null) box.tokensUsed = Number(r['tokens_used']);
  return box;
}
