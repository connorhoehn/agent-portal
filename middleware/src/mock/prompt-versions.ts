// The prompt registry — `observability.prompt_versions`, offline.
//
// The harness runner POSTs an agent's system prompt at the start of every run;
// the registry content-addresses it to a 12-hex short SHA and every trace that
// run produces is stamped with that SHA. Two surfaces read the registry back:
// the portal's PromptVersionChip resolves `p:8a7f3e2c` on a trace to the
// canonical text, and the promote list (`/harness/promoted-versions`) shows
// which of those SHAs a human blessed.
//
// Both of those GETs went straight to `exec()` with no mock branch, so both
// 500'd in dev:mock: the chip's modal read "failed to load" for every trace
// and the promote list was unauditable offline.
//
// WHAT IS NOT STORED. `promptVersion` and `contentSha256` are the SHA-256 of
// `content` — the registry's whole premise is that they are derived, and a
// stored digest that disagrees with the text beside it is the same class of
// bug as a stored count that disagrees with its rows (contract.ts rule 1).
// So a seed row carries the text; the two SHAs are computed at read time by
// the same `shortHash`/`fullSha256` the real POST handler uses, which is also
// what makes a mock-registered prompt look up correctly by its own id.

import { clock, defineFixture } from './core/index.js';
import { fullSha256, shortHash } from '../lib/pricing.js';

/** A registry row as the seed carries it — text, not digests. */
export interface PromptVersionSeed {
  agentId: string;
  content: string;
  notes: string | null;
  registeredAt: string;
  /** Null until a human promotes this SHA; the promote list filters on it. */
  promotedAt: string | null;
  promotedBy: string | null;
  promoteNotes: string | null;
}

/** The wire shape `GET /api/observability/prompt-versions` returns. */
export interface PromptVersionRow {
  promptVersion: string;
  agentId: string;
  content: string;
  contentSha256: string;
  registeredAt: string;
  notes: string | null;
}

/** The wire shape `GET /api/observability/harness/promoted-versions` returns. */
export interface PromotedPromptVersionRow extends PromptVersionRow {
  promotedAt: string;
  promotedBy: string | null;
  promoteNotes: string | null;
}

/**
 * The registry.
 *
 * `default` — four agents, six revisions, two of them promoted and one of
 *             those superseded by a newer unpromoted revision. That last case
 *             is the only one that makes the promote list worth reading: a
 *             registry where the newest row is always the promoted one cannot
 *             show the drift the page exists to show.
 * `empty`   — nothing registered yet. Declared explicitly, because an
 *             undeclared scenario falls back to `default` and "empty" would
 *             quietly still have six rows. This is the state before the first
 *             harness run, and it is what the chip's `—` fallback is for.
 */
export const promptVersions = defineFixture<PromptVersionSeed>({
  key: 'prompt-versions',
  scenarios: {
    default: () => [
      {
        agentId: 'orgiq-supervisor',
        content:
          'You are the OrgIQ supervisor. Read the question, decide which specialist agent ' +
          '(search, scoring, advisor, ingestion, graph-builder) should answer it, invoke that ' +
          'agent, and compose a single grounded answer with citations.',
        notes: 'Baseline — the prompt the fleet shipped with.',
        registeredAt: clock.daysAgo(24),
        promotedAt: clock.daysAgo(23),
        promotedBy: 'operator@orgiq.example',
        promoteNotes: 'Baseline for the first canary comparison.',
      },
      {
        agentId: 'orgiq-supervisor',
        content:
          'You are the OrgIQ supervisor. Read the question, decide which specialist agent ' +
          '(search, scoring, advisor, ingestion, graph-builder) should answer it, invoke that ' +
          'agent, and compose a single grounded answer with citations. Never answer from your ' +
          'own knowledge when a sub-agent could ground the claim.',
        notes: 'Adds the no-ungrounded-answer clause. Registered by the harness runner.',
        registeredAt: clock.daysAgo(5),
        promotedAt: null,
        promotedBy: null,
        promoteNotes: null,
      },
      {
        agentId: 'orgiq-search',
        content:
          'You are the OrgIQ search agent. Search the knowledge base and the Aurora org graph ' +
          'for people, skills, and decisions that answer the question. Always cite the document ' +
          'or graph node each claim came from.',
        notes: null,
        registeredAt: clock.daysAgo(19),
        promotedAt: clock.daysAgo(12),
        promotedBy: 'rachel.kowalski@orgiq.example',
        promoteNotes: 'Citation rate held at 1.0 across the regression set.',
      },
      {
        agentId: 'orgiq-scoring',
        content:
          'You are the OrgIQ scoring agent. Compute or explain the requested metric for the ' +
          'person or team named, using the graph tools available to you, and state which ' +
          'signals drove the number.',
        notes: null,
        registeredAt: clock.daysAgo(9),
        promotedAt: null,
        promotedBy: null,
        promoteNotes: null,
      },
      {
        agentId: 'orgiq-advisor',
        content:
          'You are the OrgIQ advisor agent. Analyze the org graph around the named initiative ' +
          'for bus-factor risk, knowledge gaps, or pairing opportunities, and recommend one ' +
          'concrete next step.',
        notes: null,
        registeredAt: clock.daysAgo(3),
        promotedAt: null,
        promotedBy: null,
        promoteNotes: null,
      },
      {
        agentId: 'orgiq-advisor',
        content:
          'You are the OrgIQ advisor agent. Analyze the org graph around the named initiative ' +
          'for bus-factor risk, knowledge gaps, or pairing opportunities, and recommend one ' +
          'concrete next step. Say who would have to be available for that step to happen.',
        notes: 'Registered by a harness run this morning; not promoted.',
        registeredAt: clock.hoursAgo(4, { keepWithinToday: true }),
        promotedAt: null,
        promotedBy: null,
        promoteNotes: null,
      },
    ],
    empty: () => [],
  },
});

