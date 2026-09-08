// The sprint envelope an SME spends inside — read side.
//
// `GET /api/sprints/envelopes` answers "how much of my sprint envelope is
// left", which until now had no surface at all: the grants table lives on
// /admin/budgets behind ManageBudgets (the roles that ALLOCATE money), and what
// it reports is the INITIATIVE's spend in the window, not the caller's own
// burn. So the first an SME heard of their envelope was a 409 from
// `decideEnvelope` at dispatch time.
//
// Everything here is pure — see `__tests__/envelopeFormat.test.ts`. It lives in
// lib/ rather than pages/sprints/ because both consumers need it: the sprints
// lens (the standing "what's left" read) and the estimate/authorize drawer (the
// pre-flight, which has to predict the very 409 this closes).
//
// ── Unknown is not zero ──────────────────────────────────────────────────────
// `bot_runs.dispatched_by` is what a burn is summed from. On a cluster that
// predates that column the sum is meaningless, so the server sends
// `spentUsd`/`remainingUsd` as **null** with `attributionAvailable: false` —
// never 0, which would render as "$0.00 spent, full envelope" and is the one
// claim this data cannot support. Every predicate below therefore guards on the
// SHAPE of the number (`typeof … === 'number'`), not on the boolean beside it,
// and every unknown gets said in words.

// ─── Wire ────────────────────────────────────────────────────────────────────
//
// Asserted against a real dev:mock response, not typed from memory:
//   GET /api/sprints/envelopes as u-nora →
//   { personId: 'p-004', resolved: true, attributionAvailable: true,
//     note: 'counts only runs recorded as dispatched by you',
//     envelopes: [{ grantId: 'bg-auth-3', orgProjectId: 'p-auth-migration',
//       orgProjectName: 'Auth Migration', sprintId: 'spr-auth-s2',
//       sprintName: 'Sprint 42 — Session hygiene', sprintStatus: 'active',
//       startsOn: null, endsOn: null, allocatedUsd: 15, spentUsd: 0,
//       remainingUsd: 15, attributionAvailable: true }] }
//   as u-operator (no linked person) →
//   { personId: null, resolved: false, reason: '…not linked to a person…',
//     attributionAvailable: null, envelopes: [] }
// Note `startsOn`/`endsOn` really do come back null for a sprint-less standing
// grant, so nothing here may assume a window exists.

export interface EnvelopeRow {
  grantId: string;
  orgProjectId: string;
  orgProjectName: string | null;
  sprintId: string | null;
  sprintName: string | null;
  sprintStatus: string | null;
  startsOn: string | null;
  endsOn: string | null;
  allocatedUsd: number;
  /** Runs recorded as dispatched by THIS caller inside the window.
   *  Null when attribution is unavailable — unknown, never zero. */
  spentUsd: number | null;
  remainingUsd: number | null;
  attributionAvailable: boolean;
}

export interface EnvelopesResponse {
  personId: string | null;
  /** False when the account could not be resolved to an SME at all. That is a
   *  different state from "resolved, and you hold none" and gets its own copy. */
  resolved: boolean;
  /** Present only when `resolved` is false — the server's own explanation. */
  reason?: string;
  attributionAvailable: boolean | null;
  note?: string;
  envelopes: EnvelopeRow[];
}

// ─── Money ───────────────────────────────────────────────────────────────────

/** Matches the server's own `money()` in lib/bot-runner.ts, so the number in a
 *  409 and the number on the page are spelled the same way. */
export function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The shape guard, used everywhere instead of `attributionAvailable`: a row
 *  whose remaining is not a number cannot be reported as an amount, whatever
 *  the flag beside it says. */
export function hasKnownBurn(row: EnvelopeRow): boolean {
  return typeof row.remainingUsd === 'number' && typeof row.spentUsd === 'number';
}

/**
 * What `decideEnvelope` actually compares a forecast against — the SAME branch
 * the brake takes, so the page and the 409 cannot disagree:
 *   attribution available → allocated − spent (what is left)
 *   attribution absent    → the envelope's full size (the only honest ceiling)
 */
export function envelopeCeilingUsd(row: EnvelopeRow): number {
  return hasKnownBurn(row) ? row.remainingUsd! : row.allocatedUsd;
}

