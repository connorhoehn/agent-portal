// The promotions inbox — the ladder's candidate clusters, offline.
//
// These four candidates and their twelve observations were a
// `MOCK_CANDIDATES: PromotionCandidate[]` inside providers/promotions.ts.
// Both floor problems applied at once:
//
//   1. THE WRITES WERE UNDOABLE. `promoteCandidate` and `dismissCandidate`
//      mutate a candidate's `status` — and `dismissCandidate` additionally
//      APPENDS to its `rationale`, so a dismissal is not even idempotent: two
//      dismissals leave two reasons glued to one sentence. Against a bare
//      array those edits outlived every reset, which is exactly the state
//      docs/mock-floor.md quotes an auditor warning the next auditor about
//      ("`promo-aurora-cold-start` is now Promoted until the middleware
//      restarts"). Both writes were refused outright by the wire capture's
//      write policy for that reason.
//   2. THE STAMPS WERE MINTED OFF THE WALL CLOCK. `ago(days)` was
//      `new Date(Date.now() - days * 86_400_000)`, so freezeClock could not
//      pin an observation's age and a test could not assert one.
//
// AGE IS THE CLAIM HERE, NOT THE DAY, so nothing below uses `keepWithinToday`:
// the inbox ranks by support count and renders each observation's age as
// prose ("19 days ago"), and no surface buckets an observation by calendar
// day. A cluster whose first sighting was 58 days ago is meant to read as
// two months old whatever the wall clock says.
//
// IDS ARE PART OF THE CONTRACT. `promo-*` and `obs-*` are addressed by name
// from providers/__tests__/promotions.test.ts and quoted in
// docs/mock-floor.md, so they are written out rather than generated.
//
// `supportCount` AND `sessionCount` ARE NOT STORED HERE, and that is rule 1:
// both were literals sitting beside the very observations they claimed to
// count, and one of them had already drifted —
// `promo-custodian-sg-drift` carried `sessionCount: 3` over three
// observations from two distinct sessions (sess-410 twice, then sess-1201).
// The prose in that candidate's rationale is about a third session whose
// observations the cluster never held. providers/promotions.ts derives both
// numbers off `observations` on every read now, so the pair cannot disagree
// with the rows again; the row type is `SeededCandidate`, which is
// `PromotionCandidate` minus exactly those two fields.

import { clock, defineFixture } from './core/index.js';
// Type-only, so it is erased at compile: providers/promotions.ts imports the
// fixture below at run time, and a value import back the other way would be a
// genuine cycle rather than a shared shape.
import type { Observation, SeededCandidate } from '../providers/promotions.js';

/** `days` before now — sampled inside the rows factory, so a reset re-ages. */
const ago = (days: number): string => clock.daysAgo(days);

/** An observation with the two fields most of them share filled in. */
function obs(over: Pick<Observation, 'id' | 'kind' | 'title' | 'body' | 'sessionId'> & Partial<Observation>): Observation {
  return {
    repo: 'aws-agentcore', initiativeId: null, createdAt: ago(3),
    ...over,
  };
}

/**
 * What the lab loop has clustered out of `lab_experiences` and not yet
 * ratified. All four rungs of the ladder are represented on purpose — a
 * `candidate` skill, a `promoted` one, an `insight`, and a `runbook` that
 * drift detection demoted from a skill — because a status tab with no rows is
 * indistinguishable from a broken filter.
 */
