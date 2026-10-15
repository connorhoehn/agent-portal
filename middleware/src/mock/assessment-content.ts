// The assessment tenant's seeded evidence, scores and Forms submissions.
//
// Hand-written per team and per dimension, deterministic, no model calls. Every
// instant is `at(hoursBack)` off the mock clock (core/clock.ts), so ids and
// stamps that embed a date move with it. The scoring log, the run ledger and
// the history entries share these constants, so a re-score can never predate
// the upload it cites. Why the old seed was replaced: docs/demo-content-audit.md
// (A2, A3, A5) — one evidence sentence pasted 52 times, flat scorecards, August.
//
// Rubric rules the numbers obey (RUBRIC_V1 in assessment.ts): level names are
// Below Baseline, Initial, Developing, Defined, Measured, Optimizing; a team's
// own account alone is capped at Defined; Measured needs observed evidence.

import { clock } from './core/index.js';
import type {
  Confidence, DimensionHint, DimensionHistoryEntry, Evidence, EvidenceClass, EvidenceLogItem,
  EvidenceSourceType, FollowUpQuestion, MockDimensionScore, Provenance, ScoringLog, ScoringLogEntry,
  SubmissionEnvelope,
} from './assessment.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** An instant `hoursBack` before now, to the minute so two fixtures sampling the clock agree. */
export const at = (hoursBack: number): string =>
  new Date(Math.floor(Date.parse(clock.nowIso()) / MINUTE_MS) * MINUTE_MS - Math.round(hoursBack * HOUR_MS)).toISOString();

/** `20261008T091500Z`, the compact form run ids, log stamps and envelope ids embed. */
export const stampOf = (iso: string): string => `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`;

export const runStamp = (startedAtIso: string): string => stampOf(startedAtIso);

/** `run-<stamp>-<command>-<suffix>`; the suffix is the seed's own tail. */
export const runId = (startedAtIso: string, command: string, suffix: string): string =>
  `run-${runStamp(startedAtIso)}-${command}-${suffix}`;

/** Microsoft Forms exports `M/D/YYYY H:mm` and `M/D/YYYY`, in UTC here. */
const formsStamp = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const formsDate = (iso: string): string => formsStamp(iso).split(' ')[0]!;
const yearMonth = (iso: string): string => `${iso.slice(0, 4)}-${iso.slice(5, 7)}`;
const ymd = (iso: string): string => iso.slice(0, 10);

/** Hours back for every event the ledgers share. */
export const HB = {
  t1Rescore: 96, t1Minutes: 100, t1Jira: 48, t1Diagram: 15,
  t2R1: 696, t2R2: 528, t2Score: 336, t2R3: 100, t2Draft: 46, t2Validate: 20,
  t3Interview: 192, t3Classify: 170, t3Score: 168, t3Form: 144, t3Running: 0.1,
  t4Upload: 168, t4Review: 160, t4Failed: 24,
  t5Intake: 216, t5Form: 192, t5Failed: 9,
  enterpriseContext: 72,
} as const;

/** Run ids the scores, logs and run ledger must agree on. */
export const RUN_ID = {
  t3Classify: (): string => runId(at(HB.t3Classify), 'classify-transcript', '4f21ab5c9d10'),
  t3Score: (): string => runId(at(HB.t3Score), 'score-dimensions', '9c02de11aa3f'),
  t2Score: (): string => runId(at(HB.t2Score), 'score-dimensions', '1a77f0c3aa91'),
  t1Rescore: (): string => runId(at(HB.t1Rescore), 'score-dimensions', '6b41cdaa02e7'),
};

// ─── Envelope ids ───────────────────────────────────────────────────────────

/** Every revision of a submission keeps the first revision's stamp, `-rN` marks the later ones. */
const envelopeId = (firstHoursBack: number, form: number, who: string, rev: number): string =>
  `sub-${stampOf(at(firstHoursBack + 3))}-form${form}-${who}${rev > 1 ? `-r${rev}` : ''}`;

export const ENVELOPE = {
  t2r1: (): string => envelopeId(HB.t2R1, 5, 'jordan-lee', 1),
  t2r2: (): string => envelopeId(HB.t2R1, 5, 'jordan-lee', 2),
  t2r3: (): string => envelopeId(HB.t2R1, 5, 'jordan-lee', 3),
  t3: (): string => envelopeId(HB.t3Form, 12, 'sam-okafor', 1),
  t5: (): string => envelopeId(HB.t5Form, 9, 'martina-kovacs', 1),
};

const fill = (uri: string): string => uri
  .replace('{interview}', `interview-${ymd(at(HB.t3Interview))}.md`);

// ─── Seed shapes ────────────────────────────────────────────────────────────

interface Step {
  /** The level after this step; null for an N/A decision. */
  lvl: number | null;
  /** When the score changed, in hours back. */
  hb: number;
  uri?: string;
  /** The evidence excerpt; omitted when the step cites none. */
  ev?: string;
  why: string;
  /** When the evidence arrived, if not at `hb`. */
  eh?: number;
  by?: string;
  meeting?: string;
  na?: 'approved' | 'requested';
}

interface DimSeed {
  claim: number | null;
  cls: EvidenceClass | null;
  conf: Confidence;
  steps: Step[];
  fu?: string[];
  cap?: boolean;
  /** The team's own answer on the Forms submission, when there is one. */
  ans?: string;
}

interface TeamSeed {
  id: string;
  /** Who recorded the first review of each dimension. */
  by: string;
  /** Who handed over the evidence. */
  capturedBy: string;
  meeting: string;
  /** Hours back the sheet was opened, for unscored dimensions. */
  opened: number;
  dims: Record<string, DimSeed>;
}

const s = (lvl: number | null, hb: number, uri: string, ev: string, why: string, more: Partial<Step> = {}): Step =>
  ({ lvl, hb, uri, ev, why, ...more });

