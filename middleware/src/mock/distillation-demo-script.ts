// The Distillation demo's script — what gets written, by whom, and when.
//
// Pure data plus one pace knob. The director (mock/distillation-demo.ts) plays
// it; mock/distillation.ts reads `demoIngestWriters` for the demo world's
// write stream. Nothing here imports the provider, so the fixture module can
// import this file without a cycle.
//
// THE STORY. Three lab sessions on Auth Migration (p-auth-migration, repo
// orgiq-auth-service) — the same three agents and work items the Computer Lab
// demo dispatches (mock/demo-director.ts): Ada on wi-auth-e2-b3 "Logout leaves
// the legacy shim cookie alive", Basil on wi-auth-e2-s2 "Tenant-by-tenant
// cutover runbook with rollback", Cleo on wi-auth-e1-b4 "Refresh loop when a
// grant is revoked mid-session". Their run notes arrive one at a time, mixed
// with three notes from unrelated sessions in other repos (L0 is a shared write
// head). One of Cleo's notes is a bad lesson — retrying the 403 that caused the
// loop — which a reviewer rejects before it can reach a guide.
//
// THE SHAPE IS LOAD-BEARING. The L0 → L1 pass groups a batch by (repo, kind),
// and the L1 → L2 pass orders a procedure's steps by when each action-kind
// note was written (providers/distillation.ts runL1Compaction /
// mintProcedureFacts). So the order and kinds below decide the patterns and
// the guide's steps:
//
//   decision ×2  → pattern "Cut over the smallest tenant first …" (first written,
//                  so it is the first pattern and names the guide)
//   gotcha   ×3  → pattern "Logout ended the Cognito session …"   (the guide's "why")
//   worked   ×3  → pattern "Clear the shim cookie …"
//   convention ×1 → pattern "Retry a 403 … three times …"          (rejected in review)
//
// and the guide's five steps, in write order: D1, W1, W2, W3, D2.

import type { IngestWriter, ObservationKind, ReviewVerdict } from './distillation.js';

// ─── Pace ───────────────────────────────────────────────────────────────────

/** Per-start knobs (`POST /api/__mock/scenario {"scenario":"distillation-demo",
 *  "paceMs":…, "autoDecideBeats":…}`), so an e2e can play the story fast
 *  against a running server. Each falls back to its env when absent. */
export interface DistillDemoOverrides { paceMs?: number; autoDecideBeats?: number }
let overrides: DistillDemoOverrides = {};
export function setDistillDemoOverrides(next: DistillDemoOverrides): void { overrides = { ...next }; }

/**
 * One beat of the story, in ms. `DISTILL_DEMO_PACE_MS` stretches or squeezes
 * the whole thing; default 2500 (the story runs about three minutes), 0 under
 * jest unless a test sets it. Read on every call so a test can change it.
 */
export function distillDemoBeatMs(): number {
  if (overrides.paceMs !== undefined) return overrides.paceMs;
  const raw = process.env['DISTILL_DEMO_PACE_MS'];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return process.env['NODE_ENV'] === 'test' ? 0 : 2_500;
}

/** How long the director waits for a person to decide the pattern it leaves
 *  open before deciding it itself. `0` means only a person may decide it. */
export function distillDemoPatienceBeats(): number {
  if (overrides.autoDecideBeats !== undefined) return overrides.autoDecideBeats;
  const raw = Number(process.env['DISTILL_DEMO_AUTO_DECIDE_BEATS'] ?? 16);
  return Number.isFinite(raw) && raw >= 0 ? raw : 16;
}

// ─── The cast ───────────────────────────────────────────────────────────────

export const AUTH_REPO = 'connorhoehnslalom/orgiq-auth-service';
const AUTH_INITIATIVE = 'p-auth-migration';

/** The people the director acts as. Names, not ids: `requested_by`, `reviewer`
 *  and the publish attribution are display names everywhere in this domain
 *  (routes/distillation.ts passes `session.name`). All three hold ManageBots
 *  in the seed roles (org-leader / sme). */