/** "$15.00", or the words for an unknown burn. Never "$0.00". */
export function remainingLabel(row: EnvelopeRow): string {
  return hasKnownBurn(row) ? usd(row.remainingUsd!) : 'not attributed';
}

export function spentLabel(row: EnvelopeRow): string {
  return hasKnownBurn(row) ? usd(row.spentUsd!) : 'not attributed';
}

// ─── Naming one envelope ─────────────────────────────────────────────────────

/** "Auth Migration · Sprint 42 — Session hygiene", degrading to whichever half
 *  the row actually carries (a standing grant has no sprint at all). */
export function envelopeScopeLabel(row: EnvelopeRow): string {
  const initiative = row.orgProjectName ?? row.orgProjectId;
  return row.sprintName ? `${initiative} · ${row.sprintName}` : initiative;
}

/**
 * The burn window. Two different things come back dateless and they must not
 * read the same: a grant with no sprint at all is a STANDING grant and its
 * window is genuinely unbounded, while a grant that names a sprint carrying no
 * dates is a sprint whose window was never filled in. Calling the second one a
 * standing grant is a lie the seed data will tell you every time.
 */
export function envelopeWindowLabel(row: EnvelopeRow): string {
  if (!row.startsOn && !row.endsOn) {
    return row.sprintId ? 'no dates on this sprint' : 'standing grant — no window';
  }
  const day = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  return `${day(row.startsOn)} → ${day(row.endsOn)}`;
}

// ─── The headline, for the sprints lens ──────────────────────────────────────

export type EnvelopeSummaryKind =
  /** The read is still in flight. */
  | 'loading'
  /** The read itself failed — not a statement about money. */
  | 'error'
  /** `resolved: false`: this account is not an SME the grants table knows. */
  | 'unresolved'
  /** Resolved, and holds no active grant. NOT "$0 envelope". */
  | 'none'
  /** Envelopes, with a burn we can stand behind. */
  | 'known'
  /** Envelopes, but at least one burn is unattributed — so the total left is
   *  unknown, and saying any number would be inventing one. */
  | 'unknown-burn';

export interface EnvelopeSummary {
  kind: EnvelopeSummaryKind;
  /** Tile value. Words, not a number, whenever the number would be a guess. */
  value: string;
  hint: string;
  tone?: 'danger' | 'accent';
  /** How many envelopes are behind the headline — the breakdown's row count. */
  count: number;
  /** Whether there is a per-envelope breakdown worth opening. */
  openable: boolean;
}

export interface EnvelopeSummaryInput {
  data: EnvelopesResponse | null;
  isLoading: boolean;
  error: string | null;
  /** Only a caller who can dispatch is ever braked by an envelope. */
  canDispatch: boolean;
  /** Grant-scoping applies to `sme` alone (decideGrantScopedDispatch): for
   *  every other role "no grant" means "no brake", not "you are blocked". */
  role: string | undefined;
}

/**
 * The one tile the sprints lens shows. Returns null when this reader has no
 * envelope story at all — a member cannot dispatch, and a release manager with
 * no grant is not braked by one, so a tile reading "none" would be noise
 * dressed as an alarm.
 */
