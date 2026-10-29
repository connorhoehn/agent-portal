// One lifetime model for a box and its tasks (DE-48).
//
// Five clocks used to be set in four places that knew nothing of each other:
// the reaper's idle timer and 60-minute box ceiling, the image's 840 s task
// default and 3300 s cap, the same cap repeated in two middleware files, and
// AgentCore's own 1 h idle / 8 h maximum. The collision was real: the ceiling
// was measured from the BOX's creation while boxes are reused, so a 3300 s
// task landing on a 50-minute-old box had ten minutes before the reaper
// stopped the session under it, whatever its own timeout said.
//
// This module owns every number except AgentCore's, which it treats as the
// outer bound it must stay inside. The rules:
//
//   1. The ceiling measures continuous work, not box age. A RUNNING box is
//      reaped only when its task has outlived its own timeout plus grace
//      (`task-overrun`) — that is the stuck-agent case the ceiling exists
//      for. `boxCeilingMs` applies only to a box that is NOT running.
//   2. Invariants, asserted at boot and in tests (`validateLifetimePolicy`):
//      taskMaxS * 1000 + graceMs <= boxCeilingMs; boxCeilingMs <= the
//      AgentCore maximum; idleMs < the AgentCore idle stop, so the reaper
//      (which records a reason) always fires before the platform silently
//      does. A violating env combination logs and falls back to the defaults
//      rather than booting with a hole.
//   3. Claims respect remaining life (`hasLifeFor`): a claimer skips a box
//      whose remaining ceiling cannot hold one default task plus grace.
//   4. One cap: `clampTaskTimeout` is the only place a requested timeout is
//      bounded. agents/devbox/main.py keeps MAX_TIMEOUT_S as the container's
//      own defence and names this module as the one that must agree.
//   5. Profile-driven (DE-40): a profile supplies idle / ceiling / task
//      default per initiative; env vars remain deploy-wide overrides of the
//      `default` profile.
//
// Pure: no I/O, no clock reads except where `now` is a parameter.

const MINUTE = 60_000;

/** AgentCore Runtime `lifecycleConfiguration.idleRuntimeSessionTimeout` (infra/lib/devbox-stack.ts). */
export const AGENTCORE_IDLE_MS = 3_600_000;
/** AgentCore Runtime `lifecycleConfiguration.maxLifetime` — the service maximum. */
export const AGENTCORE_MAX_LIFETIME_MS = 28_800_000;

/**
 * The streaming-connection bound on one task. The ONLY place this number
 * lives in the middleware; the image repeats it as its own last line of
 * defence (agents/devbox/main.py MAX_TIMEOUT_S).
 */
export const TASK_MAX_S = 3300;

export interface LifetimePolicy {
  /** Nobody has touched the box for this long → reap (`idle`). */
  idleMs: number;
  /** A box that is NOT running has existed this long → reap (`max-lifetime`). */
  boxCeilingMs: number;
  /** Task timeout when the caller names none. */
  taskDefaultS: number;
  /** No task may ask for more than this. */
  taskMaxS: number;
  /** How long past its own timeout a running task may be before it is stuck (`task-overrun`). */
  graceMs: number;
}

/** DE-48's proposed defaults: idle 20 min, task 840 s / 3300 s, grace 5 min, ceiling 4 h. */
export const DEFAULT_LIFETIME: Readonly<LifetimePolicy> = Object.freeze({
  idleMs: 20 * MINUTE,
  boxCeilingMs: 4 * 60 * MINUTE,
  taskDefaultS: 840,
  taskMaxS: TASK_MAX_S,
  graceMs: 5 * MINUTE,
});

/** The profile fields a lifetime policy is derived from (DE-40 `devbox_profiles`). */
export interface LifetimeProfileFields {
  idle_minutes: number;
  max_lifetime_minutes: number;
  task_timeout_s: number;
}

/** Every reason a policy is unsound; empty means sound. */
export function validateLifetimePolicy(p: LifetimePolicy): string[] {
  const out: string[] = [];
  const nums: Array<[string, number]> = [
    ['idleMs', p.idleMs], ['boxCeilingMs', p.boxCeilingMs], ['taskDefaultS', p.taskDefaultS],
    ['taskMaxS', p.taskMaxS], ['graceMs', p.graceMs],
  ];
  for (const [name, v] of nums) {
    if (!Number.isFinite(v) || v <= 0) out.push(`${name} must be a positive number (got ${String(v)})`);
  }
  if (out.length) return out;
  if (p.taskMaxS * 1000 + p.graceMs > p.boxCeilingMs) {
    out.push(`taskMaxS (${p.taskMaxS}s) + grace (${p.graceMs / MINUTE}m) exceeds the box ceiling (${p.boxCeilingMs / MINUTE}m)`);
  }
  if (p.boxCeilingMs > AGENTCORE_MAX_LIFETIME_MS) {
    out.push(`boxCeilingMs (${p.boxCeilingMs / MINUTE}m) exceeds AgentCore maxLifetime (${AGENTCORE_MAX_LIFETIME_MS / MINUTE}m)`);
  }
  if (p.idleMs >= AGENTCORE_IDLE_MS) {
    out.push(`idleMs (${p.idleMs / MINUTE}m) must be under AgentCore's idle stop (${AGENTCORE_IDLE_MS / MINUTE}m) so the reaper fires first`);
  }
  if (p.taskDefaultS > p.taskMaxS) out.push(`taskDefaultS (${p.taskDefaultS}) exceeds taskMaxS (${p.taskMaxS})`);
  if (p.taskMaxS > TASK_MAX_S) out.push(`taskMaxS (${p.taskMaxS}) exceeds the streaming bound (${TASK_MAX_S})`);
  return out;
}