export const PEOPLE = {
  nora: 'Nora DaSilva', // sme on Auth Migration — requests the passes and samples
  vera: 'Vera Green',   // org-leader, owner of Auth Migration — reviews and publishes
  eli: 'Eli Garcia',    // sme — reviews
} as const;

export type DemoWriterKey = 'ada' | 'basil' | 'cleo' | 'obs' | 'llm' | 'cost';

interface DemoWriterSpec {
  key: DemoWriterKey;
  /** Narrative name; never on the wire — sessions are ids. */
  agent: string;
  session_id: string;
  box_id: string;
  repo: string;
  initiative_id: string;
}

export const DEMO_WRITERS: Record<DemoWriterKey, DemoWriterSpec> = {
  ada:   { key: 'ada',   agent: 'Ada',   session_id: 'sess-auth-07', box_id: 'box-auth-07', repo: AUTH_REPO, initiative_id: AUTH_INITIATIVE },
  basil: { key: 'basil', agent: 'Basil', session_id: 'sess-auth-08', box_id: 'box-auth-08', repo: AUTH_REPO, initiative_id: AUTH_INITIATIVE },
  cleo:  { key: 'cleo',  agent: 'Cleo',  session_id: 'sess-auth-09', box_id: 'box-auth-09', repo: AUTH_REPO, initiative_id: AUTH_INITIATIVE },
  obs:   { key: 'obs',   agent: 'an observability session', session_id: 'sess-obs-08', box_id: 'box-obs-08', repo: 'connorhoehnslalom/orgiq-observability', initiative_id: 'p-observability' },
  llm:   { key: 'llm',   agent: 'an LLM-platform session',  session_id: 'sess-llm-06', box_id: 'box-llm-06', repo: 'connorhoehnslalom/orgiq-llm-platform', initiative_id: 'p-llm-platform' },
  cost:  { key: 'cost',  agent: 'a FinOps session',         session_id: 'sess-cost-06', box_id: 'box-cost-06', repo: 'connorhoehnslalom/orgiq-finops', initiative_id: 'p-cost-opt' },
};

// ─── Act 1: the run notes ───────────────────────────────────────────────────

export type PatternRole = 'decision' | 'gotcha' | 'worked' | 'convention';

export interface DemoNote {
  /** Positional and stable across runs, so a test (and a journey log) can name it. */
  id: string;
  writer: DemoWriterKey;
  kind: ObservationKind;
  title: string;
  body: string;
  tags: string[];
  /** Beats to wait before writing this note. */
  gapBeats: number;
  /** In the Auth Migration story (and so in the scoped L0 → L1 pass)? The
   *  other repos' notes stay in L0 for their own passes. */
  story: boolean;
}

