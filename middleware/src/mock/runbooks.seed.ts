// The runbook seed: the Auth Migration runbooks (tenant cutover, SSO on a new
// origin, the auth-service CSRF check), the open proposal from the run that
// failed a cutover, their application history and the one frozen brief.
// mock/runbooks-seed-seam.ts adds the tool runbooks (runbook-bundles.ts).
//
// Shape for the store:
//   RUNBOOK_DOCS / PROPOSAL_DOCS   static RunbookDocs, no timestamps
//   seedRunbooks()                 RunbookSeed[]: the row, its versions, its
//                                  applications and the presentation header
//   seedRunbookRows() / seedRunbookVersions() / seedRunbookApplications() /
//   seedRunbookProposals()         the same rows flattened per fixture
//
// Every timestamp is read from mock/core/clock.ts inside a factory, never at
// import. People are the seed cast (schema/seed_program.sql,
// providers/identity.ts).
import type {
  Runbook, RunbookApplication, RunbookDoc, RunbookHeader, RunbookProposal, RunbookScope, RunbookStatus, RunbookVersion, SessionBrief,
} from '../lib/runbooks/index.js';
import { findSimilar, lintRunbook, versionOf } from '../lib/runbooks/index.js';
import { assembleBrief, type BriefSkillLibrary } from '../lib/runbooks/brief.js';
import { BOX_SKILLS_DIR } from '../lib/runbooks/library.js';
import { clock } from './core/clock.js';

// ─── Cast and places ─────────────────────────────────────────────────────────

const PEOPLE = {
  'p-002': 'Vera Green',
} as const;
type PersonId = keyof typeof PEOPLE;

const REPO = {
  AUTH: 'connorhoehn/orgiq-auth-service',
} as const;

const bash = (...lines: string[]) => ({ lang: 'bash' as const, text: lines.join('\n') });

// ─── The runbooks ────────────────────────────────────────────────────────────

const authPrCsrfGate: RunbookDoc = {
  title: 'Get an auth-service pull request through the CSRF check',
  summary: 'Read the CSRF evaluator before you push, fix what it flags in the code, and get the required check green instead of asking for an override.',
  use_when: [
    'You are changing sign-in, session or cookie code in orgiq-auth-service.',
    'The required CSRF check failed on your pull request.',
  ],
  not_for: [
    'Changing the evaluator itself (`lib-csrf-check`), which needs two sign-offs and a Library promotion.',
    'Disabling or skipping the check, which is required by decision and is not yours to waive.',
  ],
  triggers: {
    work_item_labels: ['session', 'oidc', 'jwt', 'csrf'],
    repos: ['orgiq-auth-service'],
    tools: ['gh'],
    keywords: ['csrf', 'pull request', 'cookie', 'session', 'auth', 'check'],
  },
  preconditions: [
    'Your branch is pushed and you know its pull request number (`$PR`).',
    'You can read the Library (any orgiq role) and you have a signed-in cookie jar for the BFF (`$COOKIE_JAR`).',
  ],
  steps: [
    {
      do: 'Look up the CSRF evaluator in the Library to see which version is judging you.',
      command: bash('curl -s -b "$COOKIE_JAR" "$BFF/api/library/lib-csrf-check" | jq \'{version: .asset.version, tier: .asset.tier}\''),
      expect: 'version 5 at endpoint tier.',
    },
    {
      do: "Read the CSRF check's result on your pull request.",
      command: bash('gh pr checks "$PR" --repo connorhoehn/orgiq-auth-service'),
      expect: "the CSRF check listed as required, and on a failure its details link names the lines it judged as weakening.",
    },
    {
      do: 'Fix each flagged line in the code, then push the fix to the pull request.',
      command: bash('git push'),
      expect: 'the CSRF check starts again on the new commit.',
      why: 'The diff reaches the evaluator fenced as untrusted input, so arguing in the description or comments cannot change a verdict.',
    },
    {
      do: 'Wait until every required check, the CSRF check among them, passes on the pull request.',
      command: bash('gh pr checks "$PR" --repo connorhoehn/orgiq-auth-service --required --watch'),
      expect: 'every required check reports `pass`.',
    },
  ],
  verify: [
    {
      check: 'The CSRF check passed on the latest commit of the pull request.',
      command: bash('gh pr checks "$PR" --repo connorhoehn/orgiq-auth-service --required'),
    },
  ],
  failure_modes: [
    { symptom: 'The check fails on a change that only renames code', cause: 'An evaluator false positive', response: 'Ask the owner, Vera Green, to review the verdict, and never bypass the check' },
    { symptom: 'The check never starts', cause: 'The pipeline could not reach the evaluator endpoint', response: 'Re-run it with `gh run rerun`, then tell the owner' },
    { symptom: 'The verdict changes when you edit the description', cause: 'The diff reached the evaluator as instructions, not fenced data', response: 'Stop and report it as a security bug in `lib-csrf-check`' },
  ],
  rollback: [
    { do: 'Revert your fix commit if it broke the sign-in tests, and push the revert.', command: bash('git revert --no-edit HEAD && git push') },
  ],
  notes: 'Every diff touching orgiq-auth-service runs the CSRF evaluator as a required check, because an advisory-only comment once let a CSRF-weakening change merge.',
};

