// The offline devbox workspace — what a microVM's checkout looks like with no
// microVM.
//
// WHY THIS EXISTS. Everything downstream of `dispatchGovernedRun` talks to a
// real AgentCore runtime: `lib/project-runner.ts` shells `git status` into it
// to find out what a run changed, `lib/sdlc-pipeline.ts` shells `git diff` and
// `git commit` into it to capture and pin the change, `lib/change-delivery.ts`
// shells `git cat-file` into it to check the change is still there. Offline
// every one of those throws, so a governed run produced no change, the
// governance pipeline never ran, and the whole capture → review → gate →
// deliver loop was unreachable in `dev:mock` even though every provider under
// it was mocked. The devbox is not a provider, so the write-path judge never
// saw it either.
//
// WHAT IT MODELS. One work branch per devbox session: a list of commits and,
// when a run has left work behind, the uncommitted change on top of them. That
// is exactly the amount of git the pipeline asks about — is the tree dirty,
// what is the diff, commit it and give me the sha, does this sha still exist,
// roll back to its parent. Nothing else is modelled and nothing else is
// pretended: `mock/devbox-shell.ts` answers an unrecognised command with a
// `fatal:` line, which every caller already treats as a git failure, so a new
// probe added upstream fails loudly here instead of silently reading as "the
// tree is clean".
//
// WHAT THE AGENT WRITES. A mock cannot write code, so it cannot invent a diff
// for an arbitrary prompt without lying about what it did. Instead the work
// products below are declared, and a run selects one by a stated keyword in
// its prompt — so what an offline run produces is predictable, inspectable,
// and covers the three branches the gate engine actually has: a clean change
// that auto-approves, a change the reviewer sends back, and a clean change on
// a protected path that needs a human.

import { createHash } from 'node:crypto';
import { clock, defineFixture } from './core/index.js';
import { diffFiles, diffStat } from './static-review.js';
import { demoAuthProducts, type AnsweredPhase, type ProductStep } from './demo-auth-products.js';

// ─── Work products ──────────────────────────────────────────────────────────
//
// Real unified diffs with hunk headers whose `+` counts match their bodies —
// the reviewer pins findings to new-side line numbers inside these hunks, and
// `parsePorcelainFiles` and the protected-paths gate both read these paths.

const SAMPLER_DIFF = `diff --git a/src/collector/sampler.ts b/src/collector/sampler.ts
index 2a1b3c4..5d6e7f8 100644
--- a/src/collector/sampler.ts
+++ b/src/collector/sampler.ts
@@ -14,7 +14,12 @@ export interface SamplerConfig {
 export function shouldSample(cfg: SamplerConfig, traceId: string): boolean {
-  return Math.random() < cfg.rate;
+  // Deterministic per trace: a random draw per span meant one trace was
+  // sampled in some services and dropped in others, so a trace that was kept
+  // arrived with holes in it.
+  const h = [...traceId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
+  return (h % 10_000) / 10_000 < cfg.rate;
 }
diff --git a/src/collector/sampler.test.ts b/src/collector/sampler.test.ts
new file mode 100644
index 0000000..9a8b7c6
--- /dev/null
+++ b/src/collector/sampler.test.ts
@@ -0,0 +1,8 @@
+import { shouldSample } from './sampler';
+
+describe('shouldSample', () => {
+  it('is stable for one trace id', () => {
+    const cfg = { rate: 0.5 };
+    expect(shouldSample(cfg, 'abc123')).toBe(shouldSample(cfg, 'abc123'));
+  });
+});
`;

const THROTTLE_DIFF = `diff --git a/src/alerts/throttle.ts b/src/alerts/throttle.ts
index 7c8d9e0..1f2a3b4 100644
--- a/src/alerts/throttle.ts
+++ b/src/alerts/throttle.ts
@@ -22,9 +22,13 @@ export class Throttle {
   admit(alert: Alert): boolean {
-    validateWindow(this.windowMs);
     const seen = this.counts.get(alert.name) ?? 0;
+    console.log('throttle', alert.name, seen);
     if (seen >= this.limit) return false;
     this.counts.set(alert.name, seen + 1);
+    // TODO: the window never resets, so this throttles for ever after the
+    // first burst. Needs a sweep on an interval.
     return true;
   }
 }
`;

const AUTH_COOKIE_DIFF = `diff --git a/src/auth/session-cookie.ts b/src/auth/session-cookie.ts
index 4b5c6d7..8e9f0a1 100644
--- a/src/auth/session-cookie.ts
+++ b/src/auth/session-cookie.ts
@@ -31,6 +31,7 @@ export function cookieOptions(secure: boolean): CookieOptions {
   return {
     httpOnly: true,
     sameSite: 'lax',
+    partitioned: secure,
     secure,
     path: '/',
   };
 }
`;