const PAY = 'confluence://space/PAY/';
const API = 'gitlab://payments/northstar-payments-api/-/';
const MINUTES = 'upload://team-001/governance-review-minutes.pdf';
const K8S = 'gitlab://platform/k8s-operator/-/';
const CALL = 'touchpoint://team-002/review-call#dimension-';

// ─── TEAM-001 Northstar Payments ────────────────────────────────────────────

const TEAM_001: TeamSeed = {
  id: 'TEAM-001', by: 'Asha Nair', capturedBy: 'Deepa Natarajan', meeting: 'teams/TEAM-001 (artifact review)', opened: 45 * 24,
  dims: {
    '1': { claim: 5, cls: 'observed', conf: 'moderate', steps: [
      s(2, 216, `${API}blob/main/.gitlab-ci.yml`,
        'northstar-payments-api runs its pipeline on every push with a required build-and-test job; northstar-payments-infra has no pipeline file at all, and neither project blocks merge on a failed pipeline.',
        'The team rated Optimizing, but CI triggers on push for only one of the two repositories and nothing gates the merge, which is Developing. Level 2 holds until the infra repository has a pipeline and merge waits for it.'),
    ], fu: [
      'Is there a pipeline for northstar-payments-infra that we did not see, for example one that runs from a shared template?',
      'Can you share the merge request settings for both repositories showing whether a passing pipeline is required before merge?',
    ] },
    '2': { claim: 4, cls: 'documented', conf: 'moderate', steps: [
      s(3, 210, `${PAY}Payments-API-Release-Runbook`,
        'The release runbook (version 3) covers packaging, the approval step and rollback for payments-api; it does not mention the Terraform apply for the infra repository.',
        'Release steps are written down and driven from the pipeline, which is Defined. The team claimed Measured, but no release success or rollback figures are recorded anywhere we were shown.'),
    ], fu: ['Where are release success rate and rollback counts tracked for payments-api this quarter?'] },
    '3': { claim: 3, cls: 'documented', conf: 'moderate', steps: [
      s(3, 192, `${PAY}Terraform-Apply-Standard`,
        'The Terraform standard requires plan output in the merge request and applies only from the protected branch; the last twelve infra changes in GitLab all follow it.',
        'Infrastructure changes go through one automated path, which matches the claim of Defined.'),
    ] },
    '4': { claim: 4, cls: 'observed', conf: 'high', steps: [
      s(4, 168, `${API}settings/repository`,
        'Both projects protect main, require two approvals and signed commits, and tie every merge request to a Jira key; 96 of the last 100 merge requests carry the key in the title.',
        'Repository practice is consistent and checked against the team\'s own traceability target, which is Measured. This is the team\'s strongest dimension.'),
    ] },
    '5': { claim: 4, cls: 'documented', conf: 'moderate', steps: [
      s(3, 144, `${PAY}Payments-Test-Strategy`,
        'The test strategy puts unit coverage at 71 percent for payments-api and runs a nightly integration suite against the sandbox processor; nothing tests the contract between the API and the reconciliation job.',
        'Automated tests run on every build as standard practice, which is Defined. Measured needs coverage tracked against a target and contract tests across the service boundary, and neither exists yet.'),
    ], fu: ['Is the 71 percent unit coverage figure checked against a target in the pipeline, or only reported?'] },
    '6': { claim: null, cls: null, conf: 'low', steps: [
      { lvl: null, hb: 240, by: 'Jonas Lindqvist', na: 'approved', meeting: 'teams/TEAM-001 (exception review)',
        why: 'Not applicable: security testing for the payments repositories is owned and run by Application Security\'s central gate, so the team has no testing of its own to score. Approved as a known exception.' },
    ] },
    '7': { claim: null, cls: null, conf: 'low', steps: [
      { lvl: null, hb: 100, by: 'Asha Nair', na: 'requested', meeting: 'teams/TEAM-001 (exception review)',
        why: 'The team asked for N/A on performance and reliability testing because its only job is an internal overnight reconciliation batch. N/A is never self-granting, so the dimension stays open until the lead assessor decides.' },
    ] },
    '8': { claim: 3, cls: 'observed', conf: 'high', steps: [
      s(4, 120, `${API}settings/merge_requests`,
        'CODEOWNERS routes payment-path changes to the security champion, a second reviewer is mandatory, and a dependency scan blocks merges on high-severity findings.',
        'Code review is enforced by tooling rather than habit, and the team tracks time to triage findings. That is Measured, one level above what the team claimed.'),
    ] },
    '9': { claim: 4, cls: 'observed', conf: 'high', steps: [
      s(3, 216, `${PAY}Engineering-Governance-Charter`,
        'The governance charter names a service owner, change approver and on-call rotation for each payments service, but it is unsigned and no review of it is recorded.',
        'Decision rights are written down and repeatable, which is Defined. Whether anyone applies the charter was not yet visible.'),
      s(4, HB.t1Rescore, 'jira://GOV/board/payments-reviews',
        'The GOV Jira board holds four quarterly review tickets for the payments services, each closed with a recorded decision and linked to the charter version it changed; the latest closed three weeks ago.',
        'Reviews have run every quarter and their decisions change the charter, which we observed directly rather than took from the team. That is Measured.',
        { eh: HB.t1Minutes, by: 'Jonas Lindqvist', meeting: '{rescore}' }),
    ] },
    '10': { claim: 3, cls: 'documented', conf: 'moderate', steps: [
      s(2, 144, `${PAY}Payments-Alerting-Overview`,
        'Alerts page the on-call for API error rate and queue depth, but the page lists no latency or availability targets and the reconciliation job has no alert of its own.',
        'Basic alerting exists, which is Developing. Defined needs service-level targets and coverage of the batch job, so the claim is one step ahead of what is documented.'),
    ], fu: ['Does the reconciliation batch alert anywhere when it fails or runs late?'] },
    '11': { claim: 4, cls: 'documented', conf: 'moderate', steps: [
      s(3, 120, `${PAY}Environment-Promotion-Guide`,
        'Dev, staging and production are separate cloud accounts and promotion runs through the pipeline; staging data is refreshed by hand once a quarter.',
        'Environments are separated and promotion is repeatable, which is Defined. The manual data refresh keeps it below Measured.'),
    ] },
    '12': { claim: 3, cls: 'documented', conf: 'moderate', steps: [
      s(2, 192, `${PAY}Change-Calendar-and-Freeze-Policy`,
        'A change calendar and freeze policy exist, but the incident log shows two rollbacks this quarter that were handled in chat with no post-incident review.',
        'Release and incident practice is written down but not consistently followed, which is Developing at first review.'),
      s(3, HB.t1Rescore, MINUTES,
        'The governance minutes record a review for both rollbacks and a new rule that every rollback gets a review within five days.',
        'With both reviews done and the rule adopted, operational practice is now consistently applied, which is Defined.',
        { eh: HB.t1Minutes, by: 'Jonas Lindqvist', meeting: '{rescore}' }),
    ] },
    '13': { claim: 2, cls: 'documented', conf: 'moderate', steps: [
      s(2, 168, `${PAY}Shared-Libraries-Inventory`,
        'The team uses the platform\'s shared HTTP client and logging libraries but keeps its own copy of the retry and idempotency helpers, recorded as known duplication.',
        'Some reuse, with a duplicate nobody has scheduled work to remove. Developing, which matches the claim.'),
    ] },
    '14': { claim: 4, cls: 'documented', conf: 'moderate', steps: [
      s(3, 144, `${PAY}Engineering-Principles`,
        'The team\'s principles page commits to automation first, and the last retro action list shows three manual steps removed this quarter.',
        'Automation-first behaviour is stated and visible in retro actions, which is Defined. Nobody tracks toil over time, so Measured is not supported.'),
    ] },
    '15': { claim: 3, cls: 'documented', conf: 'moderate', steps: [
      s(3, 120, `${PAY}Sprint-Planning-and-Backlog-Rules`,
        'Two-week sprints with refinement every Tuesday and a definition of ready that stories must meet before planning.',
        'Planning routines are written down and consistently run, which is Defined.'),
    ] },
    '16': { claim: 3, cls: 'documented', conf: 'moderate', steps: [
      s(2, 168, `${PAY}Architecture-Decision-Records`,
        'Eleven decision records sit in the ADR folder, but none of them shows a reviewer or an outcome other than accepted.',
        'Decisions are recorded but not visibly reviewed, which is Developing.'),
      s(3, HB.t1Rescore, MINUTES,
        'The governance minutes show the design review board checked two payment-path ADRs against the standards and sent one back for rework.',
        'A decision that was sent back shows the review is a real control, which is Defined.',
        { eh: HB.t1Minutes, by: 'Jonas Lindqvist', meeting: '{rescore}' }),
    ] },
    '17': { claim: 4, cls: 'documented', conf: 'moderate', steps: [
      s(2, 144, `${PAY}Delivery-Metrics-Sheet`,
        'Lead time and change failure rate are copied into a spreadsheet by hand each quarter; the last entry is seven weeks old.',
        'Metrics are collected, but manually and irregularly, which is Developing. Measured needs an automated source reviewed every sprint.'),
    ], fu: ['Can the lead time and change failure figures be produced from GitLab instead of the spreadsheet?'] },
  },
};