export const DEMO_NOTES: readonly DemoNote[] = [
  { id: 'obs-d01', writer: 'basil', kind: 'decision', story: true, gapBeats: 2,
    title: 'Cut over the smallest tenant first — one tenant a day',
    body: 'Asked on wi-auth-e2-s2 whether to start with the riskiest tenant. Nora DaSilva answered: smallest first, one tenant a day, so a bad cutover touches the fewest people.',
    tags: ['auth', 'migration', 'cutover'] },
  { id: 'obs-d02', writer: 'ada', kind: 'gotcha', story: true, gapBeats: 2,
    title: 'Logout ended the Cognito session but left the legacy shim cookie alive',
    body: 'Reproducing wi-auth-e2-b3: after logout the SAML shim’s own cookie still authenticated the next request, so a signed-out user could reach shim-served pages until it expired.',
    tags: ['auth', 'logout', 'session'] },
  { id: 'obs-d03', writer: 'obs', kind: 'gotcha', story: false, gapBeats: 2,
    title: 'A rescheduled collector pod drops the batch it was holding',
    body: 'When Fargate moved a gateway collector to another host, the spans buffered in its batch queue were lost; a graceful-drain hook on SIGTERM flushes them first.',
    tags: ['otel', 'gotcha'] },
  { id: 'obs-d04', writer: 'cleo', kind: 'gotcha', story: true, gapBeats: 2,
    title: 'A revoked grant sends the client into a refresh loop',
    body: 'Reproducing wi-auth-e1-b4: when a grant is revoked mid-session the token endpoint answers 403, the client treats it as retryable, and it refreshes in a tight loop until the tab is closed.',
    tags: ['auth', 'session', 'refresh'] },
  { id: 'obs-d05', writer: 'ada', kind: 'worked', story: true, gapBeats: 2,
    title: 'Clear the shim cookie in the same logout response that ends the Cognito session',
    body: 'Expiring the legacy cookie (Max-Age=0, same path and domain) alongside the Cognito sign-out closed wi-auth-e2-b3: the next request after logout is anonymous on both paths.',
    tags: ['auth', 'logout', 'session'] },
  { id: 'obs-d06', writer: 'cleo', kind: 'convention', story: true, gapBeats: 2,
    title: 'Retry a 403 from the token endpoint three times before signing the user out',
    body: 'First attempt at wi-auth-e1-b4: bound the refresh loop at three retries with backoff, then sign the user out.',
    tags: ['auth', 'refresh'] },
  { id: 'obs-d07', writer: 'llm', kind: 'decision', story: false, gapBeats: 2,
    title: 'Pin the judge model version in judge_config instead of following the latest',
    body: 'A model update moved judge scores overnight with no prompt change; pinning the version in the SSM judge_config makes a score change mean the answers changed.',
    tags: ['llm', 'canary', 'decision'] },
  { id: 'obs-d08', writer: 'cleo', kind: 'worked', story: true, gapBeats: 2,
    title: 'Answer a revoked grant with a terminal 401 so the client stops refreshing',
    body: 'The server now returns 401 with reason grant_revoked and the client signs out on that reason instead of retrying. The loop in wi-auth-e1-b4 is gone, and the three-retry bound is no longer needed.',
    tags: ['auth', 'session', 'refresh'] },
  { id: 'obs-d09', writer: 'basil', kind: 'gotcha', story: true, gapBeats: 2,
    title: 'The hosted-UI redirect still pointed at the old domain after the tenant’s flag flipped',
    body: 'Pilot cutover on the smallest tenant: the flag flipped, but the tenant’s Cognito app client still listed the legacy callback, so sign-in bounced to the old service.',
    tags: ['auth', 'cognito', 'cutover'] },
  { id: 'obs-d10', writer: 'basil', kind: 'worked', story: true, gapBeats: 2,
    title: 'Point the tenant’s hosted-UI redirect at the Cognito domain before flipping its flag',
    body: 'Updating the tenant’s app-client callback list first, then flipping the flag, let the pilot tenant sign in on the first try with no forced logouts.',
    tags: ['auth', 'cognito', 'cutover'] },
  { id: 'obs-d11', writer: 'cost', kind: 'worked', story: false, gapBeats: 2,
    title: 'Reaping idle lab sessions at 20 minutes halved the overnight devbox spend',
    body: 'The reaper’s idle timeout stopped sessions that sat waiting overnight; the next morning’s showback line for the lab dropped by half.',
    tags: ['finops', 'devbox'] },
  { id: 'obs-d12', writer: 'basil', kind: 'decision', story: true, gapBeats: 2,
    title: 'Keep the SAML shim behind the per-tenant flag until the last tenant is over',
    body: 'Flipping a tenant back is a five-minute rollback only while the shim still runs, so it is deleted after the last cutover, not tenant by tenant.',
    tags: ['auth', 'migration', 'rollback'] },
];

/** The note the guide's first real use leaves behind — Act 5. */
export const CLOSING_NOTE: DemoNote = {
  id: 'obs-d13', writer: 'basil', kind: 'worked', story: false, gapBeats: 2,
  title: 'Second tenant cut over by following the guide — no forced logouts',
  body: 'Ran “Cut over the smallest tenant first” end to end on the next-smallest tenant: callback list updated before the flip, the shim kept behind the flag, no session forced out.',
  tags: ['auth', 'migration', 'cutover'],
};

/** Which pattern each kind becomes (one batch, one repo → one pattern per kind). */
export const ROLE_OF_KIND: Partial<Record<ObservationKind, PatternRole>> = {
  decision: 'decision', gotcha: 'gotcha', worked: 'worked', convention: 'convention',
};

