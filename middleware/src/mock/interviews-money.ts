// What the finished seeded rounds cost, and the bells they left (E4 finding 46). An opening whose rounds Milo sat in
// does not read "$0.00 spent", and the recruiter and the hiring manager do not open an empty bell on a desk with
// scorecards in.
//
// Spend: one settled ledger row per part of each finished round of mock/interviews.ts, at the I3.9 answer's typical
// figures (docs/interviews-tenant-plan.md): Milo listening at $0.05 a minute for the round's minutes, the coach's
// suggestions, private answers, plan and recap on Nova Pro, and the runs of a technical round. Source ids are the door's
// own (`iv:<opening>:<interview>:<part>:<key>`, lib/interviews/spend.ts), so the opening's figures are attributed the
// way live spend is. Joined to the shared ledger fixture by mock/spend-ledger.ts.
//
// Bells: what the result bells (lib/interviews/result-bells.ts) would have rung for the seeded scorecards, worded as
// lib/social-notify.ts words them and naming no candidate: Wen's two scorecards in, to Greta; every scorecard in on
// Ingrid's "Working together", to Amara; Wen's scorecard due on Jonah's leadership round, to Wen. None is about the live
// round, whose bells the walks ring themselves. Joined to the inbox seed by mock/notifications.ts.
import type { SpendEntry } from '../providers/spend-ledger.js';
import { seedAt } from './interviews-days.js';
import type { MockNotificationRow } from './notifications.js';

const NOVA_PRO = 'amazon.nova-pro-v1:0';

interface Finished { interviewId: string; openingId: string; days: number; endHour: number; endMinute: number; minutes: number; technical: boolean; recap: boolean }
// The five finished rounds (mock/interviews.ts), with when each ended.
const FINISHED: Finished[] = [
  { interviewId: 'iv-d7q4n9xe', openingId: 'op-backend', days: -9, endHour: 15, endMinute: 0, minutes: 60, technical: true, recap: true },
  { interviewId: 'iv-f2b6t5zh', openingId: 'op-backend', days: -6, endHour: 13, endMinute: 45, minutes: 45, technical: false, recap: true },
  { interviewId: 'iv-j6x2d9sb', openingId: 'op-backend', days: -3, endHour: 14, endMinute: 45, minutes: 45, technical: true, recap: true },
  { interviewId: 'iv-p2v7j4ye', openingId: 'op-ios', days: -2, endHour: 16, endMinute: 0, minutes: 60, technical: true, recap: true },
  { interviewId: 'iv-g9r1y8lp', openingId: 'op-em', days: -1, endHour: 17, endMinute: 0, minutes: 60, technical: false, recap: false },
];

const entry = (f: Finished, part: 'listening' | 'coach' | 'run', key: string, costUsd: number, model: string | null, minutesAfterEnd: number,
  tokens: [number, number] | null = null): SpendEntry => ({
  source: 'interviews', sourceId: `iv:${f.openingId}:${f.interviewId}:${part}:${key}`, initiativeId: null, grantId: null, boxId: null,
  actorId: null, trigger: null, model, costUsd, costBasis: 'estimated', estimatedCostUsd: costUsd,
  inputTokens: tokens?.[0] ?? null, outputTokens: tokens?.[1] ?? null,
  occurredAt: seedAt(f.days, f.endHour, f.endMinute + minutesAfterEnd), provider: part === 'listening' ? null : part === 'run' ? null : 'bedrock',
});

/** The ledger rows of the finished rounds: about $3.10 for an hour's technical round, $2.30 for a 45-minute one. */
export function interviewSpendEntries(): SpendEntry[] {
  return FINISHED.flatMap((f) => [
    entry(f, 'listening', 'seed', Math.round(f.minutes * 0.05 * 100) / 100, null, 0),
    entry(f, 'coach', 'seed-plan', 0.004, NOVA_PRO, -f.minutes - 60, [2_200, 700]),
    entry(f, 'coach', 'seed-suggestions', f.minutes === 45 ? 0.053 : 0.044, NOVA_PRO, 0, [50_000, 1_200]),
    entry(f, 'coach', 'seed-answers', 0.023, NOVA_PRO, 0, [20_000, 2_000]),
    ...(f.recap ? [entry(f, 'coach', 'seed-recap', f.minutes === 45 ? 0.010 : 0.012, NOVA_PRO, 50, [11_500, 1_000])] : []),
    ...(f.technical ? [entry(f, 'run', 'seed', 0.003, null, 0)] : []),
  ]);
}

const bell = (id: string, userId: string, title: string, body: string, href: string, actionLabel: string, timestamp: string, kind: string, audience: string): MockNotificationRow =>
  ({ id, userId, tenant: 'interviews', type: 'system', title, body, href, actionLabel, timestamp, extra: { kind, audience } });

/** The bells the seeded scorecards rang. Ids are stable, so a reset does not mint a second copy. */
export function interviewBells(): MockNotificationRow[] {
  return [
    bell('mock-notif-iv-scorecard-in-1', 'u-greta', 'Wen Zhao submitted a scorecard: Coding for iOS Engineer', 'Open the debrief to read it beside the others.',
      '/interviews/rounds/iv-p2v7j4ye/debrief', 'Open the debrief', seedAt(-2, 17, 40), 'interview-scorecard-submitted', 'recruiter'),
    bell('mock-notif-iv-scorecard-in-2', 'u-greta', 'Wen Zhao submitted a scorecard: Working together for Senior Backend Engineer', 'Open the debrief to read it beside the others.',
      '/interviews/rounds/iv-f2b6t5zh/debrief', 'Open the debrief', seedAt(-6, 15, 5), 'interview-scorecard-submitted', 'recruiter'),
    bell('mock-notif-iv-all-in-1', 'u-amara', 'Every scorecard is in: Working together for Senior Backend Engineer', 'Open the debrief to read them side by side.',
      '/interviews/rounds/iv-f2b6t5zh/debrief', 'Open the debrief', seedAt(-6, 15, 5), 'interview-scorecards-all-in', 'hiring-manager'),
    bell('mock-notif-iv-due-1', 'u-wen', 'Your scorecard is due: Leadership for Engineering Manager', 'The interview has ended. Fill in your scorecard from My interviews.',
      '/interviews/my-interviews', 'Open My interviews', seedAt(-1, 17, 0), 'interview-scorecard-due', 'interviewer'),
  ];
}