// ─── TEAM-002 Kubernetes Operator ───────────────────────────────────────────

const P2 = { by: 'Jonas Lindqvist', meeting: '{score2}' } as const;
/** The review call happened a few hours before the scoring pass. */
const P2C = { ...P2, eh: HB.t2Score + 4 } as const;
const TEAM_002: TeamSeed = {
  id: 'TEAM-002', by: 'Jonas Lindqvist', capturedBy: 'Jordan Lee', meeting: '{score2}', opened: 60 * 24,
  dims: {
    '1': { claim: 4, cls: 'observed', conf: 'high', ans: 'CI runs on every push and a green pipeline is required to merge.', steps: [
      s(4, HB.t2Score, `${K8S}blob/main/.gitlab-ci.yml`,
        'The .gitlab-ci.yml runs build, unit and envtest jobs on every push, merge needs a passing pipeline, and the last fifty runs on main were green apart from two flaky retries.',
        'CI is standard, enforced at merge and tracked: the pipeline analytics page reports the flaky retry rate. That is Measured.', P2),
    ] },
    '2': { claim: 5, cls: 'attested', conf: 'low', cap: true, ans: 'Releases are fully automated with a canary step and automatic rollback.', steps: [
      s(3, HB.t2Score, `${CALL}2`,
        'On the review call Jordan Lee said releases are fully automated with a canary rollout and automatic rollback; no pipeline or release record was shown.',
        'The claim of Optimizing rests on the team\'s own account, so the self-rating cap holds the score at Defined until a release record shows the canary and rollback working.',
        P2C),
    ], fu: ['Can you link a recent release where the canary step paused or rolled back on its own, so we can see it work?'] },
    '3': { claim: 4, cls: 'documented', conf: 'moderate', ans: 'Manifests are templated with Helm and Kustomize and applied by the pipeline.', steps: [
      s(3, HB.t2Score, `${K8S}blob/main/docs/automation.md`,
        'docs/automation.md describes the Helm and Kustomize overlays applied by the pipeline, and says CRD changes are still applied by hand with kubectl.',
        'Most configuration is applied automatically, with one known manual step for CRDs. Defined, one short of the claim.', P2),
    ] },
    '4': { claim: 4, cls: 'observed', conf: 'high', ans: 'Release branches are protected and tags are signed.', steps: [
      s(4, HB.t2Score, `${K8S}settings/repository`,
        'Both release branches are protected, tags are signed, and the changelog is generated from conventional commits so every release note maps back to a merge request.',
        'Traceability from commit to release note is automatic and consistent. Measured.', P2),
    ] },
    '5': { claim: 5, cls: 'observed', conf: 'high', ans: 'We test every controller and run end-to-end tests on a real cluster every night.', steps: [
      s(4, HB.t2Score, `${K8S}pipelines`,
        'Unit tests report 82 percent coverage in CI, envtest suites cover each controller, and an end-to-end suite runs nightly on a kind cluster; there is no soak or fault-injection test.',
        'Testing is broad, automated and tracked, which is Measured. Optimizing needs tests that find regressions before users do, such as soak or fault-injection runs, and those are absent.', P2),
    ] },
    '6': { claim: 3, cls: 'documented', conf: 'moderate', ans: 'We scan images for vulnerabilities when we cut a release.', steps: [
      s(2, HB.t2Score, `${K8S}blob/main/docs/security.md`,
        'Trivy scans the release image in the release job only; there is no SAST job and dependency findings are reviewed ad hoc.',
        'Some scanning exists but it runs late and not on every build, which is Developing.', P2),
    ], fu: ['Does any scan run on merge requests, or only when a release is cut?'] },
    '7': { claim: 3, cls: 'attested', conf: 'low', ans: 'We load-test before major releases.', steps: [
      s(1, HB.t2Score, `${CALL}7`,
        'Jordan said the team load-tests before major releases; no test plan, results or dashboard were shown.',
        'Without a plan or results this reads as an intention rather than a practice. Initial.', P2C),
    ], fu: ['Can you share the results of the most recent load test and the reconcile-latency target it was checked against?'] },
    '8': { claim: 4, cls: 'documented', conf: 'moderate', ans: 'Every change gets a review and a checklist for CRD and RBAC changes.', steps: [
      s(3, HB.t2Score, `${K8S}blob/main/CONTRIBUTING.md`,
        'CONTRIBUTING.md requires one approving review and a checklist for CRD and RBAC changes; the checklist is filled in on roughly half of recent merge requests.',
        'A review standard is written and mostly followed, which is Defined.', P2),
    ] },
    '9': { claim: 2, cls: 'attested', conf: 'low', ans: 'The two maintainers know who owns what; nothing is written down.', steps: [
      s(2, HB.t2Score, `${CALL}9`,
        'Jordan said ownership is understood informally between the two maintainers and is not written down anywhere.',
        'Governance is informal and depends on two people. Developing, as the team rated itself.', P2C),
    ] },
    '10': { claim: 4, cls: 'observed', conf: 'moderate', ans: 'Metrics and alerts ship with the Helm chart.', steps: [
      s(3, HB.t2Score, `${K8S}tree/main/charts/operator`,
        'A ServiceMonitor and four alert rules ship with the Helm chart, covering reconcile errors and queue depth; the chart defines no SLO and there is no dashboard for the operator\'s own latency.',
        'Monitoring is standard and ships with the product, which is Defined. Measured needs targets the alerts are checked against.', P2),
    ] },
    '11': { claim: 3, cls: 'documented', conf: 'moderate', ans: 'Dev, staging and production clusters are documented.', steps: [
      s(3, HB.t2Score, `${K8S}blob/main/docs/environments.md`,
        'docs/environments.md lists the dev, staging and production clusters and the promotion order; staging runs the previous minor release of Kubernetes.',
        'Environments and promotion are written down and repeatable. Defined.', P2),
    ] },
    '12': { claim: 4, cls: 'documented', conf: 'moderate', ans: 'We follow semantic versioning and publish a support policy.', steps: [
      s(3, HB.t2Score, `${K8S}blob/main/docs/releases.md`,
        'Releases follow semantic versioning with a published support policy, but no rollback has been rehearsed and there is no release health metric.',
        'Release practice is consistent and documented, which is Defined; the missing rollback rehearsal keeps it below Measured.', P2),
    ] },
    '13': { claim: 5, cls: 'observed', conf: 'high', ans: 'Three other teams run our operator and chart.', steps: [
      s(4, HB.t2Score, `${K8S}tree/main/docs/compatibility`,
        'The operator and its Helm chart are consumed by three other teams\' clusters, with versioned CRD documentation and a compatibility table for each release.',
        'A reusable platform product with documented compatibility and several consumers, which is Measured. This is the team\'s strongest dimension.', P2),
    ] },
    '14': { claim: 4, cls: 'attested', conf: 'low', cap: true, ans: 'We are automation-first; the pipeline shows it.', steps: [
      s(3, HB.t2Score, `${CALL}14`,
        'Jordan described the team as automation-first and pointed to its pipeline as proof; no retro notes or other records were shown.',
        'The statement is plausible given the pipeline we reviewed, but it is the team\'s own account, so the cap holds it at Defined.', P2C),
    ] },
    '15': { claim: 3, cls: 'attested', conf: 'low', ans: 'Work is tracked on a shared board.', steps: [
      s(2, HB.t2Score, `${CALL}15`,
        'Work is tracked on a shared board, but Jordan said sprints are loose and the backlog is not groomed on a schedule.',
        'Planning is informal, which is Developing, one below the claim.', P2C),
    ] },
    '16': { claim: 4, cls: 'documented', conf: 'moderate', ans: 'We keep architecture decision records for every significant choice.', steps: [
      s(3, HB.t2Score, `${K8S}tree/main/docs/adr`,
        'docs/adr holds eleven decision records, the latest from last month, though the alternatives section of the template is empty on four of them.',
        'Decisions are recorded in a standard way, which is Defined. Measured needs the alternatives reviewed as well.', P2),
    ] },
    '17': { claim: 3, cls: 'attested', conf: 'low', ans: 'We know roughly how often we release.', steps: [
      s(2, HB.t2Score, `${CALL}17`,
        'Jordan gave release frequency from memory; the team keeps no lead time or failure-rate figures.',
        'There is no data to score above Developing; the claim of Defined needs recorded figures.', P2C),
    ], fu: ['Can you export the merge-to-release times for last quarter\'s releases from GitLab?'] },
  },
};