const ssoNewOrigin: RunbookDoc = {
  title: 'Bring SSO up on a new origin without breaking the picker',
  summary: 'Turn on single sign-on for a new web address in the one order that keeps the account picker working while HTTPS is set up.',
  use_when: [
    "A tenant's portal is moving to, or adding, a new origin and SSO must work there.",
    'Sign-in broke the moment someone set the Cognito callback on a new address.',
  ],
  not_for: [
    'Cutting a tenant over from SAML (use rb-tenant-cutover).',
    'Changing which users may sign in, which is a grants change and not an origin change.',
  ],
  triggers: {
    work_item_labels: ['sso', 'oidc', 'auth'],
    repos: ['orgiq-auth-service'],
    tools: ['cognito'],
    keywords: ['sso', 'origin', 'callback', 'picker', 'cognito', 'https', 'sign-in'],
  },
  preconditions: [
    'You can edit the middleware environment for the new origin.',
    'You know the new host name (`$NEW_HOST`).',
  ],
  steps: [
    {
      do: 'Leave the Cognito callback unset so the account picker keeps working.',
      command: bash("grep -c '^COGNITO_CALLBACK_URL=' middleware/.env.aws"),
      expect: '`0`, and the sign-in page on the new origin still shows the picker.',
      why: 'Cognito rejects a non-localhost http callback before any app code runs, so setting it early takes sign-in down.',
    },
    {
      do: 'Test SSO locally first, on a localhost callback that Cognito allows over plain http.',
      command: bash('curl -s http://localhost:5183/api/auth/config | jq .ssoEnabled'),
      expect: '`true` locally, and a hosted-UI sign-in on localhost lands back in the portal.',
    },
    {
      do: 'Put an HTTPS front door up on the new origin.',
      command: bash('curl -sI "https://$NEW_HOST/api/health" | head -1'),
      expect: 'an HTTP 200 status line over https with a valid certificate.',
    },
    {
      do: 'Set the callback for the new origin and restart the middleware.',
      command: bash('printf \'COGNITO_CALLBACK_URL=https://%s/api/auth/callback\\n\' "$NEW_HOST" >> middleware/.env.aws'),
      expect: 'the middleware restarts with no Cognito error in its log.',
    },
    {
      do: 'Confirm the new origin reports SSO as on.',
      command: bash('curl -s "https://$NEW_HOST/api/auth/config" | jq .ssoEnabled'),
      expect: '`true`.',
    },
  ],
  verify: [
    { check: 'A test user signs in through SSO on the new origin.' },
    { check: 'The picker still works on localhost.', command: bash('curl -s http://localhost:5183/api/auth/config | jq .ssoEnabled') },
  ],
  failure_modes: [
    { symptom: 'Every sign-in fails right after step 4', cause: 'The callback is http on a non-localhost origin', response: 'Roll back, finish step 3, then redo step 4' },
    { symptom: '`redirect_mismatch` from the hosted UI', cause: "The app client's callback list lacks the new origin", response: 'Add the origin to the app client, then retry step 5' },
  ],
  rollback: [
    {
      do: 'Remove the callback line and restart the middleware so the picker comes back.',
      command: bash("sed -i '' '/^COGNITO_CALLBACK_URL=/d' middleware/.env.aws"),
    },
  ],
  };