/**
 * What a run that changed nothing still cost.
 *
 * A run with no work product is not a free run — the agent was invoked, read
 * the repository and answered. Named rather than written inline so it reads as
 * a declared price for a declared outcome.
 */
export const IDLE_RUN_COST_USD = 0.01;

/** What an offline run leaves in the checkout. */
export interface WorkProduct {
  id: string;
  /**
   * Lower-cased substring of the task prompt that selects this product.
   * `null` is the fallback — exactly one product may declare it.
   */
  keyword: string | null;
  /** The agent's own closing answer, as `result.result` on the wire. */
  summary: string;
  /** Tool calls the transcript records, in order. */
  toolCalls: Array<{ name: string; target: string }>;
  diff: string;
  /** Dollars the runtime reports for the run — `result.total_cost_usd`. */
  costUsd: number;
  /**
   * The run's plan, emitted as the TodoWrite checklist a Claude Code run keeps
   * (lab contract §1). When present the run is narrated from `steps` rather
   * than `toolCalls`, re-emitting the plan as each step finishes an item.
   */
  plan?: string[];
  steps?: ProductStep[];
  /**
   * A question the run ends on instead of finishing (lab contract §2): the
   * last assistant text ends with '?' and the run stays open until somebody
   * answers it on the same session. Nothing is staged until then — `answered`
   * is the work the agent does once it has its answer.
   */
  question?: string;
  answered?: AnsweredPhase;
  /** `'demo'` paces each event by the demo's beat (mock/demo-pace.ts). */
  pace?: 'demo';
}

function defaultProducts(): WorkProduct[] {
  return [
    {
      id: 'throttle',
      keyword: 'noise',
      summary: 'Added a per-alert admission counter to the throttle so a flapping alert stops paging after the limit.',
      toolCalls: [
        { name: 'Read', target: 'src/alerts/throttle.ts' },
        { name: 'Edit', target: 'src/alerts/throttle.ts' },
      ],
      diff: THROTTLE_DIFF,
      costUsd: 0.11,
    },
    {
      id: 'auth-cookie',
      keyword: 'cookie',
      summary: 'Set the Partitioned attribute on the session cookie when it is issued over a secure connection.',
      toolCalls: [
        { name: 'Grep', target: 'cookieOptions' },
        { name: 'Edit', target: 'src/auth/session-cookie.ts' },
      ],
      diff: AUTH_COOKIE_DIFF,
      costUsd: 0.07,
    },
    {
      id: 'sampler',
      keyword: null,
      summary: 'Made trace sampling deterministic per trace id and pinned it with a test.',
      toolCalls: [
        { name: 'Read', target: 'src/collector/sampler.ts' },
        { name: 'Edit', target: 'src/collector/sampler.ts' },
        { name: 'Write', target: 'src/collector/sampler.test.ts' },
      ],
      diff: SAMPLER_DIFF,
      costUsd: 0.09,
    },
  ];
}

/**
 * The work an offline agent can do.
 *
 * `default` — three products covering the three branches `evaluate()` has:
 *             `sampler` is clean and untouched by any policy (auto-approves),
 *             `throttle` earns real reviewer findings (comes back
 *             changes_requested), and `auth-cookie` is clean but lands on a
 *             `**​/auth/**` path the protected-paths policy routes to a human.
 * `empty`   — an agent that changes nothing. Declared, because "the run
 *             finished and there was nothing to govern" is a real outcome the
 *             pipeline handles separately and should be reachable offline.
 * `demo`    — the Computer Lab demo's Auth Migration agents
 *             (mock/demo-auth-products.ts) ahead of the default three.
 */
export const devboxWorkProducts = defineFixture<WorkProduct>({
  key: 'devbox-work-products',
  scenarios: {
    default: () => defaultProducts(),
    empty: () => [],
    // The Computer Lab demo's agents, FIRST so their keywords win over the
    // defaults' (`cookie` would otherwise claim the logout bug), then the
    // default three so any other prompt still lands where it always did.
    demo: () => [
      ...demoAuthProducts().map((p): WorkProduct => ({
        ...p,
        // The transcript's tool list, read off the narrated steps rather
        // than restated beside them.
        toolCalls: [...p.steps, ...(p.answered?.steps ?? [])]
          .filter((st) => st.tool)
          .map((st) => ({
            name: st.tool!.name,
            target: String(st.tool!.input['file_path'] ?? st.tool!.input['command'] ?? st.tool!.input['pattern'] ?? ''),
          })),
        pace: 'demo',
      })),
      ...defaultProducts(),
    ],
  },
});

