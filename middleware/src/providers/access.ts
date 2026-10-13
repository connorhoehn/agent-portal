// The access tenant's store (docs/access-tenant-design.md §3) and the live
// directory its decisions are resolved against (decision A4).
//
// A0 runs on the mock: under MOCK_AURORA every read and write goes to the
// registered fixtures (mock/access-*.ts), so `POST /api/__mock/reset` undoes a
// write. The Aurora half waits for schema/access_schema.sql to be applied
// (lane E, a user decision): until then every call outside the mock answers
// 503 naming the gap, rather than a SQL error or an empty tenant that looks
// healthy.
//
// Reads hand back copies; writes go through the functions below only.

import { config } from '../config.js';
import { AppError } from '../lib/async-handler.js';
import { clock } from '../mock/core/index.js';
import { accessCatalogFixture, type AccessCatalogRow } from '../mock/access-catalog.js';
import { accessPoliciesFixture, type AccessPolicyRow } from '../mock/access-policies.js';
import { accessPeopleFixture } from '../mock/access-people.js';
import {
  accessEventsFixture, accessRequestsFixture, accessStepsFixture,
  type AccessEventRow, type AccessRequestRow, type AccessStepRow,
} from '../mock/access-requests.js';
import { findInitiative } from '../mock/initiatives.js';
import { listUsers } from './identity.js';
import type { AccessDirectory } from '../lib/access/types.js';

export type { AccessCatalogRow, AccessPolicyRow, AccessEventRow, AccessRequestRow, AccessStepRow };

export const ACCESS_STORE_UNAVAILABLE =
  'The access tenant\'s tables are not applied on this cluster (schema/access_schema.sql, docs/access-tenant-goal.md lane E); only dev:mock serves it today';

function store(): void {
  if (!config.mock.aurora) throw new AppError(503, ACCESS_STORE_UNAVAILABLE);
}

const copy = <T>(rows: readonly T[]): T[] => rows.map((r) => structuredClone(r));

/** The instant a write is stamped with (the mock clock under MOCK_AURORA). */
export function accessNow(): string {
  store();
  return clock.nowIso();
}

export function listCatalog(): AccessCatalogRow[] { store(); return copy(accessCatalogFixture.rows()); }
export function listPolicies(): AccessPolicyRow[] { store(); return copy(accessPoliciesFixture.rows()); }
export function listRequests(): AccessRequestRow[] { store(); return copy(accessRequestsFixture.rows()); }
export function listSteps(requestId?: string): AccessStepRow[] {
  store();
  const rows = accessStepsFixture.rows();
  return copy(requestId ? rows.filter((s) => s.requestId === requestId) : rows);
}
export function listEvents(): AccessEventRow[] { store(); return copy(accessEventsFixture.rows()); }

const nextId = (prefix: string, ids: readonly string[]): string => {
  const n = ids.reduce((max, id) => {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    return m ? Math.max(max, parseInt(m[1]!, 10)) : max;
  }, 0);
  return `${prefix}-${String(n + 1).padStart(4, '0')}`;
};

export function nextRequestId(): string { store(); return nextId('req', accessRequestsFixture.rows().map((r) => r.id)); }

type EventDraft = { kind: AccessEventRow['kind']; before: string | null; after: string | null; reason: string | null };

function appendEvents(requestId: string, actorId: string | null, events: readonly EventDraft[], at: string): void {
  const rows = accessEventsFixture.rows();
  for (const e of events) {
    rows.push({ id: nextId('evt', rows.map((r) => r.id)), requestId, at, actorId, kind: e.kind, beforeStatus: e.before, afterStatus: e.after, reason: e.reason });
  }
}

/** Insert a submitted request with its steps and events, in one go. */
export function insertRequest(request: AccessRequestRow, steps: readonly AccessStepRow[], events: readonly EventDraft[], actorId: string): void {
  store();
  accessRequestsFixture.rows().push(structuredClone(request));
  accessStepsFixture.rows().push(...steps.map((s) => structuredClone(s)));
  appendEvents(request.id, actorId, events, request.submittedAt);
}

