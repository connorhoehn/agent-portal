// Known-good runbooks: the design's §2.2 rewrite of art-010 (v1 and the demo's
// v2), and rewrites of art-009 and art-001 in the same shape. Every one must
// lint clean against the real tree and round-trip exactly. Lane C's
// mock/runbooks.seed.ts is the authoritative seed; these are the model's own
// passing fixtures and stay independent of it.
import type { Runbook, RunbookDoc } from '../../types.js';

const empty = { work_item_labels: [], repos: [], tools: [], keywords: [] };

export const tenantCutoverV1: RunbookDoc = {
  title: 'Cut one tenant over from SAML to Cognito',
  summary: "Move one customer tenant's sign-in from the legacy SAML shim to Cognito without signing anyone out, with a five-minute way back.",
  use_when: ['You are cutting over a single tenant on the Auth Migration initiative.'],
  not_for: ['Deleting the SAML shim: do that only after the last tenant (see the d-legacy-auth decision).'],
  triggers: { work_item_labels: ['decom', 'runbook', 'cutover'], repos: ['orgiq-auth-service'], tools: ['cognito'], keywords: ['tenant', 'cutover', 'saml', 'cognito', 'sign-in'] },
  preconditions: [
    "The tenant's Cognito app client exists and you know its id (`$CLIENT_ID`).",
    'The SAML shim is still running behind the per-tenant flag.',
    "You know the tenant's portal origin (`$ORIGIN`).",
  ],
  steps: [
    {
      do: 'Confirm sign-in works on the shim before you touch anything.',
      command: { lang: 'bash', text: 'curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled' },
      expect: '`false` (the tenant is still on the shim).',
    },
    { do: "Flip only this tenant's flag, never several tenants in one change." },
    {
      do: 'Sign in as a test user of this tenant and check no live session was dropped.',
      expect: 'sign-in on the first try and zero forced logouts in the session log.',
    },
  ],
  verify: [
    { check: '`GET $ORIGIN/api/auth/config` reports `ssoEnabled: true`.', command: { lang: 'bash', text: 'curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled' } },
    { check: "No `session_epoch` bump for this tenant's existing users." },
  ],
  failure_modes: [
    { symptom: 'Users signed out mid-day', cause: 'Flag flipped for more than one tenant', response: 'Roll back every tenant flipped in that change' },
  ],
  rollback: [{ do: "Flip this tenant's flag back, and the shim answers within one grants refresh (about 2 minutes)." }],
};

export const tenantCutoverV2: RunbookDoc = {
  ...tenantCutoverV1,
  steps: [
    tenantCutoverV1.steps[0]!,
    {
      do: "Add the Cognito callback for this tenant's origin to its app client.",
      command: {
        lang: 'bash',
        text: 'aws cognito-idp update-user-pool-client --user-pool-id "$POOL_ID" \\\n  --client-id "$CLIENT_ID" --callback-urls "$ORIGIN/api/auth/callback"',
      },
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
  notes: 'Cutover order between tenants is still escalated (d-cognito-cutover).\nTreat the order as a parameter; this runbook covers one tenant.',
};

export const ssoNewOrigin: RunbookDoc = {
  title: 'Bring SSO up on a new origin without breaking the picker',
  summary: 'Turn on single sign-on for a new web address in the one order that keeps the account picker working while HTTPS is set up.',
  use_when: ['A portal is moving to, or adding, a new origin and SSO must work there.'],
  not_for: ["Cutting a tenant over from SAML (use rb-tenant-cutover)."],
  triggers: { work_item_labels: ['sso', 'auth'], repos: ['orgiq-auth-service'], tools: ['cognito'], keywords: ['sso', 'origin', 'callback', 'picker', 'cognito'] },
  preconditions: ['You can edit the middleware environment for the new origin.'],
  steps: [
    {
      do: 'Leave the Cognito callback unset so the picker keeps working.',
      command: { lang: 'bash', text: 'grep -c COGNITO_CALLBACK_URL middleware/.env.aws' },
      expect: '`0`; the picker answers on the new origin.',
      why: 'Cognito rejects a non-localhost http callback before any app code runs.',
    },
    { do: 'Test SSO locally first, on a localhost callback that Cognito allows over http.' },
    { do: 'Put an HTTPS front door up on the new origin.', expect: 'the origin answers over https with a valid certificate.' },
    {
      do: 'Set the callback and confirm SSO is on for the new origin.',
      command: { lang: 'bash', text: 'curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled' },
      expect: '`true`.',
    },
  ],
  verify: [{ check: 'A test user signs in through SSO on the new origin, and the picker still works on localhost.' }],
  failure_modes: [
    { symptom: 'Every sign-in fails right after setting the callback', cause: 'The callback is http on a non-localhost origin', response: 'Unset it, finish step 3, then set it again' },
  ],
  rollback: [
    {
      do: 'Unset the callback and restart the middleware so the picker comes back.',
      command: { lang: 'bash', text: "sed -i '' '/^COGNITO_CALLBACK_URL=/d' middleware/.env.aws" },
    },
  ],
};

export const flakyRerunDiff: RunbookDoc = {
  title: 'Tell a flaky test from a real regression',
  summary: 'Rerun the failing test alone and diff the two runs before anyone opens a bug against the code.',
  use_when: ['A test failed in CI on a change that does not touch what the test covers.'],
  not_for: ['A test that fails the same way every time (that is a regression).'],
  triggers: { work_item_labels: ['flaky', 'ci'], repos: ['orgiq-observability'], tools: ['jest'], keywords: ['flaky', 'test', 'regression', 'rerun'] },
  preconditions: [],
  steps: [
    {
      do: 'Rerun the failing test alone, three times.',
      command: { lang: 'bash', text: 'for i in 1 2 3; do npx jest "$TEST_FILE" -t "$TEST_NAME" || echo "run $i failed"; done' },
      expect: 'the same result all three times if it is a real regression.',
    },
    { do: 'Compare the failing output with the passing output of the same test.', expect: 'a timing, ordering or port difference when the test is flaky.' },
  ],
  verify: [{ check: 'The test has a recorded verdict (flaky or regression) on its work item.' }],
  failure_modes: [],
  rollback: [],
};

export const GOOD_DOCS: Record<string, RunbookDoc> = {
  'rb-tenant-cutover@1': tenantCutoverV1,
  'rb-tenant-cutover@2': tenantCutoverV2,
  'rb-sso-new-origin@1': ssoNewOrigin,
  'rb-flaky-test-rerun-diff@1': flakyRerunDiff,
};

export const runbookRow = (id: string, scope: Runbook['scope'], over: Partial<Runbook> = {}): Runbook => ({
  id, scope, owner_person_id: 'p-001', status: 'published', current_version: 1,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', ...over,
});

export const EMPTY_TRIGGERS = empty;