const tenantCutoverV1: RunbookDoc = {
  title: 'Cut one tenant over from SAML to Cognito',
  summary: "Move one customer tenant's sign-in from the legacy SAML shim to Cognito without signing anyone out, with a five-minute way back.",
  use_when: ['You are cutting over a single tenant on the Auth Migration initiative.'],
  not_for: [
    'Deleting the SAML shim, which waits until the last tenant has moved (see the d-legacy-auth decision).',
    'Choosing the order of tenants, which is still escalated (d-cognito-cutover).',
  ],
  triggers: {
    work_item_labels: ['decom', 'runbook', 'cutover'],
    repos: ['orgiq-auth-service'],
    tools: ['cognito'],
    keywords: ['tenant', 'cutover', 'saml', 'cognito', 'sign-in', 'shim'],
  },
  preconditions: [
    "The tenant's Cognito app client exists and you know its id (`$CLIENT_ID`).",
    'The SAML shim is still running behind the per-tenant flag, a parameter at `/auth/tenants/$TENANT/idp` that reads `saml`.',
    "You know the tenant's portal origin (`$ORIGIN`).",
  ],
  steps: [
    {
      do: 'Confirm sign-in works on the shim before you touch anything.',
      command: bash('curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled'),
      expect: '`false` (the tenant is still on the shim).',
    },
    {
      do: "Flip only this tenant's flag, never several tenants in one change.",
      command: bash('aws ssm put-parameter --name "/auth/tenants/$TENANT/idp" --value cognito --type String --overwrite'),
      expect: "a new parameter `Version`, and this tenant's sign-in page sends you to the Cognito hosted UI while every other tenant still sees the shim.",
      why: 'One tenant per change keeps the blast radius to one customer and the rollback to one parameter.',
    },
    {
      do: 'Sign in as a test user of this tenant and check no live session was dropped.',
      command: bash(
        'aws logs filter-log-events --log-group-name /auth/bff --start-time "$(( ($(date +%s) - 900) * 1000 ))" \\',
        '  --filter-pattern "{ $.event = \\"forced_logout\\" && $.tenant = \\"$TENANT\\" }" --query \'length(events)\'',
      ),
      expect: '`0` forced logouts in the last 15 minutes, and the test user signs in on the first try.',
    },
  ],
  verify: [
    { check: '`GET $ORIGIN/api/auth/config` reports `ssoEnabled: true`.', command: bash('curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled') },
    { check: "No `session_epoch` bump for this tenant's existing users." },
  ],
  failure_modes: [
    { symptom: 'Users signed out mid-day', cause: 'Flag flipped for more than one tenant', response: 'Roll back every tenant flipped in that change' },
    { symptom: 'The old SAML page still shows after the flip', cause: 'The flag has not reached this tenant yet', response: 'Wait one grants refresh (about 2 minutes), then redo step 3' },
  ],
  rollback: [{
    do: "Flip this tenant's flag back, and the shim answers within one grants refresh (about 2 minutes).",
    command: bash('aws ssm put-parameter --name "/auth/tenants/$TENANT/idp" --value saml --type String --overwrite'),
  }],
  notes: 'Existing sessions survive because a cutover never bumps `session_epoch`; only a tenant or role switch does, and that drops older cookies within about 120 seconds.\nTreat the order of tenants as a parameter: this runbook covers one tenant.',
};

