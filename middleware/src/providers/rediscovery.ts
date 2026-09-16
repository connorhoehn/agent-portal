// Rediscovery — the store side of "look before you spend".
//
// Ranking lives in lib/rediscovery.ts (pure, tested). This module holds the
// corpus it searches and the ledger of what people did with each match.
//
// The ledger matters as much as the matches. Two numbers come out of it and
// they point in opposite directions:
//
//   USED       — a short-circuit. The saving is recorded at that moment, from
//                the estimate the spend was about to be authorised against,
//                because a counterfactual reconstructed later is not evidence.
//   DISMISSED  — "no, this is different". A first-class signal, not a discard:
//                a match people keep dismissing is a RETRIEVAL BUG, and this is
//                the metric that surfaces it before a stale memory sends
//                somebody down a confidently wrong path.

import { config } from '../config.js';
import { rankMatches, avoidedEstimate, type Experience, type Match } from '../lib/rediscovery.js';
// Reused rather than reimplemented: the SAME day-bucketing (`days` UTC
// calendar-day keys ending "today", oldest first) the initiative activity
// graph uses, so two sparklines fed by the same clock never disagree about
// where a day's boundary falls.
import { buildDayKeys } from './activity.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

// ─── The corpus ──────────────────────────────────────────────────────────────
// Mirrors lab_experiences (kind: worked | failed | gotcha | decision |
// convention). Spread across repos on purpose: the whole point is that the
// answer is usually somewhere else.

const MOCK_EXPERIENCES: Experience[] = [
  {
    id: 'exp-ecs-aug', kind: 'worked',
    title: 'ECS rollout stuck IN_PROGRESS: task_definition pinned to a stale image digest',
    body: 'An ECS service rollout hung in IN_PROGRESS for 40 minutes. The service had a new '
        + 'task_definition revision but the image digest was unchanged, so ECS considered the '
        + 'deployment a no-op and never drained the old tasks. Forcing a new deployment after '
        + 'pushing a genuinely new digest cleared it. Checking the digest first would have saved '
        + 'the whole session.',
    repo: 'orgiq-stream-analytics', sessionId: 'sess-aug-114', createdAt: daysAgo(118),
  },
  {
    id: 'exp-ecs-arm', kind: 'failed',
    title: 'ECS tasks replaced in a loop with exec format error',
    body: 'Fargate defaulted to x86_64 while the image was built on Apple Silicon, so every task '
        + 'died in the entrypoint with exec format error and was replaced. The service sat in '
        + 'UPDATE_IN_PROGRESS the whole time. Pinning runtimePlatform to ARM64 fixed it.',
    repo: 'aws-agentcore', sessionId: 'sess-jul-88', createdAt: daysAgo(151),
  },
  {
    id: 'exp-aurora-cold', kind: 'worked',
    title: 'Aurora Data API HttpEndpointNotEnabledException on the first call after idle',
    body: 'The first Data API call to a scale-to-zero 0.5-ACU cluster fails with '
        + 'HttpEndpointNotEnabledException until the HTTP endpoint enables. A warm-up SELECT 1 '
        + 'then a 6x3s backoff clears it; genuine SQL errors still raise immediately.',
    repo: 'aws-agentcore', sessionId: 'sess-914', createdAt: daysAgo(21),
  },
  {
    id: 'exp-sg-custodian', kind: 'gotcha',
    title: 'Security group ingress revoked seconds after CloudFormation authorises it',
    body: 'custodian-restrict-security-group-admin-ingress revokes 0.0.0.0/0 ingress within '
        + 'seconds, with no stack event and no drift. The service was healthy and unreachable. '
        + 'Read the live IpPermissions before believing the template.',
    repo: 'aws-agentcore', sessionId: 'sess-702', createdAt: daysAgo(64),
  },
  {
    id: 'exp-otel-adot', kind: 'decision',
    title: 'Agent images must install aws-opentelemetry-distro, not vanilla opentelemetry-distro',
    body: 'AgentCore Runtime injects OTEL_PYTHON_CONFIGURATOR=aws_configurator, which only exists '
        + 'in ADOT. With the vanilla distro no configurator loads and no spans are exported — '
        + 'aws/spans stays silently empty.',
    repo: 'aws-agentcore', sessionId: 'sess-655', createdAt: daysAgo(40),
  },
  {
    id: 'exp-session-epoch', kind: 'gotcha',
    title: 'Re-minting a session cookie on switch does not kill copies already issued',
    body: 'Rotating the session cookie on a tenant/role switch scopes the NEW cookie but cannot '
        + 'retroactively invalidate copies already minted on other devices — the old one keeps '
        + 'working until the grants refresh. A session_epoch stamped into the cookie and compared '
        + 'at refresh closes that replay window. Masquerade must NOT bump the epoch or it kills '
        + 'the impersonated user\'s real sessions.',
    repo: 'orgiq-stream-analytics', sessionId: 'sess-may-330', createdAt: daysAgo(87),
  },
  {
    id: 'exp-design-tokens', kind: 'convention',
    title: 'Spacing tokens renamed in the design system',
    body: 'The spacing scale moved from t-shirt sizes to a numeric scale.',
    repo: 'orgiq-design-system', sessionId: 'sess-501', createdAt: daysAgo(30),
  },
];