/**
 * Which product a prompt asks for.
 *
 * First declared keyword the prompt contains, else the fallback. Returns null
 * when the fixture is empty or declares no fallback — the caller renders that
 * as a run that changed nothing, which is a state the pipeline already has.
 */
export function selectWorkProduct(prompt: string): WorkProduct | null {
  const p = prompt.toLowerCase();
  const rows = devboxWorkProducts.rows();
  return rows.find((w) => w.keyword !== null && p.includes(w.keyword))
    ?? rows.find((w) => w.keyword === null)
    ?? null;
}

// ─── Workspaces ─────────────────────────────────────────────────────────────

/** One devbox session's work branch. */
export interface MockWorkspace {
  sessionId: string;
  /** Commit shas, oldest first. Never empty — a checkout has a base commit. */
  commits: string[];
  /** Uncommitted work on top of the commits; null when the tree is clean. */
  pending: { diff: string; files: string[] } | null;
  /** When this workspace was first touched — the clone, in effect. */
  openedAt: string;
}

/**
 * Live workspaces.
 *
 * `default` — none. Offline there is no microVM until something runs in one,
 *             which is also true online: a session exists because a clone or a
 *             run created it. Rows appear as sessions are used and
 *             `POST /api/__mock/reset` takes them away again, so an auditor
 *             never inherits the previous auditor's dirty tree.
 */
export const devboxWorkspaces = defineFixture<MockWorkspace>({
  key: 'devbox-workspaces',
  scenarios: { default: () => [] },
});

/**
 * A sha for the nth commit of a session.
 *
 * Derived, not minted: the same session and index always produce the same sha,
 * so a workspace can be reasoned about across a restart, and two sessions can
 * never collide. 40 hex characters because `commitCapture` refuses anything
 * that is not (`/^[0-9a-f]{40}$/`).
 */
function shaFor(sessionId: string, index: number): string {
  return createHash('sha1').update(`orgiq-mock-devbox:${sessionId}:${index}`).digest('hex');
}

/** The workspace for a session, opened with a base commit on first touch. */
export function workspaceFor(sessionId: string): MockWorkspace {
  const rows = devboxWorkspaces.rows();
  const found = rows.find((w) => w.sessionId === sessionId);
  if (found) return found;
  const created: MockWorkspace = {
    sessionId,
    commits: [shaFor(sessionId, 0)],
    pending: null,
    openedAt: clock.nowIso(),
  };
  rows.push(created);
  return created;
}

/** `git status --porcelain -uall` for the pending work: `??` new, ` M` modified. */
export function porcelain(ws: MockWorkspace): string {
  if (!ws.pending) return '';
  const newFiles = new Set(
    [...ws.pending.diff.matchAll(/^diff --git a\/.* b\/(.*)\nnew file mode/gm)].map((m) => m[1]!),
  );
  return ws.pending.files.map((f) => `${newFiles.has(f) ? '??' : ' M'} ${f}`).join('\n');
}

/** `git diff --stat | tail -1` — computed from the diff, never stored beside it. */
export function pendingStat(ws: MockWorkspace): string {
  return ws.pending ? diffStat(ws.pending.diff) : '';
}

/** Leave a run's work in the tree. Replaces whatever was pending, as a run does. */
export function stageWork(sessionId: string, diff: string): void {
  const ws = workspaceFor(sessionId);
  ws.pending = { diff, files: diffFiles(diff) };
}

/** `git add -A && git commit && git rev-parse HEAD` — the new HEAD, or null on a clean tree. */
export function commitPending(sessionId: string): string | null {
  const ws = workspaceFor(sessionId);
  if (!ws.pending) return null;
  const sha = shaFor(sessionId, ws.commits.length);
  ws.commits.push(sha);
  ws.pending = null;
  return sha;
}

/** Does this commit still exist on the work branch? */
export function hasCommit(sessionId: string, sha: string): boolean {
  return workspaceFor(sessionId).commits.includes(sha);
}

/** `git reset --hard <sha>~1`, with the pipeline's own guards: HEAD only, parent must exist. */
export function resetToParent(sessionId: string, sha: string): boolean {
  const ws = workspaceFor(sessionId);
  if (ws.commits[ws.commits.length - 1] !== sha || ws.commits.length < 2) return false;
  ws.commits.pop();
  ws.pending = null;
  return true;
}