// ─── TEAM-003 Checkout Experience ───────────────────────────────────────────

const T3 = { by: 'Asha Nair', meeting: '{score3}', eh: HB.t3Interview } as const;
const TEAM_003: TeamSeed = {
  id: 'TEAM-003', by: 'Asha Nair', capturedBy: 'Asha Nair', meeting: '{score3}', opened: 20 * 24,
  dims: {
    '1': { claim: 3, cls: 'attested', conf: 'moderate', ans: 'Every push builds and runs unit tests, and a failed build blocks the merge button.', steps: [
      s(3, HB.t3Score, 'transcript://team-003/{interview}#14:20',
        'Sam Okafor said every push to checkout-web builds and runs the unit tests, and a failed build disables the merge button.',
        'Described as standard and required before merge, which would be Defined. It is a verbal account, so confidence stays moderate until the project settings are seen.', T3),
    ], fu: ['Can you screenshot the merge request settings that block merging on a failed pipeline?'] },
    '2': { claim: 3, cls: 'attested', conf: 'moderate', ans: 'Releases follow a documented runbook.', steps: [
      s(2, HB.t3Score, 'transcript://team-003/{interview}#21:05',
        'Sam said releases are rolling deploys that the on-call engineer approves in Slack, with the runbook updated after each holiday-peak rehearsal.',
        'The steps are written down but the approval happens in chat rather than in the pipeline, which is Developing.', T3),
    ] },
    '3': { claim: 2, cls: 'attested', conf: 'moderate', ans: 'Some Terraform exists but changes are often made by hand.', steps: [
      s(2, HB.t3Score, 'transcript://team-003/{interview}#27:40',
        'Terraform covers the load balancer and the CDN, but feature-flag and queue settings are still changed by hand in the console, according to Sam.',
        'Part of the infrastructure is automated and part is not, which is Developing.', T3),
    ] },
    '4': { claim: 4, cls: 'attested', conf: 'moderate', cap: true, ans: 'All code is in GitLab; main is protected and every change links to a ticket.', steps: [
      s(3, HB.t3Score, 'transcript://team-003/{interview}#33:10',
        'Sam said all code is in GitLab with a protected main and every change linked to a ticket, and called it the team\'s best practice.',
        'Consistent with Defined from the team\'s account. The claim of Measured would need traceability figures, none were offered, and a verbal account is capped at Defined.', T3),
    ] },
    '5': { claim: 3, cls: 'attested', conf: 'moderate', steps: [
      s(3, HB.t3Score, 'transcript://team-003/{interview}#38:55',
        'Sam described a unit and browser test suite that blocks a release, and mentioned that flaky browser tests are retried up to three times.',
        'Automated tests gate the release, which is Defined; the retry habit is worth a follow-up in the next review.', T3),
    ] },
    '6': { claim: 2, cls: 'attested', conf: 'low', steps: [
      s(1, HB.t3Score, 'transcript://team-003/{interview}#44:30',
        'Sam said security testing happens when the central security team schedules a penetration test, roughly once a year.',
        'Security testing is periodic and external with nothing run by the team itself, which is Initial.', T3),
    ], fu: ['Which of the scans the security team runs does Checkout see results from, and how soon after the penetration test?'] },
    '7': { claim: 2, cls: 'attested', conf: 'moderate', steps: [
      s(2, HB.t3Score, 'transcript://team-003/{interview}#49:15',
        'Sam said the team load-tests the checkout path before each holiday peak and keeps the results in the release folder.',
        'A yearly practice with kept results is Developing; it is not part of standard promotion.', T3),
    ] },
    '8': { claim: 3, cls: 'attested', conf: 'moderate', steps: [
      s(3, HB.t3Score, 'transcript://team-003/{interview}#55:00',
        'Sam said two reviewers approve every merge request and that payment-form changes need sign-off from the PCI lead.',
        'Review rules are repeatable and consistently applied. Defined.', T3),
    ] },
  },
};