// ─── v2 of rb-tenant-cutover: the open edit from the failed run ──────────────
// Run sess-auth-06 failed at the flip because the hosted-UI redirect still
// pointed at the old domain; the proposal adds a new step 2.

const tenantCutoverV2Proposed: RunbookDoc = {
  ...tenantCutoverV1,
  preconditions: [
    ...tenantCutoverV1.preconditions,
    'You know the user pool id (`$POOL_ID`).',
  ],
  steps: [
    tenantCutoverV1.steps[0]!,
    {
      do: "Add the Cognito callback for this tenant's origin to its app client.",
      command: bash(
        'aws cognito-idp update-user-pool-client --user-pool-id "$POOL_ID" \\',
        '  --client-id "$CLIENT_ID" --callback-urls "$ORIGIN/api/auth/callback"',
      ),
      expect: "the response's `CallbackURLs` to list `$ORIGIN/api/auth/callback`.",
      why: 'The second pilot run failed at the flip because the redirect still pointed at the old domain.',
    },
    tenantCutoverV1.steps[1]!,
    tenantCutoverV1.steps[2]!,
  ],
  failure_modes: [
    { symptom: 'Sign-in bounces to the old service', cause: 'Callback list not updated (step 2 skipped)', response: 'Roll back, then redo step 2' },
    ...tenantCutoverV1.failure_modes,
  ],
};

// ─── New runbooks proposed by runs and people ────────────────────────────────

/** Every RunbookDoc in this seed, keyed `<runbook id>@<version>`. */
export const RUNBOOK_DOCS: Record<string, RunbookDoc> = {
  'rb-auth-pr-csrf-gate@1': authPrCsrfGate,
  'rb-sso-new-origin@1': ssoNewOrigin,
  'rb-tenant-cutover@1': tenantCutoverV1,
};

/** The documents the open proposals carry, keyed by proposal id. */
export const PROPOSAL_DOCS: Record<string, RunbookDoc> = {
  'prop-tenant-cutover-callback': tenantCutoverV2Proposed,
};

// ─── Rows ────────────────────────────────────────────────────────────────────

export interface RunbookSeed {
  runbook: Runbook;
  versions: RunbookVersion[];
  applications: RunbookApplication[];
  /** Presentation around the stored markdown (renderRunbook's second argument). */
  header: RunbookHeader;
}

interface Spec {
  id: string;
  doc: RunbookDoc;
  scope: RunbookScope;
  scope_label: string;
  owner: PersonId;
  status: RunbookStatus;
  /** Hours ago: the source artifact's created_at, and the v1 acceptance (its review, or creation when never reviewed). */
  created_h: number;
  accepted_h: number;
  provenance: RunbookVersion['provenance'];
  /** [run_ref, hours ago, outcome, failed_at_step, note] */
  runs: Array<[string, number, RunbookApplication['outcome'], number | null, string | null]>;
  story: string;
}

function specs(): Spec[] {
  return [



    {
      id: 'rb-auth-pr-csrf-gate', doc: authPrCsrfGate,
      scope: { kind: 'repo', ref: REPO.AUTH }, scope_label: 'repo orgiq-auth-service', owner: 'p-002', status: 'published',
      created_h: 70, accepted_h: 60,
      provenance: { run_refs: [], session_ids: ['sess-auth-01'], lab_experience_ids: [], source_artifact_ids: [] },
      runs: [['sess-auth-05', 12, 'followed', null, null], [FROZEN_RUN.runRef, 3, 'followed', null, null]],
      story: 'Written from the run notes of session sess-auth-01.',
    },


    {
      id: 'rb-sso-new-origin', doc: ssoNewOrigin,
      scope: { kind: 'initiative', ref: 'p-auth-migration' }, scope_label: 'Auth Migration', owner: 'p-002', status: 'published',
      created_h: 10, accepted_h: 8,
      provenance: { run_refs: [], session_ids: ['sess-auth-02'], lab_experience_ids: [], source_artifact_ids: [] },
      runs: [
        ['sess-auth-04', 8, 'followed', null, null], ['sess-auth-05', 5, 'followed', null, null],
        ['sess-auth-06', 2.2, 'followed', null, null], ['sess-auth-04', 1, 'followed', null, null],
      ],
      story: 'Written from the run notes of session sess-auth-02.',
    },
    {
      id: 'rb-tenant-cutover', doc: tenantCutoverV1,
      scope: { kind: 'initiative', ref: 'p-auth-migration' }, scope_label: 'Auth Migration', owner: 'p-002', status: 'published',
      created_h: 10, accepted_h: 10,
      provenance: { run_refs: [], session_ids: ['sess-auth-02'], lab_experience_ids: [], source_artifact_ids: [] },
      runs: [
        ['sess-auth-05', 6, 'followed', null, null],
        ['sess-auth-06', 2, 'failed', 2, 'flag flipped but the hosted-UI redirect still resolved to the old domain'],
      ],
      story: 'Written from the run notes of session sess-auth-02. Run sess-auth-06 failed at step 2, the flip.',
    },

  ];
}

