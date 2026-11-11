// What a simulated run's debrief hands back (docs/learning-loop-design.md, "The mock"; decision 19).
//
// One fixture teaches something: the logout cookie bug on Auth Migration, where deleting the legacy
// shim's cookie by name did nothing until the logout matched the Domain and Path the shim set it
// with. Its debrief returns the runbook below: written by hand, once, in the Halyard story's world,
// the procedure an engineer on that initiative would follow. It is NOT assembled at run time, it
// passes every lint rule (mock/__tests__/debrief-fixture.test.ts holds it to that), and everything
// it produces is marked as demo data: the run's debrief (`simulated`), the proposal
// (`debrief.simulated`) and the runbook version an accept writes (`demo_data`).
//
// The other fixtures debrief nothing: the cutover run and the dashboard run said they learned
// nothing (their Learned section says why there was no debrief), and the cold-start run failed.

/** The folder name the logout run's debrief writes under .lab/keep/. */
export const LOGOUT_SHIM_COOKIE_RUNBOOK = 'rb-logout-shim-cookie';

/** The debrief's structured answer for the logout run. */
export const LOGOUT_SHIM_COOKIE_ANSWER = {
  kind: 'new',
  reason: 'Deleting the shim cookie by name did nothing; the procedure for matching its Domain and Path would have saved the first hour.',
  folder: LOGOUT_SHIM_COOKIE_RUNBOOK,
} as const;

/** The SKILL.md the logout run's debrief wrote, verbatim. */
export const LOGOUT_SHIM_COOKIE_SKILL_MD = `---
name: rb-logout-shim-cookie
description: Clear the legacy SAML shim's session cookie when a user signs out of the BFF. Use when logout leaves the shim cookie alive and the next visit signs straight back in.
metadata:
  source: demo data, written by hand for the simulated logout run
---

# Clear the legacy shim cookie on logout

Make signing out of the BFF also expire the legacy SAML shim's session cookie, so the next visit lands on the Cognito hosted UI.

## Use when

- Signing out clears the BFF session but the next visit signs straight back in through the legacy shim.
- A logout fix deletes the shim cookie by name and the browser keeps it anyway.

## Not for

- Revoking a session on the server, which the refresh endpoint's session_revoked answer covers.

## Before you start

- [ ] You can reach the shim's sign-in page from your machine (\`$SHIM_ORIGIN\`).
- [ ] The logout end-to-end suite runs locally against a host under the parent domain.

## Steps

1. **Read the Domain and Path the shim sets its session cookie with.**
   \`\`\`bash
   curl -sI "$SHIM_ORIGIN/saml/login" | grep -i '^set-cookie: shim_session'
   \`\`\`
   Expect one Set-Cookie line with a Domain on the parent domain (leading dot) and a Path.
   *Why: A browser removes a cookie only when the Domain and Path match the ones it was set with.*
2. **Expire the shim cookie in the BFF logout handler with exactly that Domain and Path.**
   Expect the logout response to carry a second Set-Cookie for shim_session with Max-Age=0 and the same Domain and Path.
3. **Add a logout test that sets the shim cookie on the parent domain before signing out.**
   \`\`\`bash
   npx playwright test logout
   \`\`\`
   Expect the new case to fail before the fix and pass after it.
   *Why: A local origin has no parent domain, so a test on it cannot see the bug.*
4. **Run the unit tests.**
   \`\`\`bash
   npm test
   \`\`\`
   Expect every suite to pass.

## Verify

- The logout suite passes, including the parent-domain case.
  \`\`\`bash
  npx playwright test logout
  \`\`\`
- The unit tests pass.
  \`\`\`bash
  npm test
  \`\`\`

## If it goes wrong

| Symptom | Likely cause | Do this |
|---|---|---|
| The shim cookie is still there after logout | The Domain or Path differs from the shim's Set-Cookie | Copy both from step 1 exactly, including the leading dot |
| The new test passes before the fix | The test ran on an origin with no parent domain | Run it on a host under the parent domain |

## Roll back

1. Revert the logout handler change.
   \`\`\`bash
   git revert --no-edit "$FIX_COMMIT"
   \`\`\`

## Selection hints

- Labels: session, decom
- Keywords: logout, cookie, shim, saml, domain, path
`;

/** The kept folder, in the shape the worker posts (`.lab/keep/<name>/`): no scripts, the procedure is the point. */
export function logoutShimCookieFolder(): { name: string; skill_md: string; files: Array<{ path: string; content: string; mode: '644' | '755' }> } {
  return { name: LOGOUT_SHIM_COOKIE_RUNBOOK, skill_md: LOGOUT_SHIM_COOKIE_SKILL_MD, files: [] };
}