// ─── TEAM-004 Data Platform ─────────────────────────────────────────────────

const T4 = { by: 'Farah Osei', eh: HB.t4Upload } as const;
const TEAM_004: TeamSeed = {
  id: 'TEAM-004', by: 'Farah Osei', capturedBy: 'Elena Marsh', meeting: 'teams/TEAM-004 (artifact review)', opened: 15 * 24,
  dims: {
    '1': { claim: 4, cls: 'observed', conf: 'high', steps: [
      s(4, HB.t4Review, 'upload://team-004/dag-repo-pipeline-runs.png',
        'Screenshot of the DAG repository pipeline: lint, DAG import test and unit tests run on every push, and the last 30 runs are listed with their durations.',
        'CI runs on every push and its history is tracked, which is Measured.', T4),
    ] },
    '2': { claim: 4, cls: 'documented', conf: 'moderate', steps: [
      s(3, HB.t4Review, 'upload://team-004/dag-promotion-runbook.png',
        'Screenshot of the DAG promotion runbook: a merge to main deploys to staging, and production needs a manual approval in the pipeline.',
        'Promotion is standard and pipeline-driven, but approval is manual and there is no rollback step. Defined.', T4),
    ] },
    '3': { claim: 4, cls: 'observed', conf: 'high', steps: [
      s(4, HB.t4Review, 'upload://team-004/terraform-cloud-workspaces.png',
        'Terraform Cloud workspaces for the warehouse, streaming and IAM stacks all show applied runs triggered from version control, with no drift reported.',
        'Infrastructure is applied automatically and drift is watched, which is Measured.', T4),
    ] },
    '4': { claim: 3, cls: 'documented', conf: 'moderate', steps: [
      s(3, HB.t4Review, 'upload://team-004/repo-branch-rules.png',
        'Branch rules on the pipelines repository require a review and a linked ticket; the notebooks repository has no rules.',
        'Standard rules apply to the main repository but not the notebooks one. Defined.', T4),
    ] },
    '5': { claim: 3, cls: 'observed', conf: 'moderate', steps: [
      s(2, HB.t4Review, 'upload://team-004/data-quality-checks.png',
        'Great Expectations checks cover 9 of the 31 production tables; the rest have row-count checks only.',
        'Data tests exist but cover under a third of production tables, which is Developing. The team rated itself Defined.', T4),
    ] },
    '6': { claim: 3, cls: 'documented', conf: 'moderate', steps: [
      s(3, HB.t4Review, 'upload://team-004/secrets-scan-config.png',
        'Secret scanning and dependency scanning are switched on for every repository, and findings post to the platform channel.',
        'Security scanning is standard across repositories and findings have an owner. Defined.', T4),
    ] },
    '7': { claim: 4, cls: 'observed', conf: 'moderate', steps: [
      s(3, HB.t4Review, 'upload://team-004/warehouse-load-benchmarks.png',
        'Nightly warehouse load benchmarks are charted against a documented 90-minute window; the streaming path has no equivalent.',
        'Performance expectations are documented and validated for batch but not for streaming, which is Defined.', T4),
    ] },
    '8': { claim: 3, cls: 'documented', conf: 'moderate', steps: [
      s(3, HB.t4Review, 'upload://team-004/review-checklist.png',
        'The review checklist covers schema changes, PII columns and backfills, and appears in the pull request template.',
        'A repeatable review standard that is built into the workflow. Defined.', T4),
    ] },
    '9': { claim: 3, cls: 'documented', conf: 'moderate', steps: [
      s(2, HB.t4Review, 'upload://team-004/data-ownership-table.png',
        'A table assigns an owner to 12 of the 31 production datasets; the other 19 list the platform team as the default owner.',
        'Ownership is only partly documented, which is Developing.', T4),
    ] },
    '10': { claim: 4, cls: 'observed', conf: 'high', steps: [
      s(4, HB.t4Review, 'upload://team-004/freshness-slo-dashboard.png',
        'Grafana shows freshness and volume targets for every tier-1 dataset, and last month\'s two breaches were acknowledged within ten minutes.',
        'Targets are defined, measured and acted on. Measured, and the team\'s strongest dimension.', T4),
    ] },
  },
};