function header(s: Spec): RunbookHeader {
  return { id: s.id, version: 1, scope_label: s.scope_label, owner_name: PEOPLE[s.owner], provenance: s.story };
}

// ─── The one frozen brief ────────────────────────────────────────────────────
// auth-dep-watch's firing of today (mock/bots.ts `job-auth-maint-1`: done, "bumped the JWT library in the
// token verifier; the OIDC conformance suite is green", 238 s) is the one seeded run that started after the
// runbooks existed (they were accepted 45-60 h ago), so it is the run whose brief was frozen. It is a
// scheduled run, so it has no work item: the brief carries the project and the CSRF-gate runbook the
// auth-service repo scope selected. Its start is the bot run's own (clock.hoursAgo(3, keepWithinToday)).
export const FROZEN_RUN = { runRef: 'job-auth-maint-1', briefId: 'brief-job-auth-maint-1', startedHoursAgo: 3, seconds: 238 } as const;
const frozenRunStartMs = () => Date.parse(clock.hoursAgo(FROZEN_RUN.startedHoursAgo, { keepWithinToday: true }));
const frozenRunFinishedAt = () => new Date(Math.min(frozenRunStartMs() + FROZEN_RUN.seconds * 1000, Date.parse(clock.nowIso()))).toISOString();

/**
 * The briefs frozen on seeded runs: assembled when the job was claimed, a few seconds before it started.
 * R8: a brief records the org's skill library its box synced (`library`, from the seam: every
 * published runbook, tools included); without one, this module's own runbooks stand in.
 */
export function seedBriefs(library?: BriefSkillLibrary | null): SessionBrief[] {
  const lib = library ?? {
    sha256: '0'.repeat(64), dir: BOX_SKILLS_DIR,
    skills: seedRunbooks().filter((x) => x.runbook.status === 'published').map((x) => ({ name: x.runbook.id, version: x.runbook.current_version })).sort((p, q) => (p.name < q.name ? -1 : 1)),
  };
  return [assembleBrief({
    run_ref: FROZEN_RUN.runRef,
    brief_id: FROZEN_RUN.briefId,
    assembled_at: new Date(frozenRunStartMs() - 20_000).toISOString(),
    framing: 'You are running unattended as the auth-dep-watch bot. Nobody can answer a question: do the task, say what you did, and stop.',
    work_item: null,
    initiative: { id: 'p-auth-migration', name: 'Auth Migration', repo: REPO.AUTH },
    repo: REPO.AUTH,
    decisions: [],
    skill_library: lib,
  })];
}

