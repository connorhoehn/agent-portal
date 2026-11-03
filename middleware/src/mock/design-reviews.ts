// Design-review threads — the Design phase's ADR system, offline.
//
// This domain is mock-first on purpose: schema/design_reviews_schema.sql is the
// Aurora contract the provider's SQL path will land on, and until it does these
// rows ARE the feature. They were already here, inside providers/design-reviews.ts,
// but off the fixture floor in two ways that matter:
//
//   * every timestamp was `Date.now() - h * 3600_000` evaluated at MODULE LOAD,
//     so "8 hours ago" meant eight hours before the process booted — a
//     long-running dev server drifts, and a thread's posts slide out of the
//     order the story needs;
//   * there was no scenario control, so an auditor could only see the populated
//     world, and reaching an empty one meant deleting rows from shared state.
//
// The cast and the initiative ids mirror schema/seed.sql (p-observability,
// p-auth-migration and the people who own them) and the bot names mirror
// schema/seed_program.sql's `bots`, so a reader who clicks from a design thread
// to the initiative finds the same humans and the same agents.
//
// Post ids are written down rather than generated from a counter: a counter
// that keeps incrementing across `reset()` hands the same seed row a different
// id on the second read, and `resolvedBy` points at one of these by id.

import { clock, defineFixture } from './core/index.js';
import { mockAvatarUrl } from './avatars.js';
import type { DesignPost, DesignSignoff, DesignStatus } from '../providers/design-reviews.js';

/** A design review with its posts — the row shape the Aurora path will join to. */
export interface DesignReviewDoc {
  id: string;
  orgProjectId: string;
  orgProjectName: string;
  title: string;
  status: DesignStatus;
  dependsOn: string[];
  kbSynced: boolean;
  summary: string;
  affected: Array<{ orgProjectId: string; orgProjectName: string; impact: string }>;
  signoffs: DesignSignoff[];
  posts: DesignPost[];
  createdAt: string;
  updatedAt: string;
}

/** Fill the fields every post shares, so a row states only what differs. */
function post(
  over: Partial<DesignPost> & Pick<DesignPost, 'id' | 'authorKind' | 'authorName' | 'kind' | 'body' | 'createdAt'>,
): DesignPost {
  return { resolvedBy: null, artifact: null, ...over };
}