// ─── The ledger ──────────────────────────────────────────────────────────────

export interface Outcome {
  experienceId: string;
  workItemId: string | null;
  action: 'used' | 'dismissed';
  reason: string | null;
  /** Captured at the moment of the decision — see the module header. */
  avoidedUsd: number | null;
  avoidedMinutes: number | null;
  at: string;
}

const OUTCOMES: Outcome[] = [
  { experienceId: 'exp-aurora-cold', workItemId: 'wi-obs-e1-s3', action: 'used',
    reason: null, avoidedUsd: 4.8, avoidedMinutes: 35, at: daysAgo(3) },
  { experienceId: 'exp-ecs-arm', workItemId: null, action: 'used',
    reason: null, avoidedUsd: 6.2, avoidedMinutes: 50, at: daysAgo(9) },
  { experienceId: 'exp-design-tokens', workItemId: null, action: 'dismissed',
    reason: 'different subject — matched on the word "tokens" only', at: daysAgo(6),
    avoidedUsd: null, avoidedMinutes: null },
];

// ─── Provider ────────────────────────────────────────────────────────────────

export interface CheckInput {
  problem: string;
  repo?: string | null;
  initiativeId?: string | null;
  workItemId?: string | null;
  estimateUsd?: number | null;
  estimateMinutes?: number | null;
}

export async function checkRediscovery(input: CheckInput): Promise<{
  matches: Match[];
  estimateAvoidedUsd: number | null;
  estimateAvoidedMinutes: number | null;
}> {
  void config;
  const matches = rankMatches(input.problem, MOCK_EXPERIENCES, {
    repo: input.repo ?? null,
    limit: 3,
  });
  const avoided = avoidedEstimate(matches, {
    usd: input.estimateUsd ?? null,
    minutes: input.estimateMinutes ?? null,
  });
  return {
    matches,
    estimateAvoidedUsd: avoided.usd,
    estimateAvoidedMinutes: avoided.minutes,
  };
}

export async function recordOutcome(o: Omit<Outcome, 'at'>): Promise<void> {
  OUTCOMES.push({ ...o, at: new Date().toISOString() });
}

/**
 * The scoreboard. Dismissals are reported beside the savings rather than
 * hidden behind them: a rising dismissal count is the early warning that
 * retrieval is drifting, and burying it would leave only the flattering half
 * of the story on screen.
 *
 * `usdAvoidedSeries` is `windowDays` UTC day-buckets of `usdAvoided`, oldest
 * first, built the same way `getProjectActivitySeries` builds its — every day
 * represented, a quiet day a real 0 rather than a gap a sparkline would read
 * as missing data. This provider has no Aurora backing at all yet (OUTCOMES
 * is an in-memory ledger; `config` above is otherwise unused pending one) — so
 * unlike the rest of the module's mock/Aurora split, there is only the one
 * path here for now, and both `usdAvoided` and its series come from it.
 */
export async function rediscoveryStats(windowDays = 30): Promise<{
  shortCircuits: number; dismissals: number;
  usdAvoided: number; minutesAvoided: number; windowDays: number;
  usdAvoidedSeries: number[];
}> {
  const cutoff = Date.now() - windowDays * DAY;
  const inWindow = OUTCOMES.filter((o) => Date.parse(o.at) >= cutoff);
  const used = inWindow.filter((o) => o.action === 'used');

  const dayKeys = buildDayKeys(windowDays);
  const byDay = new Map<string, number>(dayKeys.map((k) => [k, 0]));
  for (const o of used) {
    const day = o.at.slice(0, 10);
    if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + (o.avoidedUsd ?? 0));
  }
  const usdAvoidedSeries = dayKeys.map((k) => Math.round((byDay.get(k) ?? 0) * 100) / 100);

  return {
    shortCircuits: used.length,
    dismissals: inWindow.filter((o) => o.action === 'dismissed').length,
    usdAvoided: Math.round(used.reduce((n, o) => n + (o.avoidedUsd ?? 0), 0) * 100) / 100,
    minutesAvoided: used.reduce((n, o) => n + (o.avoidedMinutes ?? 0), 0),
    windowDays,
    usdAvoidedSeries,
  };
}