export function summarizeEnvelopes(input: EnvelopeSummaryInput): EnvelopeSummary | null {
  const { data, isLoading, error, canDispatch, role } = input;
  if (!canDispatch) return null;

  if (error) {
    return {
      kind: 'error', value: 'unavailable', count: 0, openable: false,
      hint: `your envelopes could not be read (${error})`,
    };
  }
  if (isLoading || !data) {
    return { kind: 'loading', value: '…', hint: 'reading your envelopes', count: 0, openable: false };
  }

  if (!data.resolved) {
    // Openable: the reason is a sentence, and a tile hint is one clipped line.
    // The breakdown behind it is where a sentence fits.
    return {
      kind: 'unresolved', value: 'unknown', count: 0, openable: true,
      hint: data.reason ?? 'your sprint envelopes could not be resolved',
    };
  }

  const rows = data.envelopes;
  if (rows.length === 0) {
    // Only an `sme` is refused for holding no grant; everyone else who can
    // dispatch simply has no envelope in the way.
    if (role !== 'sme') return null;
    // The hint is one clipped line — "…until a release manager grants one" was
    // cut off mid-word at tile width. The consequence (dispatch is refused, and
    // who to ask) is a sentence, so it lives in the breakdown behind the tile.
    return {
      kind: 'none', value: 'none', count: 0, openable: true, tone: 'danger',
      hint: 'no active sprint grant',
    };
  }

  const granted = rows.reduce((sum, r) => sum + r.allocatedUsd, 0);
  // A tile hint is one clipped line wide, so a single envelope is named by its
  // INITIATIVE — the thing a grant is keyed on and the thing a dispatch is
  // charged to. The sprint and its window are in the breakdown behind it;
  // spelling both here only pushed the useful half past the ellipsis.
  const scope = rows.length === 1
    ? (rows[0]!.orgProjectName ?? rows[0]!.orgProjectId)
    : `across ${rows.length} sprint envelopes`;

  // One unattributed row poisons the total: a sum that silently treats an
  // unknown burn as zero is exactly the "$0.00 spent" this must never print.
  if (!rows.every(hasKnownBurn)) {
    return {
      kind: 'unknown-burn', value: 'unknown', count: rows.length, openable: true,
      hint: `${usd(granted)} granted ${rows.length === 1 ? `on ${scope}` : scope} — burn not attributed`,
    };
  }

  const remaining = rows.reduce((sum, r) => sum + (r.remainingUsd ?? 0), 0);
  return {
    kind: 'known',
    value: usd(remaining),
    count: rows.length,
    openable: true,
    ...(remaining <= 0 ? { tone: 'danger' as const } : {}),
    hint: `of ${usd(granted)} ${rows.length === 1 ? `on ${scope}` : scope}`,
  };
}

// ─── The pre-flight, for the estimate/authorize drawer ───────────────────────

export interface ForecastRange {
  costUsdP25: number;
  costUsdP75: number;
}

export type EnvelopePreflightKind =
  /** The envelopes read did not resolve. We do NOT know whether a grant exists,
   *  so this must never be reported as "you hold none". */
  | 'unresolved'
  /** `sme` with no grant here — `decideGrantScopedDispatch` will answer 403,
   *  and that one is NOT confirmable. Worth saying before they fill the form. */
  | 'no-grant'
  /** An envelope, and the forecast fits what the brake will compare it to. */
  | 'fits'
  /** An envelope, and the forecast does not fit — the 409 is coming. */
  | 'over'
  /** An envelope whose burn is unattributed; the only claim available is
   *  forecast-vs-size. */
  | 'unknown-burn'
  /** Same, and the forecast does not even fit the envelope's full size. */
  | 'unknown-burn-over';

export interface EnvelopePreflight {
  kind: EnvelopePreflightKind;
  tone: 'info' | 'warning';
  title: string;
  body: string;
  /** One line, terse enough to append to the authorize confirmation. */
  confirmLine: string;
}

export interface EnvelopePreflightInput {
  /** The whole read, not a pre-picked row: "unresolved" and "resolved, and you
   *  hold none here" are different answers and only the response can tell them
   *  apart. */
  data: EnvelopesResponse | null;
  /** The initiative this dispatch would be charged to. Null while the host page
   *  has not resolved it — say nothing rather than match the wrong envelope. */
  orgProjectId: string | null;
  /** The live forecast, when one has come back. Null is normal — a run can be
   *  authorized before an estimate resolves, and the envelope is still worth
   *  reporting without one. */
  forecast: ForecastRange | null;
  role: string | undefined;
}

/**
 * What to tell the operator BEFORE they authorize. Mirrors `decideEnvelope`'s
 * own branches (attribution present → remaining; absent → the envelope's full
 * size) so a "fits" here is not contradicted by a 409 a second later.
 *
 * Returns null when there is nothing to say: a role that is not grant-scoped
 * and holds no envelope here is braked by neither gate.
 */