export const designReviewDocs = defineFixture<DesignReviewDoc>({
  key: 'design-reviews',
  scenarios: {
    default: () => [
      {
        id: 'des-obs-sampling',
        orgProjectId: 'p-observability', orgProjectName: 'Observability Platform',
        title: 'ADR: tail-sampling policy for the collector fleet',
        status: 'approved', dependsOn: [], kbSynced: true,
        summary: 'Keep 100% of error traces and p99 outliers, sample the rest at 5%, decided at the gateway collector tier. Ratified by three stewards after the restart-orphaning risk was verified in the lab; rolled out behind a per-service flag with StatsD parity dashboards.',
        affected: [
          { orgProjectId: 'p-observability', orgProjectName: 'Observability Platform', impact: 'home initiative — collector fleet config' },
          { orgProjectId: 'p-cost-opt', orgProjectName: 'Cost Optimization', impact: 'trace storage drops ~70% at the new baseline' },
          { orgProjectId: 'p-llm-platform', orgProjectName: 'LLM Application Platform', impact: 'eval traces ride the kept-error lane' },
        ],
        createdAt: clock.daysAgo(30), updatedAt: clock.daysAgo(6),
        signoffs: [
          { personName: 'Nora DaSilva', signerId: 'p-004', avatarUrl: mockAvatarUrl('p-004'), role: 'owner', decision: 'approve', at: clock.daysAgo(7) },
          { personName: 'Layla Hassan', signerId: 'p-008', avatarUrl: mockAvatarUrl('p-008'), role: 'sme', decision: 'approve', at: clock.daysAgo(6) },
          { personName: 'Sienna Garcia', signerId: 'p-005', avatarUrl: mockAvatarUrl('p-005'), role: 'org-leader', decision: 'approve', at: clock.daysAgo(6) },
        ],
        posts: [
          post({ id: 'dp-obs-1', authorKind: 'human', authorName: 'Nora DaSilva', authorId: 'p-004', avatarUrl: mockAvatarUrl('p-004'), kind: 'problem', createdAt: clock.daysAgo(30),
            body: 'Problem, restated from the initiative: head sampling at 10% loses exactly the traces on-call needs — errors and p99 outliers are sampled away with everything else. The board carries three stories blocked on a sampling decision.' }),
          post({ id: 'dp-obs-2', authorKind: 'human', authorName: 'Eli Garcia', authorId: 'p-011', avatarUrl: mockAvatarUrl('p-011'), kind: 'option', createdAt: clock.daysAgo(29),
            body: 'Option A — tail sampling at the gateway collectors: keep 100% of error traces and anything over the p99 latency line, 5% of the rest. A 10 s decision wait at 40k spans/s holds about 400k spans, roughly 3 GiB per gateway pod, so the gateway tier grows from 4 to 6 pods. Option B — per-service head-sampling overrides: no extra memory, but the sampler decides before it knows the trace failed, and every new service re-fights the default. Cost model attached.' }),
          post({ id: 'dp-obs-3', authorKind: 'human', authorName: 'Layla Hassan', authorId: 'p-008', avatarUrl: mockAvatarUrl('p-008'), kind: 'question', createdAt: clock.daysAgo(28), resolvedBy: 'dp-obs-4',
            body: 'Does Option A hold when a collector restarts mid-trace? We got burned by span orphaning during the StatsD migration.' }),
          post({ id: 'dp-obs-4', authorKind: 'human', authorName: 'Eli Garcia', authorId: 'p-011', avatarUrl: mockAvatarUrl('p-011'), kind: 'answer', createdAt: clock.daysAgo(27),
            body: 'Lab load test, 25k spans/s with one agent pod killed every 5 minutes: decision-wait buffers live on the gateway tier, so an agent-tier restart loses at most the in-flight window (about 10 s, 0.2% of traces incomplete). Orphaning risk is on gateway restarts only, and the load-balancing exporter routes by trace id, so draining a gateway before it stops, which the deploy runbook already does, keeps traces whole.' }),
          post({ id: 'dp-obs-5', authorKind: 'human', authorName: 'Nora DaSilva', authorId: 'p-004', avatarUrl: mockAvatarUrl('p-004'), kind: 'decision', createdAt: clock.daysAgo(8),
            body: 'Decision: Option A. We are going with tail sampling at the gateway tier — errors and >p99 kept at 100%, baseline 5%. Rollout behind a per-service flag, StatsD parity dashboards to confirm nothing regresses.' }),
        ],
      },
      {
        id: 'des-auth-rotation',
        orgProjectId: 'p-auth-migration', orgProjectName: 'Auth Migration',
        title: 'Session token rotation on tenant switch',
        status: 'awaiting_input', dependsOn: [], kbSynced: false,
        summary: 'Shrink the stateless-cookie replay window after a tenant/role switch by extending the session-epoch design, with masquerade explicitly exempt. Blocked on one intent question: is the target window 120s (current refresh loop) or the 60s the SOC2 controls may require.',
        affected: [
          { orgProjectId: 'p-auth-migration', orgProjectName: 'Auth Migration', impact: 'home initiative — session middleware' },
          { orgProjectId: 'p-soc2', orgProjectName: 'SOC2 Compliance', impact: 'AC-7 evidence depends on the chosen window' },
          { orgProjectId: 'p-observability', orgProjectName: 'Observability Platform', impact: 'session-revocation dashboards read the epoch events' },
        ],
        createdAt: clock.daysAgo(4), updatedAt: clock.hoursAgo(5),
        signoffs: [],
        posts: [
          post({ id: 'dp-auth-1', authorKind: 'human', authorName: 'Vera Green', authorId: 'p-002', avatarUrl: mockAvatarUrl('p-002'), kind: 'problem', createdAt: clock.daysAgo(4),
            body: 'Problem: a tenant or role switch mints a new session cookie, but a copy of the old cookie on another device stays valid until its next grants refresh, up to 120 s later. The cookie is stateless (signed, no server-side session row), and we want the replay window shrunk without adding a session store that every request would have to read.' }),
          post({ id: 'dp-auth-2', authorKind: 'human', authorName: 'Simone Chang', authorId: 'p-051', avatarUrl: mockAvatarUrl('p-051'), kind: 'analysis', createdAt: clock.daysAgo(3),
            body: 'I reviewed the epoch design we already shipped for revoke-others. The extension: bump the user’s session epoch on every switch, carry the epoch in the cookie, and refuse any cookie whose epoch is older at refresh. It costs one indexed read per refresh, which we already do for grants. One exception: a masquerading operator must NOT bump, or impersonating a user would sign that user out of every real session they have.' }),
          post({ id: 'dp-auth-3', authorKind: 'human', authorName: 'Nora DaSilva', authorId: 'p-004', avatarUrl: mockAvatarUrl('p-004'), kind: 'artifact', createdAt: clock.daysAgo(2),
            body: 'Switch flow I sketched, annotated — where the epoch bumps and which cookies die.',
            artifact: { name: 'tenant-switch-flow.png', type: 'browser screenshot', url: null } }),
          post({ id: 'dp-auth-4', authorKind: 'human', authorName: 'Simone Chang', authorId: 'p-051', avatarUrl: mockAvatarUrl('p-051'), kind: 'option', createdAt: clock.daysAgo(1),
            body: 'Two ways to hit a shorter window. Keep the 120 s refresh and the epoch check: config only, ships this sprint. Or shorten the refresh to 60 s: refresh traffic doubles, from about 8 to 16 reads a second per 1,000 active sessions, still well inside the identity table’s headroom. The second only matters if the access-control evidence needs 60 s.' }),
          post({ id: 'dp-q-rotation', authorKind: 'agent', authorName: 'orgiq-advisor', kind: 'question', createdAt: clock.hoursAgo(5),
            body: 'I cannot tell from the work items: should the rotation window target ≤120s (current grants-refresh) or do the SOC2 controls require ≤60s? The answer decides whether we ship config-only or also shorten the refresh loop — different cost, different risk.' }),
        ],
      },
      {
        id: 'des-obs-dashboards',
        orgProjectId: 'p-observability', orgProjectName: 'Observability Platform',
        title: 'RED dashboards from span metrics',
        status: 'ideating', dependsOn: ['des-obs-sampling'], kbSynced: false,
        summary: 'Generate per-team rate/error/duration dashboards from the span-metrics connector instead of hand-building them. Early ideation: one layout drafted in the browser; correctness rests on the approved tail-sampling ADR (rates pre-sampling, errors exact).',
        affected: [
          { orgProjectId: 'p-observability', orgProjectName: 'Observability Platform', impact: 'home initiative — dashboard generation' },
          { orgProjectId: 'p-inference-platform', orgProjectName: 'Inference Platform', impact: 'first consumer of the generated boards' },
        ],
        createdAt: clock.daysAgo(2), updatedAt: clock.hoursAgo(8),
        signoffs: [],
        posts: [
          post({ id: 'dp-dash-1', authorKind: 'human', authorName: 'Layla Hassan', authorId: 'p-008', avatarUrl: mockAvatarUrl('p-008'), kind: 'problem', createdAt: clock.daysAgo(2),
            body: 'Problem: per-team RED dashboards are hand-built and drift: 9 of 31 still chart a StatsD series nobody emits. The span-metrics connector can generate them, but only on top of the approved tail-sampling ADR: rates must be computed before sampling (at the agent tier) or every rate reads 5% of the truth, while error counts are exact either way.' }),
          post({ id: 'dp-dash-2', authorKind: 'human', authorName: 'Eli Garcia', authorId: 'p-011', avatarUrl: mockAvatarUrl('p-011'), kind: 'artifact', createdAt: clock.hoursAgo(8),
            body: 'First-pass dashboard layout from the browser — rate/error/duration per service, error budget strip on top.',
            artifact: { name: 'red-dashboard-draft.png', type: 'browser screenshot', url: null } }),
          post({ id: 'dp-dash-3', authorKind: 'human', authorName: 'Nora DaSilva', authorId: 'p-004', avatarUrl: mockAvatarUrl('p-004'), kind: 'analysis', createdAt: clock.hoursAgo(6),
            body: 'Cardinality check before we generate anything: service × route × status code is about 41,000 series today with templated routes. One un-templated route on search added 9,000 series in a day last month, so generation must refuse a raw path rather than chart it.' }),
        ],
      },
    ],
    // An initiative with no design thread opened yet — the state every
    // initiative starts in, and the one /iq/designs has to render on its own.
    empty: () => [],
    // "No design threads yet" is the state a new initiative is genuinely in.
    // A failed read is not that: the ADRs exist and the decisions they carry
    // are load-bearing, and the page must not invite you to open a thread on a
    // question that was already decided in one it could not show you.
    error: () => { throw new Error('design_reviews unavailable: relation does not exist'); },
  },
});