// ─── TEAM-005 Notifications Service ─────────────────────────────────────────

const T5 = { by: 'Farah Osei' } as const;
const TEAM_005: TeamSeed = {
  id: 'TEAM-005', by: 'Farah Osei', capturedBy: 'Farah Osei', meeting: 'teams/TEAM-005 (intake call)', opened: 10 * 24,
  dims: {
    '1': { claim: 1, cls: 'attested', conf: 'low', ans: 'No CI pipeline yet; we build and test on our own machines.', steps: [
      s(1, HB.t5Intake, 'touchpoint://team-005/intake-call#ci',
        'On the intake call Martina Kovacs said builds and tests run on a laptop and there is no pipeline yet.',
        'No pipeline, but tests do run before a change goes out. Initial.', T5),
    ] },
    '2': { claim: 1, cls: 'attested', conf: 'low', ans: 'Releases are manual and written up in the channel afterwards.', steps: [
      s(1, HB.t5Intake, 'touchpoint://team-005/intake-call#cd',
        'Martina described Thursday-night releases where someone copies the build to the servers and writes up the steps in the channel afterwards.',
        'Releases are repeatable only by memory. Initial.', T5),
    ] },
    '3': { claim: 1, cls: 'attested', conf: 'low', ans: 'Servers and queues were created in the console.', steps: [
      s(1, HB.t5Intake, 'touchpoint://team-005/intake-call#automation',
        'Servers and queues were created in the cloud console; the only scripted piece is a shell script that restarts the workers.',
        'A single script is the only automation. Initial.', T5),
    ] },
    '4': { claim: 2, cls: 'attested', conf: 'low', steps: [
      s(2, HB.t5Intake, 'touchpoint://team-005/intake-call#source-control',
        'Code is in GitLab with a branch per feature, but releases are not tagged and two helper scripts live on a shared drive.',
        'Source control is used but with gaps in traceability. Developing.', T5),
    ] },
    '5': { claim: 2, cls: 'attested', conf: 'low', steps: [
      s(1, HB.t5Intake, 'touchpoint://team-005/intake-call#testing',
        'Martina described a unit test folder that mostly runs and has no coverage figure; the full suite was last run before the previous release.',
        'Tests exist but run irregularly with no measure of what they cover. Initial; the team rated itself Developing.', T5),
    ] },
  },
};

export const TEAM_SEEDS: TeamSeed[] = [TEAM_001, TEAM_002, TEAM_003, TEAM_004, TEAM_005];

// ─── Builders ───────────────────────────────────────────────────────────────

/** Short stable hex from a string (FNV-1a, two lanes) — ids that never change between runs. */
const hex = (text: string, len: number): string => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, len);
};

const sourceTypeOf = (uri: string): EvidenceSourceType => {
  if (uri.startsWith('forms://')) return 'survey';
  if (uri.startsWith('transcript://')) return 'transcript';
  if (uri.startsWith('touchpoint://')) return 'touchpoint';
  if (uri.startsWith('gitlab://') || uri.startsWith('jira://')) return 'artifact';
  if (uri.startsWith('upload://')) return /\.(png|jpe?g|gif)$/i.test(uri) ? 'artifact' : 'document';
  return 'document';
};

const resolveUri = (uri: string): string => fill(uri);

const resolveMeeting = (m: string): string => m
  .replace('{score2}', RUN_ID.t2Score())
  .replace('{score3}', RUN_ID.t3Score())
  .replace('{rescore}', RUN_ID.t1Rescore());

const levelOrNull = (n: number | null): number | null => n;

export interface ContentContext {
  levelName: (dimensionId: string, level: number | null) => string | null;
  title: (dimensionId: string) => string;
  dimensionIds: string[];
}

export interface BuiltContent {
  scores: Record<string, Record<string, MockDimensionScore>>;
  provenance: Record<string, Provenance[]>;
}

const evidenceId = (team: string, dim: string, idx: number): string => `EV-${hex(`${team}|${dim}|${idx}`, 12)}`;
const provenanceId = (team: string, uri: string): string => `PROV-${hex(`${team}|${uri}`, 12)}`;