function toRow(seed: PromptVersionSeed): PromptVersionRow {
  return {
    promptVersion: shortHash(seed.content),
    agentId: seed.agentId,
    content: seed.content,
    contentSha256: fullSha256(seed.content),
    registeredAt: seed.registeredAt,
    notes: seed.notes,
  };
}

/** Newest first. A missing stamp sorts last rather than becoming 1970. */
function newestFirst(a: string | null, b: string | null): number {
  const ta = a ? new Date(a).getTime() : Number.NEGATIVE_INFINITY;
  const tb = b ? new Date(b).getTime() : Number.NEGATIVE_INFINITY;
  return tb - ta;
}

/** `GET /` — newest first, same 200-row bound as the real query. */
export function mockListPromptVersions(limit = 200): PromptVersionRow[] {
  return promptVersions
    .rows()
    .slice()
    .sort((a, b) => newestFirst(a.registeredAt, b.registeredAt))
    .slice(0, limit)
    .map(toRow);
}

/** `GET /:promptVersion` — lookup by the short SHA of the content. */
export function mockGetPromptVersion(promptVersion: string): PromptVersionRow | null {
  const found = promptVersions.rows().find((r) => shortHash(r.content) === promptVersion);
  return found ? toRow(found) : null;
}

/** `GET /harness/promoted-versions` — `WHERE promoted_at IS NOT NULL`, newest promotion first. */
export function mockListPromotedVersions(limit = 200): PromotedPromptVersionRow[] {
  return promptVersions
    .rows()
    .filter((r): r is PromptVersionSeed & { promotedAt: string } => Boolean(r.promotedAt))
    .slice()
    .sort((a, b) => newestFirst(a.promotedAt, b.promotedAt))
    .slice(0, limit)
    .map((r) => ({
      ...toRow(r),
      promotedAt: r.promotedAt,
      promotedBy: r.promotedBy,
      promoteNotes: r.promoteNotes,
    }));
}

/**
 * The three answers `POST /harness/promote` can give, as data rather than as a
 * status code.
 *
 * The route owns the HTTP shape (404 for an unknown SHA, 409 for one that
 * belongs to another agent, 200 with the stamp otherwise). Returning a code
 * from here would put half the route's contract in the fixture, and the two
 * halves would drift the first time either moved.
 */
export type MockPromoteOutcome =
  | { ok: true; promotedAt: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'agent_mismatch'; expectedAgentId: string };

/**
 * `POST /harness/promote` — bless a registered SHA.
 *
 * Idempotent in the same way the real `UPDATE` is: re-promoting a row already
 * promoted refreshes `promoted_at` rather than refusing. The agent check is the
 * route's, mirrored here because the fixture is the only thing that knows which
 * agent owns a SHA offline — a mis-click promoting another agent's prompt is
 * the failure the check exists for, and a mock that let it through would make
 * the guard look absent exactly where it is most load-bearing.
 *
 * Note what is NOT stored: nothing recomputes `promptVersion`. It stays the
 * short SHA of `content` (see the header), so promoting cannot make a row's id
 * disagree with its own text.
 */
export function mockPromotePromptVersion(input: {
  promptVersion: string;
  agentId: string;
  promotedBy: string;
  notes: string | null;
}): MockPromoteOutcome {
  const row = promptVersions.rows().find((r) => shortHash(r.content) === input.promptVersion);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.agentId && row.agentId !== input.agentId) {
    return { ok: false, reason: 'agent_mismatch', expectedAgentId: row.agentId };
  }
  row.promotedAt = clock.nowIso();
  row.promotedBy = input.promotedBy;
  row.promoteNotes = input.notes;
  return { ok: true, promotedAt: row.promotedAt };
}

/**
 * `POST /` — the runner's idempotent register. `rows()` hands back the live
 * array, so a registration made in dev:mock is visible to the list and to the
 * chip's lookup for the rest of the process, exactly as the real UPSERT is.
 */
export function mockRegisterPromptVersion(input: {
  agentId: string;
  content: string;
  notes?: string | null;
}): string {
  const promptVersion = shortHash(input.content);
  const rows = promptVersions.rows();
  if (!rows.some((r) => shortHash(r.content) === promptVersion)) {
    rows.push({
      agentId: input.agentId,
      content: input.content,
      notes: input.notes ?? null,
      registeredAt: clock.nowIso(),
      promotedAt: null,
      promotedBy: null,
      promoteNotes: null,
    });
  }
  return promptVersion;
}
