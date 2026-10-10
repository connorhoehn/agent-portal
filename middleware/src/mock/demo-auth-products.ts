// What the three Computer Lab demo agents actually do — Auth Migration's open
// items, as work products the fake microVM (mock/devbox-shell.ts) can play.
//
// These are the `demo` scenario's rows of `devbox-work-products`
// (mock/devbox-workspace.ts). They exist for the same reason the default
// products do: a mock cannot write code, so what an offline run produces is
// declared, selected by a keyword the task prompt carries, and inspectable.
// The prompt is `renderWorkItemPrompt`'s (lib/bot-runner.ts) — the work item's
// TITLE on the first line — so each keyword below is a lower-cased fragment of
// one seeded item's title (mock/work-items.ts, ids from schema/seed_program.sql):
//
//   wi-auth-e2-b3  "Logout leaves the legacy shim cookie alive"     → agent A
//   wi-auth-e2-s2  "Tenant-by-tenant cutover runbook with rollback" → agent B
//   wi-auth-e1-b4  "Refresh loop when a grant is revoked mid-session" → agent C
//   wi-auth-e1-s3  "Session cookie hardening: max-age, rotation…"  → C's next
//
// What they add over a default product is the run's SHAPE: a TodoWrite plan
// (the real Claude Code plan wire shape — lab contract §1) that advances as
// steps land, and for B a question the run ends on (§2), with the work it does
// once a person answers. Diffs are real unified diffs whose hunk counts match
// their bodies, because the offline reviewer and the protected-paths gate read
// them (`**/auth/**` sends A's and C's to a human; B's runbook is docs only).

/** One narrated step: something said, a tool used, or both. */
export interface ProductStep {
  say?: string;
  tool?: { name: string; input: Record<string, unknown> };
  /** Plan item (0-based) this step finishes — the next one goes in flight. */
  done?: number;
}

/** The half of a run that happens after the operator answers its question. */
export interface AnsweredPhase {
  steps: ProductStep[];
  summary: string;
  costUsd: number;
}

const LOGOUT_DIFF = `diff --git a/src/auth/logout.ts b/src/auth/logout.ts
index 3c4d5e6..7f8a9b0 100644
--- a/src/auth/logout.ts
+++ b/src/auth/logout.ts
@@ -8,3 +8,6 @@ export function logout(res: Response): void {
   res.clearCookie(SESSION_COOKIE, cookieOptions(true));
+  // The SAML shim set its own cookie; clearing only ours left it alive, so
+  // the next visit silently re-authenticated through the shim.
+  res.clearCookie(LEGACY_SHIM_COOKIE, { path: '/', secure: true });
   res.status(204).end();
 }
diff --git a/tests/logout.test.ts b/tests/logout.test.ts
new file mode 100644
index 0000000..2b3c4d5
--- /dev/null
+++ b/tests/logout.test.ts
@@ -0,0 +1,7 @@
+import { logoutHeaders } from './helpers';
+
+describe('logout', () => {
+  it('clears the legacy shim cookie as well as the session', async () => {
+    expect(await logoutHeaders()).toContain('orgiq_saml_shim=;');
+  });
+});
`;

const RUNBOOK_DIFF = `diff --git a/docs/runbooks/saml-cutover.md b/docs/runbooks/saml-cutover.md
new file mode 100644
index 0000000..4d5e6f7
--- /dev/null
+++ b/docs/runbooks/saml-cutover.md
@@ -0,0 +1,10 @@
+# SAML shim cutover, tenant by tenant
+
+Order: smallest tenant first, one per day, so a bad cutover touches the
+fewest people and the rollback is rehearsed before it matters.
+
+1. Freeze the tenant's IdP config and snapshot its shim mapping.
+2. Point the tenant at Cognito; watch login success for one hour.
+3. Roll back by restoring the shim mapping if success drops below 99%.
+4. Only after 24 clean hours, delete the tenant's shim mapping.
+5. Record the cutover in the decommission log.
`;

const REFRESH_DIFF = `diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts
index 5e6f7a8..9b0c1d2 100644
--- a/src/auth/refresh.ts
+++ b/src/auth/refresh.ts
@@ -21,3 +21,6 @@ export async function refresh(req: Request, res: Response): Promise<void> {
   const grant = await currentGrant(req.session);
+  // A revoked grant is final: answer 401 with a terminal reason so the client
+  // stops retrying, instead of a 403 it reads as transient and loops on.
+  if (grant?.revoked) { res.status(401).json({ error: 'grant revoked', terminal: true }); return; }
   res.json(await mintSession(grant));
 }
`;

const HARDENING_DIFF = `diff --git a/src/auth/session-cookie.ts b/src/auth/session-cookie.ts
index 6f7a8b9..0c1d2e3 100644
--- a/src/auth/session-cookie.ts
+++ b/src/auth/session-cookie.ts
@@ -31,6 +31,7 @@ export function cookieOptions(secure: boolean): CookieOptions {
   return {
     httpOnly: true,
     sameSite: 'lax',
+    maxAge: SESSION_MAX_AGE_MS,
     secure,
     path: '/',
   };
`;