/** Replace a request and its steps with a transition's result, and append its events. */
export function saveTransition(request: AccessRequestRow, steps: readonly AccessStepRow[], events: readonly EventDraft[], actorId: string | null, at: string): void {
  store();
  const requests = accessRequestsFixture.rows();
  const i = requests.findIndex((r) => r.id === request.id);
  if (i < 0) throw new AppError(404, `No request ${request.id}`);
  requests[i] = structuredClone(request);
  const all = accessStepsFixture.rows();
  for (const s of steps) {
    const j = all.findIndex((x) => x.requestId === s.requestId && x.step === s.step);
    if (j >= 0) all[j] = structuredClone(s);
  }
  appendEvents(request.id, actorId, events, at);
}

/** One request row by id (a copy), or null. */
export function findRequest(id: string): AccessRequestRow | null {
  store();
  const row = accessRequestsFixture.rows().find((r) => r.id === id);
  return row ? structuredClone(row) : null;
}

/**
 * Compare-and-set one request row: apply `patch` only while the stored row is
 * in one of `from` (and, with `warnedAtNull`, has not been warned yet), and
 * append `events` in the same step. Returns the stored row, or null when the
 * condition no longer holds — someone else moved it first. This is the claim
 * provisioning, revocation and the expiry warning each take, so a second
 * caller (another replica's sweep, a racing decision) does nothing twice.
 * On the cluster it is one `UPDATE … WHERE id = :id AND status = ANY(:from)
 * [AND expiry_warned_at IS NULL] RETURNING *` plus the event INSERTs in one
 * transaction (lane E); offline the check and the write share one tick.
 */
export function casRequest(
  id: string,
  when: { from: readonly AccessRequestRow['status'][]; warnedAtNull?: boolean },
  patch: Partial<Omit<AccessRequestRow, 'id'>>,
  events: readonly EventDraft[],
  actorId: string | null,
  at: string,
): AccessRequestRow | null {
  store();
  const row = accessRequestsFixture.rows().find((r) => r.id === id);
  if (!row || !when.from.includes(row.status)) return null;
  if (when.warnedAtNull && row.expiryWarnedAt !== null) return null;
  Object.assign(row, structuredClone(patch));
  appendEvents(id, actorId, events, at);
  return structuredClone(row);
}

/** Update a policy's severity / reason; returns the stored row or null when unknown. */
export function updatePolicy(id: string, patch: { severity?: AccessPolicyRow['severity']; reason?: string }, actorId: string): AccessPolicyRow | null {
  store();
  const row = accessPoliciesFixture.rows().find((p) => p.id === id);
  if (!row) return null;
  if (patch.severity) row.severity = patch.severity;
  if (patch.reason !== undefined) row.reason = patch.reason;
  row.updatedAt = clock.nowIso();
  row.updatedBy = actorId;
  return structuredClone(row);
}

/**
 * The live directory: current users and grants (authoritative — an identity
 * outage refuses rather than deciding against a stale fallback),
 * people.manager_id, and initiative owners / contributors.
 */
export async function loadDirectory(): Promise<AccessDirectory> {
  store();
  const users = (await listUsers({ authoritative: true })).map((u) => ({
    id: u.id, displayName: u.displayName, personId: u.personId ?? null, grants: structuredClone(u.grants),
  }));
  const managers = new Map(accessPeopleFixture.rows().map((p) => [p.id, p.managerId]));
  return {
    users,
    managerOf: (personId) => (personId ? managers.get(personId) ?? null : null),
    initiative: (projectId) => {
      const p = findInitiative(projectId);
      return p ? { ownerPersonId: p.owner, memberPersonIds: [p.owner, ...p.smes] } : null;
    },
  };
}