export function buildScores(ctx: ContentContext): BuiltContent {
  const scores: BuiltContent['scores'] = {};
  const provenance: BuiltContent['provenance'] = {};

  for (const team of TEAM_SEEDS) {
    const sheet: Record<string, MockDimensionScore> = {};
    const provs = new Map<string, Provenance>();
    const provFor = (uri: string, by: string, hb: number): string => {
      const existing = provs.get(uri);
      if (existing) return existing.provenance_id;
      const rec: Provenance = {
        provenance_id: provenanceId(team.id, uri), source_uri: uri,
        captured_by: uri === MINUTES ? 'Jonas Lindqvist' : by, captured_at: at(hb),
      };
      provs.set(uri, rec);
      return rec.provenance_id;
    };

    for (const dimId of ctx.dimensionIds) {
      const seed = team.dims[dimId];
      if (!seed) {
        sheet[dimId] = {
          dimension_id: dimId, current_level: null, is_na: false, confidence: 'low', self_claimed_level: null,
          evidence_class: null, cap_applied: false, evidence: [], follow_up_questions: [], history: [],
          updated_at: at(team.opened),
        };
        continue;
      }
      const evidence: Evidence[] = [];
      const history: DimensionHistoryEntry[] = [];
      let prev: number | null = null;
      let isNa = false;
      let last = seed.steps[seed.steps.length - 1]!;
      seed.steps.forEach((step, idx) => {
        let evIds: string[] = [];
        if (step.uri && step.ev) {
          const uri = resolveUri(step.uri);
          const evHb = step.eh ?? step.hb;
          const id = evidenceId(team.id, dimId, idx);
          evidence.push({
            evidence_id: id, dimension_id: dimId, source_type: sourceTypeOf(step.uri), excerpt: step.ev,
            supports_level: step.lvl, captured_at: at(evHb), source_ref: provFor(uri, team.capturedBy, evHb),
            scored: true, status: 'SCORED',
          });
          evIds = [id];
        }
        const na = step.na;
        if (na === 'approved') isNa = true;
        history.push({
          from_level: prev, to_level: step.lvl, is_na: na === 'approved', rationale: step.why,
          evidence_ids: evIds, source_meeting: resolveMeeting(step.meeting ?? team.meeting),
          changed_at: at(step.hb), changed_by: step.by ?? team.by,
          na_claimed: na !== undefined,
        });
        prev = step.lvl;
        last = step;
      });
      const followUps: FollowUpQuestion[] = (seed.fu ?? []).map((text) => ({
        question_id: `Q-${hex(`${team.id}|${dimId}|${text}`, 12)}`, dimension_id: dimId, text, target_audience: 'team', status: 'OPEN',
      }));
      sheet[dimId] = {
        dimension_id: dimId, current_level: levelOrNull(prev), is_na: isNa, confidence: seed.conf,
        self_claimed_level: seed.claim, evidence_class: seed.cls, cap_applied: seed.cap === true,
        evidence, follow_up_questions: followUps, history, updated_at: at(last.hb),
      };
    }
    scores[team.id] = sheet;
    provenance[team.id] = [...provs.values()];
  }
  return { scores, provenance };
}

// ─── Un-scored intake items ─────────────────────────────────────────────────

interface LogSeed { team: string; dim: string; src: EvidenceSourceType; uri: string; by: string; excerpt: string; status: 'PENDING' | 'CLASSIFIED'; hb: number }

const LOG_SEEDS: LogSeed[] = [
  { team: 'TEAM-003', dim: '9', src: 'document', uri: 'upload://team-003/governance-charter-draft.docx', by: 'Sam Okafor', status: 'PENDING', hb: 48,
    excerpt: 'Governance charter draft uploaded by the team; not yet reviewed against the rubric.' },
  { team: 'TEAM-003', dim: '10', src: 'artifact', uri: 'upload://team-003/checkout-latency-dashboard.png', by: 'Sam Okafor', status: 'CLASSIFIED', hb: 24,
    excerpt: 'Screenshot of the checkout latency dashboard, classified as monitoring evidence but not yet scored.' },
  { team: 'TEAM-004', dim: '11', src: 'document', uri: 'upload://team-004/environment-promotion-runbook.pdf', by: 'Elena Marsh', status: 'CLASSIFIED', hb: 48,
    excerpt: 'Environment promotion runbook, submitted for dimension 11 but still queued for scoring.' },
];

export function buildEvidenceLog(): { log: Record<string, EvidenceLogItem[]>; provenance: Record<string, Provenance[]> } {
  const log: Record<string, EvidenceLogItem[]> = {};
  const provenance: Record<string, Provenance[]> = {};
  for (const l of LOG_SEEDS) {
    const pid = provenanceId(l.team, l.uri);
    (provenance[l.team] ??= []).push({ provenance_id: pid, source_uri: l.uri, captured_by: l.by, captured_at: at(l.hb) });
    (log[l.team] ??= []).push({
      evidence_id: `EV-${hex(`${l.team}|${l.dim}|log`, 12)}`, dimension_id: l.dim, source_type: l.src, excerpt: l.excerpt,
      supports_level: null, captured_at: at(l.hb), source_ref: pid, scored: false, status: l.status,
    });
  }
  return { log, provenance };
}

// ─── Scoring logs ───────────────────────────────────────────────────────────

const logEntry = (ctx: ContentContext, dimId: string, seed: DimSeed | undefined, score: MockDimensionScore): ScoringLogEntry => {
  const naClaimed = score.history.some((h) => h.na_claimed === true);
  const last = seed?.steps[seed.steps.length - 1];
  return {
    dimension_id: dimId, is_na: score.is_na || naClaimed, suggested_level: score.current_level, confidence: score.confidence,
    rationale: last?.why ?? '', evidence_excerpts: last?.ev ? [last.ev] : [],
    follow_up_questions: (seed?.fu ?? []).slice(), na_claimed: naClaimed, self_claimed_level: score.self_claimed_level,
    evidence_class: score.evidence_class, cap_applied: score.cap_applied,
  };
};