function seedCandidates(): SeededCandidate[] {
  return [
  // These observations' initiativeId used to be 'p-platform-reliability' —
  // no such row exists in mock/budgets.ts's fourteen initiatives. The Aurora
  // cold-start race is the platform's own infra, not one of the demo's
  // business initiatives, so null ("no initiative context") is what's honest,
  // same as promo-arm64-fargate below and con-mock-3 in mock/lab.ts.
  {
    id: 'promo-aurora-cold-start',
    proposedKind: 'skill',
    title: 'Retry the Data API through an Aurora cold start',
    rationale: 'Three independent sessions hit the same HttpEndpointNotEnabledException on the first call after a scale-to-zero cluster wakes, and the same warm-up-then-backoff fix cleared it every time — a clean, repeatable procedure worth running unattended rather than re-discovering per session.',
    dryRunRunId: null,
    status: 'candidate',
    observations: [
      obs({
        id: 'obs-aurora-1', kind: 'failed', sessionId: 'sess-914',
        title: 'Aurora Data API call failed with HttpEndpointNotEnabledException on first request',
        body: 'schema/load_schema.py hit HttpEndpointNotEnabledException calling a just-created 0.5-ACU cluster — the Data API endpoint was not enabled yet, not a real SQL error.',
        initiativeId: null, createdAt: ago(19),
      }),
      obs({
        id: 'obs-aurora-2', kind: 'decision', sessionId: 'sess-914',
        title: 'Decided to retry the cold-start exception with backoff instead of failing loud',
        body: 'A cold 0.5-ACU cluster fails the first Data API call until the HTTP endpoint enables. Decision: warm-up SELECT 1 first, then retry HttpEndpointNotEnabledException and its resume/scale siblings 6x with a 3s backoff before treating it as a real failure.',
        initiativeId: null, createdAt: ago(19),
      }),
      obs({
        id: 'obs-aurora-3', kind: 'worked', sessionId: 'sess-1032',
        title: 'Warm-up SELECT 1 plus 6x3s retry cleared the same cold-start race in a second rebuild',
        body: 'Ran the retry loop again against a freshly redeployed OrgIQ-Aurora after a full teardown — same exception, same fix, cleared on attempt 2 of 6. Genuine SQL errors still raise immediately, so the loop does not mask real bugs.',
        initiativeId: null, createdAt: ago(6),
      }),
    ],
  },
  // Same fix as above: initiativeId was 'p-agent-fleet-ops', also not one of
  // the fourteen mock/budgets.ts initiatives. The middleware's own deploy
  // platform, not a business initiative — null, paired with exp-mock-2 in
  // mock/lab.ts (the same incident).
  {
    id: 'promo-arm64-fargate',
    proposedKind: 'skill',
    title: 'Pin Fargate tasks to ARM64 or eat exec format error',
    rationale: 'Three sessions across two people independently hit the identical crash-loop, root-caused it to the same default, and shipped the same one-line fix — approved and dry-run verified, now a standing skill the fleet applies without rediscovering it.',
    // Promoted before a dry-run was a recorded run (rule 1, pipelines P2):
    // the verdict predates `pipeline_runs`, so there is no run id to cite and
    // none is invented. Its "dry-run verified" is the reviewer's word, kept in
    // the rationale where it was written.
    dryRunRunId: null,
    status: 'promoted',
    observations: [
      obs({
        id: 'obs-arm64-1', kind: 'failed', sessionId: 'sess-701', repo: 'aws-agentcore/middleware',
        title: 'Middleware Fargate task crash-looped with exec format error after image push',
        body: 'Task stuck UPDATE_IN_PROGRESS, replaced in a loop. The image was built on Apple Silicon and Fargate defaulted the task definition to x86_64.',
        initiativeId: null, createdAt: ago(41),
      }),
      obs({
        id: 'obs-arm64-2', kind: 'decision', sessionId: 'sess-701', repo: 'aws-agentcore/middleware',
        title: 'Decided to pin runtimePlatform to ARM64 explicitly rather than rely on the Fargate default',
        body: 'MiddlewareServiceStack now sets runtimePlatform: ARM64 — also the cheaper option, so this is not a workaround with a cost tradeoff, it is strictly better.',
        initiativeId: null, createdAt: ago(41),
      }),
      obs({
        id: 'obs-arm64-3', kind: 'worked', sessionId: 'sess-889', repo: 'aws-agentcore/middleware',
        title: 'Explicit ARM64 runtimePlatform stopped the crash-loop on a second, unrelated rebuild',
        body: 'Same fix applied to a fresh OrgIQ-MiddlewareService redeploy — task went healthy on the first attempt, no more exec format error.',
        initiativeId: null, createdAt: ago(12),
      }),
    ],
  },
  {
    id: 'promo-adot-configurator',
    proposedKind: 'insight',
    title: 'Agent images need ADOT, not vanilla opentelemetry-distro',
    rationale: 'A pure fact about how AgentCore Runtime wires OTEL — no procedure to run, nothing to retry, just something every agent image must be built with. That makes it an insight to inject into the build-review checklist, not a runbook to execute.',
    dryRunRunId: null,
    status: 'candidate',
    observations: [
      obs({
        id: 'obs-adot-1', kind: 'gotcha', sessionId: 'sess-552', repo: 'aws-agentcore/agents',
        title: 'Vanilla opentelemetry-distro leaves aws/spans silently empty on AgentCore Runtime',
        body: 'AgentCore Runtime injects OTEL_PYTHON_CONFIGURATOR=aws_configurator, which only exists in aws-opentelemetry-distro. With the vanilla package no configurator loads and no spans ever export — no error, just silence.',
        initiativeId: 'p-observability', createdAt: ago(27),
      }),
      obs({
        id: 'obs-adot-2', kind: 'gotcha', sessionId: 'sess-552', repo: 'aws-agentcore/agents',
        title: 'Empty aws/spans starved the span projector and /recent-invocations with no visible error',
        body: 'Took a week to notice — the agent worked fine, it just produced zero observability. Nothing in the deploy logs pointed at the OTEL package choice.',
        initiativeId: 'p-observability', createdAt: ago(27),
      }),
      obs({
        id: 'obs-adot-3', kind: 'convention', sessionId: 'sess-670', repo: 'aws-agentcore/agents',
        title: 'Every agent Dockerfile must install aws-opentelemetry-distro, never the vanilla package',
        body: 'Confirmed the same silent-empty-spans failure on a second agent image that had copy-pasted an older base Dockerfile. Adding this as a standing build-review check.',
        initiativeId: 'p-observability', createdAt: ago(9),
      }),
    ],
  },
  // initiativeId was 'p-security-baseline' — also not a real initiative.
  // Repointed to 'p-zero-trust' (network perimeter hardening is squarely
  // that initiative's work), matching exp-mock-4 in mock/lab.ts for the same
  // incident. `driftedFrom: 'skl-custodian-sg-allowlist'` below is left as
  // is — it points at a skill that was demoted back to runbook (see the
  // rationale), so the id legitimately no longer resolves in
  // mock/prompt-library.ts; it's a historical pointer, not a live FK, and
  // it's pinned by providers/__tests__/promotions.test.ts.
  {
    id: 'promo-custodian-sg-drift',
    proposedKind: 'runbook',
    title: 'Custodian revokes open security-group ingress within seconds — request an allow-list instead',
    rationale: 'Was promoted to a skill after two clean sessions of the same fix (openListener: false, allow-list the caller CIDR). A third session hit the fix applied exactly as before and it STILL got revoked — custodian had started closing a second rule the skill did not cover. Drift detection caught the mismatch between the skill\'s recorded steps and observed behavior and sent it back down to runbook for a person to update before it runs unattended again.',
    // The failed dry-run the rationale describes ran before dry-runs were
    // recorded as runs; the next one is a `pipeline_runs` row.
    dryRunRunId: null,
    status: 'candidate',
    driftedFrom: 'skl-custodian-sg-allowlist',
    observations: [
      obs({
        id: 'obs-custodian-1', kind: 'gotcha', sessionId: 'sess-410',
        title: 'custodian-restrict-security-group-admin-ingress revoked our 0.0.0.0/0 ALB rule within seconds',
        body: 'CFN authorized the rule at 14:20:22, custodian revoked it at 14:20:28 — no stack event, no drift, task healthy and target group green with zero traffic reaching it.',
        initiativeId: 'p-zero-trust', createdAt: ago(58),
      }),
      obs({
        id: 'obs-custodian-2', kind: 'worked', sessionId: 'sess-410',
        title: 'Setting openListener: false and passing an explicit allow-list CIDR kept the rule alive',
        body: 'Reissued the ALB ingress scoped to a /32 instead of 0.0.0.0/0 — custodian left it alone. Promoted this to a skill after a second clean session repeated the same result.',
        initiativeId: 'p-zero-trust', createdAt: ago(58),
      }),
      obs({
        id: 'obs-custodian-3', kind: 'failed', sessionId: 'sess-1201',
        title: 'The allow-list skill ran its recorded steps and the rule was revoked anyway',
        body: 'Same openListener: false + allow-list CIDR pattern, applied by the skill exactly as recorded — custodian revoked it 4s later. The account now appears to also flag the allow-listed CIDR when it is wider than /28, which the skill\'s steps never accounted for.',
        initiativeId: 'p-zero-trust', createdAt: ago(2),
      }),
    ],
  },
  ];
}

/**
 * The promotions inbox.
 *
 * `empty` — the lab has run and clustered nothing worth promoting. Declared
 *           explicitly: an undeclared scenario falls back to `default`, and
 *           "nothing to review" is the state the inbox's empty copy is written
 *           for — the one state a four-candidate seed can never show.
 * `error` — the inbox cannot be read. Also declared explicitly, and for the
 *           same reason `empty` is: without it `{"scenario":"error"}` left
 *           `/api/promotions` byte-identical to `default`, so the queue's
 *           failed-load state was unreachable over HTTP. `lab_experiences`
 *           is the one real relation underneath this ladder (the clustering
 *           and candidate tables do not exist yet — see providers/
 *           promotions.ts), so that is what the message names.
 */
export const promotionCandidates = defineFixture<SeededCandidate>({
  key: 'promotion-candidates',
  scenarios: {
    default: seedCandidates,
    empty: () => [],
    error: (): never => {
      throw new Error('promotion inbox unavailable: lab_experiences read failed');
    },
  },
});
