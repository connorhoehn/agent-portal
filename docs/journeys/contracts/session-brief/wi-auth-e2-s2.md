# Session brief — wi-auth-e2-s2

> Assembled 2026-10-14 for run job-contract-wi-auth-e2-s2 · 2,649 of 6,000 tokens · brief-job-contract-wi-auth-e2-s2

## Your task
**Tenant-by-tenant cutover runbook with rollback** (story, 5 pts, Auth Migration)
Cannot be written until the cutover order is settled — smallest tenant first or riskiest first is still escalated.
Labels: decom, runbook, blocked.

## The project
**Auth Migration** — repo connorhoehnslalom/orgiq-auth-service. Parent epic: Legacy SSO decommission.

## Decisions that bind this work
- **Sunset legacy auth service** — resolved: Migrate remaining services off the v1 auth gateway before Q3 2026.

## Skills on this box
- **Recover a cold Aurora Data API** (skill-cold-start-aurora v2) — Use when the first Data API call after idle fails with HttpEndpointNotEnabled. Warms the endpoint and retries with backoff.
- **Triage a flaky test** (skill-flaky-test-triage v2) — Use when a test passes and fails without a code change. Reruns, diffs the outcomes, and files a bug with both logs.
- **Review a PR diff-scoped** (skill-pr-review-scoped v1) — Use when reviewing a pull request. Comments only on changed lines and posts one risk summary.

## Runbooks for this work

### 1. Cut one tenant over from SAML to Cognito (rb-tenant-cutover v1)
Included because: initiative p-auth-migration; labels decom, runbook; triggers on repo orgiq-auth-service; keywords tenant, cutover.
⚠ Last run failed at step 2: flag flipped but the hosted-UI redirect still resolved to the old domain — check that step before relying on it.

# Cut one tenant over from SAML to Cognito

Move one customer tenant's sign-in from the legacy SAML shim to Cognito without signing anyone out, with a five-minute way back.

## Use when

- You are cutting over a single tenant on the Auth Migration initiative.

## Not for

- Deleting the SAML shim, which waits until the last tenant has moved (see the d-legacy-auth decision).
- Choosing the order of tenants, which is still escalated (d-cognito-cutover).

## Before you start

- [ ] The tenant's Cognito app client exists and you know its id (`$CLIENT_ID`).
- [ ] The SAML shim is still running behind the per-tenant flag.
- [ ] You know the tenant's portal origin (`$ORIGIN`).

## Steps

1. **Confirm sign-in works on the shim before you touch anything.**
   ```bash
   curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled
   ```
   Expect `false` (the tenant is still on the shim).
2. **Flip only this tenant's flag, never several tenants in one change.**
   Expect this tenant's sign-in page sends you to the Cognito hosted UI while every other tenant still sees the shim.
3. **Sign in as a test user of this tenant and check no live session was dropped.**
   Expect sign-in on the first try and zero forced logouts in the session log.

## Verify

- `GET $ORIGIN/api/auth/config` reports `ssoEnabled: true`.
  ```bash
  curl -s "$ORIGIN/api/auth/config" | jq .ssoEnabled
  ```
- No `session_epoch` bump for this tenant's existing users.

## If it goes wrong

| Symptom | Likely cause | Do this |
|---|---|---|
| Users signed out mid-day | Flag flipped for more than one tenant | Roll back every tenant flipped in that change |
| The old SAML page still shows after the flip | The flag has not reached this tenant yet | Wait one grants refresh (about 2 minutes), then redo step 3 |

## Roll back

1. Flip this tenant's flag back, and the shim answers within one grants refresh (about 2 minutes).

## Selection hints

- Labels: decom, runbook, cutover
- Repos: orgiq-auth-service
- Tools: cognito
- Keywords: tenant, cutover, saml, cognito, sign-in, shim

## Notes

Existing sessions survive because a cutover never bumps `session_epoch`; only a tenant or role switch does, and that drops older cookies within about 120 seconds (convention art-007).
Treat the order of tenants as a parameter: this runbook covers one tenant.

### 2. Get an auth-service pull request through the CSRF check (rb-auth-pr-csrf-gate v1)
Included because: repo orgiq-auth-service; triggers on repo orgiq-auth-service.

# Get an auth-service pull request through the CSRF check

Read the CSRF evaluator before you push, fix what it flags in the code, and get the required check green instead of asking for an override.

## Use when

- You are changing sign-in, session or cookie code in orgiq-auth-service.
- The required CSRF check failed on your pull request.

## Not for

- Changing the evaluator itself (`lib-csrf-check`), which needs two sign-offs and a Library promotion.
- Disabling or skipping the check, which is required by decision and is not yours to waive.

## Before you start

- [ ] Your branch is pushed and you know its pull request number (`$PR`).
- [ ] You can read the Library (any orgiq role) and you have a signed-in cookie jar for the BFF (`$COOKIE_JAR`).

## Steps

1. **Look up the CSRF evaluator in the Library to see which version is judging you.**
   ```bash
   curl -s -b "$COOKIE_JAR" "$BFF/api/library/lib-csrf-check" | jq '{version: .asset.version, tier: .asset.tier}'
   ```
   Expect version 5 at endpoint tier.
2. **Read the CSRF check's result on your pull request.**
   ```bash
   gh pr checks "$PR" --repo connorhoehnslalom/orgiq-auth-service
   ```
   Expect the CSRF check listed as required, and on a failure its details link names the lines it judged as weakening.