export function buildScoringLogs(ctx: ContentContext, scores: BuiltContent['scores']): Record<string, ScoringLog[]> {
  const mk = (teamId: string, hb: number, runIdValue: string, envelope: string | null, only?: string[]): ScoringLog => {
    const seed = TEAM_SEEDS.find((t) => t.id === teamId)!;
    const dims = only ?? ctx.dimensionIds;
    return {
      team_id: teamId, envelope_id: envelope, stamp: stampOf(at(hb)), source: 'agent', run_id: runIdValue,
      scores: dims.map((d) => logEntry(ctx, d, seed.dims[d], scores[teamId]![d]!)),
    };
  };
  return {
    'TEAM-001': [mk('TEAM-001', HB.t1Rescore, RUN_ID.t1Rescore(), null)],
    'TEAM-002': [mk('TEAM-002', HB.t2Score, RUN_ID.t2Score(), null)],
    'TEAM-003': [mk('TEAM-003', HB.t3Score, RUN_ID.t3Score(), null, ['1', '2', '3', '4', '5', '6', '7', '8'])],
  };
}

// ─── Forms submissions ──────────────────────────────────────────────────────

const hintFor = (ctx: ContentContext, dim: string, claim: number, answer: string, context: string): DimensionHint => ({
  dimension_id: dim, main_answer: answer, matched_level: null, follow_up_answer: null, evidence_context: context,
  self_rating: ctx.levelName(dim, claim) ?? '', self_rating_aspect: ctx.title(dim), claimed_na: false,
});

const baseEnvelope = (
  teamId: string, teamName: string, hb: number, form: number, who: { name: string; email: string }, id: string,
  ingestedHb: number, rev: number, supersedes: string | null, hints: DimensionHint[], status: SubmissionEnvelope['status'],
  monthHb: number,
): SubmissionEnvelope => ({
  schema_version: '1.0', envelope_id: id,
  source: { kind: 'ms_forms_export', system: 'microsoft_forms', origin_file: `assessment-${yearMonth(at(monthHb))}.csv`, origin_row: form, form_submission_id: String(form) },
  team_id: teamId, team_name_raw: teamName,
  submitter: { name: who.name, email: who.email, is_primary_contact: true },
  submitted_at: formsStamp(at(hb + 3)), ingested_at: at(ingestedHb), assessment_date: formsDate(at(hb + 3)),
  self_certified: true, supersedes, dimension_hints: hints, status, revision: rev,
});

export function buildSubmissions(ctx: ContentContext): Record<string, Record<string, SubmissionEnvelope>> {
  const jordan = { name: 'Jordan Lee', email: 'jordan.lee@example.com' };
  const ctxFor = (team: TeamSeed, dim: string): string => {
    const uri = team.dims[dim]?.steps[0]?.uri;
    if (!uri || uri.startsWith('touchpoint://')) return 'Nothing was linked for this answer.';
    const tail = fill(uri).split('/').filter(Boolean).pop() ?? uri;
    return `Linked: ${tail.replace(/^#/, '')}`;
  };
  const t2 = TEAM_002;
  const r3Hints = ctx.dimensionIds.map((d) => hintFor(ctx, d, t2.dims[d]!.claim ?? 0, t2.dims[d]!.ans ?? '', ctxFor(t2, d)));
  const r1: DimensionHint[] = [
    hintFor(ctx, '1', 3, 'CI runs on push for most repos.', 'Nothing was linked for this answer.'),
    hintFor(ctx, '2', 2, 'We deploy via a manual runbook today.', 'Nothing was linked for this answer.'),
  ];
  const r2: DimensionHint[] = [
    hintFor(ctx, '1', 4, 'CI runs automatically on all our repositories, and a passing build and test is required before code can be merged.', 'Linked: .gitlab-ci.yml'),
    hintFor(ctx, '2', 4, 'We track release success rate and rollbacks, and we rehearse our rollback procedure.', 'Nothing was linked for this answer.'),
    hintFor(ctx, '3', 3, 'Configuration is applied through Helm and Kustomize, and secrets rotate on a schedule.', 'Linked: automation.md'),
  ];
  const t3 = TEAM_003;
  const t3Hints = ['1', '2', '3', '4'].map((d) => hintFor(ctx, d, t3.dims[d]!.claim ?? 0, t3.dims[d]!.ans ?? '', 'Nothing was linked for this answer.'));
  const t5 = TEAM_005;
  const t5Hints = ['1', '2', '3'].map((d) => hintFor(ctx, d, t5.dims[d]!.claim ?? 0, t5.dims[d]!.ans ?? '', 'Nothing was linked for this answer.'));
  const id1 = ENVELOPE.t2r1(); const id2 = ENVELOPE.t2r2(); const id3 = ENVELOPE.t2r3();
  return {
    'TEAM-002': {
      [id1]: baseEnvelope('TEAM-002', 'Kubernetes Operator', HB.t2R1, 5, jordan, id1, HB.t2R1, 1, null, r1, 'superseded', HB.t2R1),
      [id2]: baseEnvelope('TEAM-002', 'Kubernetes Operator', HB.t2R2, 5, jordan, id2, HB.t2R2, 2, id1, r2, 'superseded', HB.t2R1),
      [id3]: baseEnvelope('TEAM-002', 'Kubernetes Operator', HB.t2R3, 5, jordan, id3, HB.t2R3, 3, id2, r3Hints, 'committed', HB.t2R1),
    },
    'TEAM-003': {
      [ENVELOPE.t3()]: baseEnvelope('TEAM-003', 'Checkout Experience', HB.t3Form, 12, { name: 'Sam Okafor', email: 'sam.okafor@example.com' },
        ENVELOPE.t3(), HB.t3Form, 1, null, t3Hints, 'staged', HB.t3Form),
    },
    'TEAM-005': {
      [ENVELOPE.t5()]: baseEnvelope('TEAM-005', 'Notifications Service', HB.t5Form, 9, { name: 'Martina Kovacs', email: 'martina.kovacs@example.com' },
        ENVELOPE.t5(), HB.t5Form, 1, null, t5Hints, 'committed', HB.t5Form),
    },
  };
}