export function preflightEnvelope(input: EnvelopePreflightInput): EnvelopePreflight | null {
  const { data, orgProjectId, forecast, role } = input;
  if (!data || !orgProjectId) return null;

  if (!data.resolved) {
    // No grant was found because nothing could be looked up. Reporting that as
    // "you hold no grant" would invent a denial; reporting a number would
    // invent money. Say which one it is.
    const reason = data.reason ?? 'your sprint envelopes could not be read just now';
    return {
      kind: 'unresolved', tone: 'info',
      title: 'Sprint envelope unknown',
      body: `${reason[0]!.toUpperCase()}${reason.slice(1)}. Whether an envelope brakes this run `
        + 'cannot be read from here — the gate itself still applies at dispatch.',
      confirmLine: 'Your sprint envelope could not be read, so what is left of it is unknown.',
    };
  }

  const row = envelopeForInitiative(data, orgProjectId);

  if (!row) {
    if (role !== 'sme') return null;
    return {
      kind: 'no-grant',
      tone: 'warning',
      title: 'No sprint grant on this initiative',
      body: 'You hold no active sprint grant here, so this dispatch will be refused. '
        + 'That refusal is not a money brake and cannot be confirmed through — ask the '
        + 'release manager for a grant on this initiative.',
      confirmLine: 'You hold no active sprint grant on this initiative — the dispatch will be refused.',
    };
  }

  const where = row.sprintName
    ? `your ${usd(row.allocatedUsd)} envelope on ${row.sprintName}`
    : `your ${usd(row.allocatedUsd)} sprint envelope`;
  const ceiling = envelopeCeilingUsd(row);
  const over = forecast != null && forecast.costUsdP75 > ceiling;
  const range = forecast ? `${usd(forecast.costUsdP25)}–${usd(forecast.costUsdP75)}` : null;

  if (!hasKnownBurn(row)) {
    // No ledger exists, so the only comparison available is against the
    // envelope's full size. Saying "$30.00 left" here would be a fabrication.
    const body = `${where[0]!.toUpperCase()}${where.slice(1)}. This cluster does not record who `
      + 'dispatched a run, so your burn against it is unknown, not zero — the only thing that '
      + `can be compared is a forecast against the envelope's full size.`;
    if (over) {
      return {
        kind: 'unknown-burn-over', tone: 'warning',
        title: 'Forecast is over your whole envelope',
        body: `${body} This run is forecast at ${range}, which does not fit it at all — you will be asked to confirm.`,
        confirmLine: `Forecast ${range} does not fit ${where}, and your burn against it is not attributed — expect a confirmation.`,
      };
    }
    return {
      kind: 'unknown-burn', tone: 'info',
      title: 'Sprint envelope — burn not attributed',
      body: range ? `${body} This run is forecast at ${range}.` : body,
      confirmLine: `${where[0]!.toUpperCase()}${where.slice(1)}; your burn against it is not attributed, so what is left is unknown.`,
    };
  }

  const left = `${usd(row.remainingUsd!)} left of ${where}`;
  const ledger = `${usd(row.spentUsd!)} of ${where} is recorded as spent by you, leaving `
    + `${usd(row.remainingUsd!)}. That counts only runs recorded as dispatched by you.`;

  if (over) {
    return {
      kind: 'over', tone: 'warning',
      title: 'This run is over what is left of your envelope',
      body: `${ledger} This run is forecast at ${range}, which is over the ${usd(row.remainingUsd!)} left — `
        + 'you will be asked to confirm before it starts.',
      confirmLine: `Only ${left} — the ${range} forecast is over it, so you will be asked to confirm.`,
    };
  }
  return {
    kind: 'fits', tone: 'info',
    title: 'Sprint envelope',
    body: range ? `${ledger} This run is forecast at ${range}, which fits.` : ledger,
    confirmLine: range ? `${left}; this run is forecast at ${range}.` : `${left}.`,
  };
}

/** The caller's active envelope on one initiative, or null. Matching on
 *  `orgProjectId` is what the brake keys on too — never the sprint, since a
 *  standing grant has no sprint id at all. */
export function envelopeForInitiative(
  data: EnvelopesResponse | null,
  orgProjectId: string | null,
): EnvelopeRow | null {
  if (!data || !data.resolved || !orgProjectId) return null;
  return data.envelopes.find((e) => e.orgProjectId === orgProjectId) ?? null;
}