/** A positive finite number from an env string, else undefined. */
function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

/**
 * The deploy-wide overrides of the `default` profile, read from the
 * environment. Only the keys that are set come back; a set-but-unparseable
 * value comes back as NaN so the validator names it.
 */
export function lifetimeEnvOverrides(env: NodeJS.ProcessEnv = process.env): Partial<LifetimePolicy> {
  const out: Partial<LifetimePolicy> = {};
  const idle = envNumber(env, 'DEVBOX_IDLE_TIMEOUT_MINUTES');
  if (idle !== undefined) out.idleMs = idle * MINUTE;
  const ceiling = envNumber(env, 'DEVBOX_MAX_LIFETIME_MINUTES');
  if (ceiling !== undefined) out.boxCeilingMs = ceiling * MINUTE;
  const taskDefault = envNumber(env, 'DEVBOX_TASK_TIMEOUT_S');
  if (taskDefault !== undefined) out.taskDefaultS = taskDefault;
  const taskMax = envNumber(env, 'DEVBOX_TASK_MAX_S');
  if (taskMax !== undefined) out.taskMaxS = taskMax;
  const grace = envNumber(env, 'DEVBOX_REAP_GRACE_MINUTES');
  if (grace !== undefined) out.graceMs = grace * MINUTE;
  return out;
}

let warned = new Set<string>();

/**
 * The policy for a profile (or, with none, the deployment's default profile
 * as the env overrides it). Unsound input logs once per distinct problem and
 * falls back to `DEFAULT_LIFETIME` — a hole is worse than a surprise.
 */
export function lifetimePolicy(
  profile?: LifetimeProfileFields | null,
  env: NodeJS.ProcessEnv = process.env,
): LifetimePolicy {
  const candidate: LifetimePolicy = profile
    ? {
      ...DEFAULT_LIFETIME,
      idleMs: profile.idle_minutes * MINUTE,
      boxCeilingMs: profile.max_lifetime_minutes * MINUTE,
      taskDefaultS: profile.task_timeout_s,
      // A profile's task timeout is also its task ceiling: "min(requested ??
      // profile.task_timeout_s, profile.task_timeout_s)" (DE-40 change 2).
      taskMaxS: Math.min(profile.task_timeout_s, TASK_MAX_S),
    }
    : { ...DEFAULT_LIFETIME, ...lifetimeEnvOverrides(env) };
  const problems = validateLifetimePolicy(candidate);
  if (problems.length === 0) return candidate;
  const key = problems.join('; ');
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[devbox-lifetime] unsound ${profile ? 'profile' : 'env'} lifetime (${key}) — using the defaults`);
  }
  return { ...DEFAULT_LIFETIME };
}

/**
 * The one cap. `requested` is whatever the caller sent (seconds, possibly
 * garbage); the answer is always a positive integer no larger than the
 * policy's task maximum, and the policy's default when nothing usable was
 * asked for.
 */
export function clampTaskTimeout(requested: unknown, policy: LifetimePolicy = lifetimePolicy()): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return policy.taskDefaultS;
  return Math.min(Math.floor(n), policy.taskMaxS);
}

/** How long a running task may go before it counts as stuck. */
export function taskOverrunMs(policy: LifetimePolicy, timeoutS: number | null | undefined): number {
  const t = Number.isFinite(Number(timeoutS)) && Number(timeoutS) > 0 ? Math.min(Number(timeoutS), policy.taskMaxS) : policy.taskMaxS;
  return t * 1000 + policy.graceMs;
}

/**
 * Whether a box has enough ceiling left to take one default task plus grace
 * (rule 3). A claimer that ignores this hands a job to a box the reaper will
 * stop under it.
 */
export function hasLifeFor(
  box: { createdAt: string },
  policy: LifetimePolicy = lifetimePolicy(),
  now = Date.now(),
  taskS: number = policy.taskDefaultS,
): boolean {
  const age = now - new Date(box.createdAt).getTime();
  if (!Number.isFinite(age)) return false;
  return policy.boxCeilingMs - age >= taskS * 1000 + policy.graceMs;
}

/** Test hook — forget which warnings were already printed. */
export function _resetLifetimeWarnings(): void {
  warned = new Set();
}