/** One RunbookSeed per runbook, timestamps read from the clock now. */
export function seedRunbooks(): RunbookSeed[] {
  return specs().map((s) => {
    const createdAt = clock.hoursAgo(s.created_h);
    const acceptedAt = clock.hoursAgo(s.accepted_h);
    const apps: RunbookApplication[] = s.runs.map(([runRef, h, outcome, failedAt, note], k) => ({
      id: `rba-${s.id.slice(3)}-${k + 1}`,
      runbook_id: s.id, version: 1, run_ref: runRef,
      // Most seeded runs predate session briefs: nothing was frozen for them, so
      // there is no brief to name (RunbookApplication.brief_id is nullable for it).
      // The one job that ran after the runbooks existed was handed a frozen brief.
      brief_id: runRef === FROZEN_RUN.runRef ? FROZEN_RUN.briefId : null,
      outcome, failed_at_step: failedAt, note,
      at: runRef === FROZEN_RUN.runRef ? frozenRunFinishedAt() : clock.hoursAgo(h),
    }));
    return {
      runbook: {
        id: s.id, scope: s.scope, owner_person_id: s.owner, status: s.status, current_version: 1,
        created_at: createdAt, updated_at: acceptedAt,
      },
      versions: [versionOf({
        runbook_id: s.id, version: 1, doc: s.doc, author: { kind: 'person', id: s.owner },
        proposal_id: null, accepted_by: s.owner, accepted_at: acceptedAt, provenance: s.provenance,
      })],
      applications: apps,
      header: header(s),
    };
  });
}

export const seedRunbookRows = (): Runbook[] => seedRunbooks().map((s) => s.runbook);
export const seedRunbookVersions = (): RunbookVersion[] => seedRunbooks().flatMap((s) => s.versions);
export const seedRunbookApplications = (): RunbookApplication[] => seedRunbooks().flatMap((s) => s.applications);

// ─── Proposals ───────────────────────────────────────────────────────────────

export function seedRunbookProposals(): RunbookProposal[] {
  const published = specs()
    .filter((s) => s.status === 'published')
    .map((s) => ({ runbook_id: s.id, scope: s.scope, doc: s.doc }));
  const proposal = (p: Omit<RunbookProposal, 'lint' | 'similar' | 'status' | 'decided_by' | 'decided_at' | 'note' | 'merged_into'>, scope: RunbookScope): RunbookProposal => ({
    ...p,
    lint: p.proposed ? lintRunbook(p.proposed) : [],
    similar: p.kind === 'new' && p.proposed ? findSimilar(p.proposed, scope, published) : [],
    status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null,
  });
  return [
    proposal({
      id: 'prop-tenant-cutover-callback', kind: 'edit', runbook_id: 'rb-tenant-cutover', base_version: 1,
      proposed: tenantCutoverV2Proposed,
      rationale: 'Run sess-auth-06 followed v1 and failed at step 2: the flag flipped but the hosted-UI redirect still resolved to the old domain, because the tenant\'s origin was never on its Cognito app client\'s callback list. This adds that as a new step 2, before the flip, and a failure-mode row for the symptom.',
      source: { kind: 'run', run_ref: 'sess-auth-06', session_id: 'sess-auth-06', work_item_id: 'wi-auth-e2-s2', lab_experience_ids: [] },
      created_at: clock.hoursAgo(1.6),
    }, { kind: 'initiative', ref: 'p-auth-migration' }),
  ];
}

// ─── The whole default world, in the seam's shape ────────────────────────────

/** The five arrays the store's fixtures hold (mock/runbooks-seed-seam.ts `RunbookSeedRows`). */
export interface RunbookSeedWorld {
  runbooks: Runbook[];
  versions: RunbookVersion[];
  proposals: RunbookProposal[];
  applications: RunbookApplication[];
  /** Frozen on dispatch or claim; one seeded run (FROZEN_RUN) started after the runbooks existed. */
  briefs: SessionBrief[];
}

export function runbookSeedWorld(): RunbookSeedWorld {
  const seeds = seedRunbooks();
  return {
    runbooks: seeds.map((s) => s.runbook),
    versions: seeds.flatMap((s) => s.versions),
    proposals: seedRunbookProposals(),
    applications: seeds.flatMap((s) => s.applications),
    briefs: seedBriefs(),
  };
}
