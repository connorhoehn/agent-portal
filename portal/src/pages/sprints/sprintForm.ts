// Pure helpers for the sprint-mutation and grant-management controls.
//
// Kept out of the .tsx so the URL building and the client-side validation can
// be unit-tested under node:test (see __tests__/sprintForm.test.ts) without a
// DOM. The server re-validates everything — these checks only spare the user a
// round-trip for the obvious mistakes and surface the same rules the API
// enforces (dates YYYY-MM-DD, endsOn after startsOn, status in the set,
// amount a positive number).

export const SPRINT_STATUSES = ['planned', 'active', 'done'] as const;
export type SprintStatus = (typeof SPRINT_STATUSES)[number];

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// ─── URL builders (the /api/sprints + /api/grants contracts) ─────────────────

/** `GET /api/grants?sprintId=` — grants scoped to one sprint. */
export function grantsUrl(sprintId: string): string {
  return `/api/grants?sprintId=${encodeURIComponent(sprintId)}`;
}

/** `PATCH /api/sprints/:sprintId/items` — move an item INTO the sprint. */
export function sprintItemsUrl(sprintId: string): string {
  return `/api/sprints/${encodeURIComponent(sprintId)}/items`;
}

/** `DELETE /api/sprints/:sprintId/items/:itemId` — move an item OUT. */
export function sprintItemUrl(sprintId: string, itemId: string): string {
  return `/api/sprints/${encodeURIComponent(sprintId)}/items/${encodeURIComponent(itemId)}`;
}

/** `PATCH|DELETE /api/grants/:id`. */
export function grantUrl(id: string): string {
  return `/api/grants/${encodeURIComponent(id)}`;
}

// ─── Date validation ─────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True iff `s` is a real calendar date written `YYYY-MM-DD`. The regex alone
 * would pass `2026-02-30`; parsing as UTC and re-serialising rejects the
 * roll-over, so the picker and the API agree on what a valid date is.
 */
export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

// ─── New-sprint form ─────────────────────────────────────────────────────────

export interface NewSprintForm {
  initiativeId: string;
  name: string;
  startsOn: string;
  endsOn: string;
  stewardPersonId?: string;
  goal?: string;
  status: string;
}

/** The exact body `POST /api/sprints` accepts — optional fields omitted, not
 *  sent as empty strings, so the server's defaults apply. */
export interface NewSprintBody {
  initiativeId: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: SprintStatus;
  stewardPersonId?: string;
  goal?: string;
}

export function validateNewSprint(form: NewSprintForm): Validated<NewSprintBody> {
  const initiativeId = form.initiativeId.trim();
  if (!initiativeId) return { ok: false, error: 'Pick the initiative this sprint belongs to.' };

  const name = form.name.trim();
  if (!name) return { ok: false, error: 'Give the sprint a name.' };

  if (!isIsoDate(form.startsOn)) return { ok: false, error: 'Start date must be a real YYYY-MM-DD date.' };
  if (!isIsoDate(form.endsOn)) return { ok: false, error: 'End date must be a real YYYY-MM-DD date.' };
  // Both are validated calendar dates, so a lexicographic compare is a date
  // compare — no timezone shift to worry about.
  if (!(form.endsOn > form.startsOn)) return { ok: false, error: 'End date must be after the start date.' };

  const status = form.status.trim() || 'planned';
  if (!(SPRINT_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: 'Status must be planned, active, or done.' };
  }

  const body: NewSprintBody = {
    initiativeId, name, startsOn: form.startsOn, endsOn: form.endsOn, status: status as SprintStatus,
  };
  const steward = form.stewardPersonId?.trim();
  if (steward) body.stewardPersonId = steward;
  const goal = form.goal?.trim();
  if (goal) body.goal = goal;
  return { ok: true, value: body };
}

// ─── Grant amount ────────────────────────────────────────────────────────────

/**
 * Parse a dollar amount from a text field. The API takes `amountUsd` as a
 * finite number >= 0; the UI is stricter — creating a $0 envelope is a mistake
 * to catch before it is written. But zeroing an EXISTING envelope (freeze the
 * spend without losing the row and its history) is a legitimate edit the
 * backend accepts, so the edit path passes `allowZero`. Result is rounded to
 * whole cents.
 */
export function validateGrantAmount(
  raw: string,
  opts?: { allowZero?: boolean },
): Validated<number> {
  const t = raw.trim();
  if (!t) return { ok: false, error: 'Enter an amount in dollars.' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, error: 'Amount must be a number.' };
  if (opts?.allowZero) {
    if (n < 0) return { ok: false, error: 'Amount cannot be negative.' };
  } else if (n <= 0) {
    return { ok: false, error: 'Amount must be greater than zero.' };
  }
  return { ok: true, value: Math.round(n * 100) / 100 };
}