// ─── Act 3: the review ──────────────────────────────────────────────────────

export interface ScriptedVerdict {
  role: PatternRole;
  reviewer: string;
  verdict: Exclude<ReviewVerdict, 'pending'>;
  note: string;
  /** Beats after the samples are drawn (or after the previous verdict). */
  gapBeats: number;
}

/** Decided by the director in this order. `worked` is NOT here: it is left
 *  for the viewer, and decided as the fallback below only if nobody does. */
export const SCRIPTED_VERDICTS: readonly ScriptedVerdict[] = [
  { role: 'gotcha', reviewer: PEOPLE.eli, verdict: 'agree', gapBeats: 4,
    note: 'All three bit the pilot cutover. The redirect one is what stopped the earlier cutover draft at its third step.' },
  { role: 'decision', reviewer: PEOPLE.vera, verdict: 'agree', gapBeats: 4,
    note: 'This is the cutover order we settled on: smallest tenant first, one a day, shim kept until the end.' },
  { role: 'convention', reviewer: PEOPLE.vera, verdict: 'disagree', gapBeats: 4,
    note: 'This retry is what caused the refresh loop. A revoked grant has to end the session, not be retried — the terminal-401 note is the real fix.' },
];

/** The open pattern's fallback verdict, if nobody decides it in time. */
export const FALLBACK_VERDICT: ScriptedVerdict = {
  role: 'worked', reviewer: PEOPLE.nora, verdict: 'agree', gapBeats: 0,
  note: 'Each fix is merged in orgiq-auth-service and covered by a test.',
};

/** Vera's review of the guide itself, before she publishes it. */
export const GUIDE_VERDICT = {
  reviewer: PEOPLE.vera,
  note: 'The steps are in the order we ran the pilot, and the redirect step closes the gap the earlier draft failed on.',
} as const;

// ─── Act 4–5: publish and use ───────────────────────────────────────────────

/** The plain-language line Vera writes as she publishes — nothing in the
 *  machine writes plain language, so a person does it at the moment a guide
 *  is released (providers/distillation.ts publishArtifact). */
export const GUIDE_WHEN_THIS_HELPS =
  'Moving a customer’s sign-in from the old SAML service to Cognito? Follow these steps one customer at a time so nobody is signed out mid-day and you can switch back if sign-in misbehaves.\n' +
  'It comes from three agent sessions on Auth Migration this week, and people checked each pattern before it was published.';

/** What the agent's run of the guide records. */
export const APPLICATION_NOTE = 'Second-smallest tenant cut over by following the guide end to end; no forced logouts.';

// ─── The demo world's write stream ──────────────────────────────────────────

/** Act 1's length in beats — the window the writers' rates are measured over. */
export function act1Beats(): number {
  return DEMO_NOTES.reduce((sum, n) => sum + n.gapBeats, 0);
}

/**
 * The `distillation-demo` world's ingest writers: the six sessions the script
 * writes as. Each writer's `observationsPerHour` is COUNTED from the script —
 * its notes over Act 1's length at the configured pace — never typed, so the
 * Overview's rate is the rate the viewer is about to watch. `writes` is the
 * writer's first note: the type requires a template, and in this world the
 * simulated ingest is off (the director is the write stream), so it is only
 * ever read as "what this session is writing".
 */
export function demoIngestWriters(): IngestWriter[] {
  const beat = distillDemoBeatMs() || 2_500;
  const windowMs = act1Beats() * beat;
  return (Object.values(DEMO_WRITERS)).map((w) => {
    const notes = DEMO_NOTES.filter((n) => n.writer === w.key);
    const first = notes[0]!;
    return {
      id: `wr-demo-${w.key}`,
      session_id: w.session_id,
      box_id: w.box_id,
      repo: w.repo,
      initiative_id: w.initiative_id,
      observationsPerHour: Math.round((notes.length * 3_600_000) / windowMs),
      writes: { kind: first.kind, title: first.title, body: first.body, tags: [...first.tags] },
    };
  });
}