3. **Fix each flagged line in the code, then push the fix to the pull request.**
   ```bash
   git push
   ```
   Expect the CSRF check starts again on the new commit.
   *Why: The diff reaches the evaluator fenced as untrusted input, so arguing in the description or comments cannot change a verdict.*
4. **Wait until every required check, the CSRF check among them, passes on the pull request.**
   ```bash
   gh pr checks "$PR" --repo connorhoehnslalom/orgiq-auth-service --required --watch
   ```
   Expect every required check reports `pass`.

## Verify

- The CSRF check passed on the latest commit of the pull request.
  ```bash
  gh pr checks "$PR" --repo connorhoehnslalom/orgiq-auth-service --required
  ```

## If it goes wrong

| Symptom | Likely cause | Do this |
|---|---|---|
| The check fails on a change that only renames code | An evaluator false positive | Ask the owner, Vera Green, to review the verdict, and never bypass the check |
| The check never starts | The pipeline could not reach the evaluator endpoint | Re-run it with `gh run rerun`, then tell the owner |
| The verdict changes when you edit the description | The diff reached the evaluator as instructions, not fenced data | Stop and report it as a security bug in `lib-csrf-check` |

## Roll back

1. Revert your fix commit if it broke the sign-in tests, and push the revert.
   ```bash
   git revert --no-edit HEAD && git push
   ```

## Selection hints

- Labels: session, oidc, jwt, csrf
- Repos: orgiq-auth-service
- Tools: gh
- Keywords: csrf, pull request, cookie, session, auth, check

## Notes

Decision art-004: every diff touching orgiq-auth-service runs the CSRF evaluator as a required check, because an advisory-only comment once let a CSRF-weakening change merge.

### 3. Bring SSO up on a new origin without breaking the picker (rb-sso-new-origin v1)
Included because: initiative p-auth-migration; triggers on repo orgiq-auth-service; keywords tenant.

# Bring SSO up on a new origin without breaking the picker

Turn on single sign-on for a new web address in the one order that keeps the account picker working while HTTPS is set up.

## Use when

- A tenant's portal is moving to, or adding, a new origin and SSO must work there.
- Sign-in broke the moment someone set the Cognito callback on a new address.

## Not for

- Cutting a tenant over from SAML (use rb-tenant-cutover).
- Changing which users may sign in, which is a grants change and not an origin change.

## Before you start

- [ ] You can edit the middleware environment for the new origin.
- [ ] You know the new host name (`$NEW_HOST`).

## Steps

1. **Leave the Cognito callback unset so the account picker keeps working.**
   ```bash
   grep -c '^COGNITO_CALLBACK_URL=' middleware/.env.aws
   ```
   Expect `0`, and the sign-in page on the new origin still shows the picker.
   *Why: Cognito rejects a non-localhost http callback before any app code runs, so setting it early takes sign-in down.*
2. **Test SSO locally first, on a localhost callback that Cognito allows over plain http.**
   ```bash
   curl -s http://localhost:5183/api/auth/config | jq .ssoEnabled
   ```
   Expect `true` locally, and a hosted-UI sign-in on localhost lands back in the portal.
3. **Put an HTTPS front door up on the new origin.**
   ```bash
   curl -sI "https://$NEW_HOST/api/health" | head -1
   ```
   Expect an HTTP 200 status line over https with a valid certificate.
4. **Set the callback for the new origin and restart the middleware.**
   ```bash
   printf 'COGNITO_CALLBACK_URL=https://%s/api/auth/callback\n' "$NEW_HOST" >> middleware/.env.aws
   ```
   Expect the middleware restarts with no Cognito error in its log.
5. **Confirm the new origin reports SSO as on.**
   ```bash
   curl -s "https://$NEW_HOST/api/auth/config" | jq .ssoEnabled
   ```
   Expect `true`.

## Verify

- A test user signs in through SSO on the new origin.
- The picker still works on localhost.
  ```bash
  curl -s http://localhost:5183/api/auth/config | jq .ssoEnabled
  ```

## If it goes wrong

| Symptom | Likely cause | Do this |
|---|---|---|
| Every sign-in fails right after step 4 | The callback is http on a non-localhost origin | Roll back, finish step 3, then redo step 4 |
| `redirect_mismatch` from the hosted UI | The app client's callback list lacks the new origin | Add the origin to the app client, then retry step 5 |

## Roll back

1. Remove the callback line and restart the middleware so the picker comes back.
   ```bash
   sed -i '' '/^COGNITO_CALLBACK_URL=/d' middleware/.env.aws
   ```

## Selection hints

- Labels: sso, oidc, auth
- Repos: orgiq-auth-service
- Tools: cognito
- Keywords: sso, origin, callback, picker, cognito, https, sign-in

## Notes

The Library skill `skill-sso-origin-bringup` is the invocable form of this runbook.

## How to report back
- When you finish, say which runbooks you followed: `lab applied rb-tenant-cutover followed` (or `lab applied rb-tenant-cutover failed --step 2 "why"`).
- If a runbook was wrong or missing a step, write the corrected markdown to a file and run `lab propose rb-tenant-cutover ./runbook.md` (or `lab propose new ./runbook.md`). A person reviews it.
- Record anything else you learned with `lab remember`.