export interface DemoProductSeed {
  id: string;
  keyword: string;
  plan: string[];
  steps: ProductStep[];
  summary: string;
  diff: string;
  costUsd: number;
  question?: string;
  answered?: AnsweredPhase;
}

const read = (file_path: string) => ({ name: 'Read', input: { file_path } });
const edit = (file_path: string) => ({ name: 'Edit', input: { file_path } });
const write = (file_path: string) => ({ name: 'Write', input: { file_path } });
const grep = (pattern: string) => ({ name: 'Grep', input: { pattern } });
const bash = (command: string) => ({ name: 'Bash', input: { command } });

export function demoAuthProducts(): DemoProductSeed[] {
  return [
    // ── Agent A — a small bug, a clean fix, a change for review ──────────────
    {
      id: 'demo-logout-shim-cookie',
      keyword: 'legacy shim cookie',
      plan: [
        'Reproduce the surviving shim cookie after logout',
        'Clear the shim cookie in the logout handler',
        'Pin it with a logout test',
        'Run the auth test suite',
      ],
      steps: [
        { say: 'Starting with a reproduction: sign in through the shim, log out, and list what cookies survive.' },
        { tool: read('src/auth/logout.ts') },
        { tool: grep('orgiq_saml_shim') },
        { tool: bash('npm test -- logout'), say: 'Reproduced: orgiq_saml_shim is still set after logout.', done: 0 },
        { tool: edit('src/auth/logout.ts') },
        { say: 'Logout now clears the shim cookie alongside the session cookie.', done: 1 },
        { tool: write('tests/logout.test.ts'), done: 2 },
        { tool: bash('npm test -- auth') },
        { say: 'Auth suite is green, including the new logout case.', done: 3 },
      ],
      summary: 'Logout now clears the legacy SAML shim cookie as well as the session cookie, with a test that pins it.',
      diff: LOGOUT_DIFF,
      costUsd: 0.21,
    },
    // ── Agent B — blocked on a decision only a person can make ───────────────
    {
      id: 'demo-cutover-runbook',
      keyword: 'cutover runbook',
      plan: [
        'Read the shim consumer inventory',
        'Settle the cutover order',
        'Write the per-tenant cutover and rollback steps',
        'Add the runbook to the decommission docs',
      ],
      steps: [
        { say: 'Reading the inventory of consumers still on the SAML shim before drafting anything.' },
        { tool: read('docs/decom/shim-consumers.md') },
        { tool: grep('tenant') },
        { say: 'The inventory lists every tenant still on the shim, from the smallest to the riskiest.', done: 0 },
        { tool: read('docs/decisions/escalations.md') },
      ],
      question: 'The cutover order is still escalated and the runbook depends on it. Should I write it smallest-tenant-first or riskiest-tenant-first?',
      answered: {
        steps: [
          { say: 'Thanks — writing the runbook in that order.', done: 1 },
          { tool: write('docs/runbooks/saml-cutover.md') },
          { say: 'Each tenant gets a freeze, a watched cutover and a rollback trigger.', done: 2 },
          { tool: bash('npm run docs:lint') },
          { say: 'Runbook added to the decommission docs; docs lint is clean.', done: 3 },
        ],
        summary: 'Wrote the tenant-by-tenant SAML cutover runbook in the order you chose, with a rollback trigger per tenant.',
        costUsd: 0.16,
      },
      summary: 'Asked which cutover order to write the runbook in.',
      diff: RUNBOOK_DIFF,
      costUsd: 0.12,
    },
    // ── Agent C — a fix, then the envelope runs dry ──────────────────────────
    {
      id: 'demo-refresh-loop',
      keyword: 'refresh loop',
      plan: [
        'Trace the refresh retry on a revoked grant',
        'Return a terminal signal for a revoked grant',
        'Cover revocation mid-session in the refresh tests',
        'Run the auth test suite',
      ],
      steps: [
        { say: 'Tracing what the client sees when a grant is revoked mid-session.' },
        { tool: read('src/auth/refresh.ts') },
        { tool: grep('retryOn403') },
        { say: 'The server answers a revocation with a 403 the client treats as retryable — that is the loop.', done: 0 },
        { tool: edit('src/auth/refresh.ts'), done: 1 },
        { tool: edit('tests/refresh.integration.test.ts') },
        { tool: bash('npm test -- refresh'), done: 2 },
        { tool: bash('npm test -- auth') },
        { say: 'Revocation now ends the session cleanly; the auth suite is green.', done: 3 },
      ],
      summary: 'A revoked grant now answers a terminal 401, so the client stops its refresh loop; covered by an integration test.',
      diff: REFRESH_DIFF,
      costUsd: 0.24,
    },
    // ── What C reaches for next, and is not allowed to start ─────────────────
    {
      id: 'demo-session-cookie-hardening',
      keyword: 'session cookie hardening',
      plan: ['Set a max-age on the session cookie', 'Run the auth test suite'],
      steps: [
        { tool: edit('src/auth/session-cookie.ts'), done: 0 },
        { tool: bash('npm test -- auth'), done: 1 },
      ],
      summary: 'Gave the session cookie an explicit max-age.',
      diff: HARDENING_DIFF,
      costUsd: 0.19,
    },
  ];
}
