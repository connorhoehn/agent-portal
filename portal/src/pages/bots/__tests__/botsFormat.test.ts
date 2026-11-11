// Run with:  cd portal && node --test 'src/pages/bots/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  botInitiatives,
  botIsPaused,
  botScheduleText,
  botListLastRanText,
  botRunSummary,
  botsRollup,
  botsSummaryLine,
  budgetsSummaryText,
  estimateSummaryText,
  filterBots,
  inputWiring,
  lastRanText,
  resolveModelLabel,
  resolveTargetLabel,
  reviewTriggerText,
  type Estimate,
} from '../botsFormat.ts';
import type { Bot, BotRun } from '../BotsPage.tsx';

const baseBot: Bot = {
  id: 'b1',
  name: 'Tech-debt hunter',
  template: 'bug',
  prompt: 'hunt bugs',
  agentProjectId: 'ap-1',
  agentProjectRepo: 'org/repo-one',
  orgProjectId: null,
  orgProjectName: null,
  model: 'nova-pro',
  trigger: 'manual',
  cronExpr: null,
  enabled: true,
  budgetPerRunUsd: null,
  budgetPerDayUsd: null,
  maxRunsPerDay: 4,
  requiresReview: true,
  createdBy: null,
  createdAt: '2026-01-01 00:00:00',
  lastRunAt: null,
  pausedReason: null,
  todaySpendUsd: 0,
  todayRunCount: 0,
};

// ─── botIsPaused / filterBots ────────────────────────────────────────────────

test('botIsPaused is true when disabled OR self-paused', () => {
  assert.equal(botIsPaused(baseBot), false);
  assert.equal(botIsPaused({ ...baseBot, enabled: false }), true);
  assert.equal(botIsPaused({ ...baseBot, pausedReason: 'budget exceeded' }), true);
});

test('filterBots status filter splits enabled vs paused', () => {
  const paused = { ...baseBot, id: 'b2', name: 'Paused bot', enabled: false };
  const bots = [baseBot, paused];
  assert.deepEqual(filterBots(bots, { search: '', status: 'all' }).map((b) => b.id), ['b1', 'b2']);
  assert.deepEqual(filterBots(bots, { search: '', status: 'enabled' }).map((b) => b.id), ['b1']);
  assert.deepEqual(filterBots(bots, { search: '', status: 'paused' }).map((b) => b.id), ['b2']);
});

test('filterBots search matches name, codebase or initiative, case-insensitively', () => {
  const initiativeBot = { ...baseBot, id: 'b3', name: 'Roadmap bot', agentProjectRepo: null, agentProjectId: null, orgProjectName: 'Q3 Roadmap' };
  const bots = [baseBot, initiativeBot];
  assert.deepEqual(filterBots(bots, { search: 'hunter', status: 'all' }).map((b) => b.id), ['b1']);
  assert.deepEqual(filterBots(bots, { search: 'REPO-ONE', status: 'all' }).map((b) => b.id), ['b1']);
  assert.deepEqual(filterBots(bots, { search: 'roadmap', status: 'all' }).map((b) => b.id), ['b3']);
  assert.deepEqual(filterBots(bots, { search: 'nope', status: 'all' }), []);
});

test('botsSummaryLine reads as the plain count when nothing is filtered out', () => {
  assert.equal(botsSummaryLine(5, 5), '5 bots');
  assert.equal(botsSummaryLine(1, 1), '1 bot');
  assert.equal(botsSummaryLine(0, 0), '0 bots');
});

test('botsSummaryLine names both numbers once a filter narrows the list (DEFECTS.md #9)', () => {
  assert.equal(botsSummaryLine(5, 2), '2 of 5 bots match');
  assert.equal(botsSummaryLine(5, 0), '0 of 5 bots match');
  assert.equal(botsSummaryLine(1, 0), '0 of 1 bot match');
});

// ─── botRunSummary ───────────────────────────────────────────────────────────
// DEFECTS.md program-owner #9: the header ("last ran 1h ago"), the guardrails
// footer ("today: 2/4 runs") and the RUNS table ("This bot has never fired")
// must never disagree — all three now read off this one function's output,
// derived from the same `runs` array the table renders.

const run = (over: Partial<BotRun>): BotRun => ({
  id: 'r1', botId: 'b1', trigger: 'cron', runId: null, jobId: null, workItemId: null,
  status: 'done', costUsd: 0.1, startedAt: '2026-09-04 06:00:00', finishedAt: '2026-09-04 06:01:00',
  outcome: {}, ...over,
});

test('botRunSummary says never fired when there are no runs — never "last ran"', () => {
  const s = botRunSummary([], new Date('2026-09-04T12:00:00Z'));
  assert.equal(s.hasRun, false);
  assert.equal(s.lastRunAt, null);
  assert.equal(s.todayRunCount, 0);
});

test('botRunSummary picks the newest run regardless of input order', () => {
  const runs = [
    run({ id: 'r1', startedAt: '2026-09-02 06:00:00' }),
    run({ id: 'r2', startedAt: '2026-09-04 09:00:00' }),
    run({ id: 'r3', startedAt: '2026-09-03 06:00:00' }),
  ];
  const s = botRunSummary(runs, new Date('2026-09-04T12:00:00Z'));
  assert.equal(s.hasRun, true);
  assert.equal(s.lastRunAt, '2026-09-04 09:00:00');
});

test('botRunSummary counts only runs that started on the same local calendar day as `now`', () => {
  // Timezone-safe by construction: two runs share `now`'s exact instant (so
  // they are on its calendar day under any local offset) and the third is 5
  // days off (so no real-world UTC offset, max ±14h, can pull it onto the
  // same local day as `now`).
  const now = new Date('2026-09-04T15:00:00.000Z');
  const runs = [
    run({ id: 'r1', startedAt: '2026-09-04 15:00:00' }),
    run({ id: 'r2', startedAt: '2026-09-04 15:00:00' }),
    run({ id: 'r3', startedAt: '2026-08-30 15:00:00' }),
  ];
  const s = botRunSummary(runs, now);
  assert.equal(s.todayRunCount, 2);
});

// ─── lastRanText / botListLastRanText ────────────────────────────────────────
// DEFECTS.md org-leader #20 / program-owner #9 (list half): the list's "Last
// ran" column and the detail header's meta line must render the identical
// phrase for the identical "no runs" case — both now go through this one
// function instead of the list saying bare "never" and the detail saying
// "never fired".

const identityWhen = (iso: string) => iso;

test('lastRanText reads "never fired" for an empty runs array, not "never"', () => {
  assert.equal(lastRanText([], identityWhen), 'never fired');
});

test('lastRanText reports "last ran <formatted>" using the caller\'s formatter', () => {
  const runs = [run({ id: 'r1', startedAt: '2026-09-04 09:00:00' })];
  assert.equal(
    lastRanText(runs, () => '3h ago', new Date('2026-09-04T12:00:00Z')),
    'last ran 3h ago',
  );
});

test('botListLastRanText reads "never fired" when the bot record carries no lastRunAt — the list has no runs array to check, but at least agrees on the null case', () => {
  assert.equal(botListLastRanText({ lastRunAt: null }, identityWhen), 'never fired');
});

test('botListLastRanText formats a populated lastRunAt the same way lastRanText does', () => {
  assert.equal(
    botListLastRanText({ lastRunAt: '2026-09-04 09:00:00' }, () => '3h ago', new Date('2026-09-04T12:00:00Z')),
    'last ran 3h ago',
  );
});

// ─── inputWiring ─────────────────────────────────────────────────────────────

test('inputWiring keeps the id + aria wiring and drops labelId', () => {
  const wiring = { id: 'f1', labelId: 'f1-label', 'aria-describedby': 'f1-hint', 'aria-invalid': false };
  assert.deepEqual(inputWiring(wiring), { id: 'f1', 'aria-describedby': 'f1-hint', 'aria-invalid': false });
});

// ─── review-step derivations ─────────────────────────────────────────────────

test('resolveTargetLabel reads the codebase or initiative by id', () => {
  const projects = [{ id: 'ap-1', repoFullName: 'org/repo-one' }];
  const orgProjects = [{ id: 'op-1', name: 'Q3 Roadmap' }];
  assert.equal(
    resolveTargetLabel({ targetKind: 'codebase', agentProjectId: 'ap-1', orgProjectId: '', projects, orgProjects }),
    'org/repo-one',
  );
  assert.equal(
    resolveTargetLabel({ targetKind: 'initiative', agentProjectId: '', orgProjectId: 'op-1', projects, orgProjects }),
    'Q3 Roadmap',
  );
  assert.equal(
    resolveTargetLabel({ targetKind: 'codebase', agentProjectId: 'missing', orgProjectId: '', projects, orgProjects }),
    '—',
  );
});

test('resolveModelLabel falls back to the raw id when unknown', () => {
  const models = [{ id: 'nova-pro', label: 'Nova Pro' }];
  assert.equal(resolveModelLabel('nova-pro', models), 'Nova Pro');
  assert.equal(resolveModelLabel('some-unlisted-id', models), 'some-unlisted-id');
});

test('budgetsSummaryText states caps or their absence, plus the run cap', () => {
  assert.equal(
    budgetsSummaryText({ budgetPerRunUsd: '', budgetPerDayUsd: '', maxRunsPerDay: 4 }),
    'no per-run cap · no daily cap · max 4/day',
  );
  assert.equal(
    budgetsSummaryText({ budgetPerRunUsd: '2.5', budgetPerDayUsd: '10', maxRunsPerDay: 6 }),
    '$2.50/run · $10.00/day · max 6/day',
  );
});

test('reviewTriggerText renders each trigger kind', () => {
  assert.equal(reviewTriggerText({ trigger: 'manual', cronExpr: '' }), 'manual');
  assert.equal(reviewTriggerText({ trigger: 'cron', cronExpr: '0 9 * * *' }), 'cron: 0 9 * * *');
  assert.equal(
    reviewTriggerText({ trigger: 'pr_watch', cronExpr: '' }),
    'on new PRs (stored now, activates with the PR poller)',
  );
});

test('estimateSummaryText prioritizes loading, then error, then the estimate', () => {
  assert.equal(estimateSummaryText({ loading: true, error: null, estimate: null }), 'estimating…');
  assert.equal(estimateSummaryText({ loading: false, error: 'HTTP 500', estimate: null }), 'No estimate available (HTTP 500).');
  assert.equal(estimateSummaryText({ loading: false, error: null, estimate: null }), '—');
});

test('estimateSummaryText states the "prior" basis as a wide range with no history', () => {
  const estimate: Estimate = { basis: 'prior', sampleCount: 0, costUsdP25: 1, costUsdP75: 4, minutesP25: 5, minutesP75: 20 };
  assert.equal(
    estimateSummaryText({ loading: false, error: null, estimate }),
    'No history yet — prior for this model tier, wide range: $1.00–$4.00 · 5–20 min',
  );
});

test('estimateSummaryText states sample-backed bases with the sample count and basis', () => {
  const estimate: Estimate = { basis: 'repo', sampleCount: 1, costUsdP25: 2, costUsdP75: 3, minutesP25: 10, minutesP75: 15 };
  assert.equal(
    estimateSummaryText({ loading: false, error: null, estimate }),
    'Similar runs: $2.00–$3.00 · 10–15 min · based on 1 run on this repo',
  );
  const modelEstimate: Estimate = { ...estimate, basis: 'model', sampleCount: 3 };
  assert.equal(
    estimateSummaryText({ loading: false, error: null, estimate: modelEstimate }),
    'Similar runs: $2.00–$3.00 · 10–15 min · based on 3 runs with this model',
  );
});


// ─── Postgres `+00` stamps ───────────────────────────────────────────────────
// The bots surfaces used to normalise a wire timestamp by appending `Z` to
// anything without a `T`. Aurora's timestamptz has no `T` *and* carries a `+00`
// offset, so that produced `…+00Z` — Invalid Date — and every "last ran" claim
// on the page collapsed to "no runs yet". Only mock mode was immune.
test('botRunSummary reads a Postgres `+00` timestamp, not just an ISO one', () => {
  // An unparseable stamp is not loudly wrong here — `hasRun` still says true
  // and `lastRunAt` echoes back. It goes wrong quietly, in todayRunCount:
  // NaN is never "today", so the guardrails footer reported 0 of N runs used
  // for a bot that had already fired, and the list's "Last ran" said "—".
  // Built from `now` so the two are the same LOCAL day in every zone.
  const now = new Date('2026-09-08T18:00:00Z');
  const isoStamp = new Date(now.getTime() - 3_600_000).toISOString();
  const pgStamp = isoStamp.replace('T', ' ').replace(/\.\d+Z$/, '+00');
  const pg = botRunSummary([{ startedAt: pgStamp }], now);
  const iso = botRunSummary([{ startedAt: isoStamp }], now);
  assert.equal(pg.todayRunCount, iso.todayRunCount);
  assert.equal(pg.todayRunCount, 1);
});


// ─── "Today" is the server's day, not the viewer's ───────────────────────────
// `maxRunsPerDay` is enforced in SQL against `date_trunc('day', NOW())` on the
// cluster. Counting the browser's local day instead put the detail page's
// guardrails footer ("today: 1/4 run") one run behind the list column beside it
// ("2/4 runs") for every viewer west of UTC after 20:00 local — understating
// how close a bot was to the cap that would refuse its next run.
test('todayRunCount uses the UTC day the budget brake is judged against', () => {
  const now = new Date('2026-09-08T10:21:59Z'); // 06:21 in New York
  const runs = [
    { startedAt: '2026-09-08T08:36:49.383Z' }, // today in both readings
    { startedAt: '2026-09-08T00:00:00.000Z' }, // today in UTC, YESTERDAY in NY
    { startedAt: '2026-09-05T09:36:49.383Z' }, // neither
  ];
  assert.equal(botRunSummary(runs, now).todayRunCount, 2);
});

// ─── botsRollup ───────────────────────────────────────────────────────────────

test('botsRollup counts enabled vs paused and sums spend/budget across bots with a budget', () => {
  const bots = [
    { ...baseBot, id: 'b1', enabled: true, todaySpendUsd: 1.5, budgetPerDayUsd: 5 },
    { ...baseBot, id: 'b2', enabled: false, todaySpendUsd: 0, budgetPerDayUsd: null },
    { ...baseBot, id: 'b3', enabled: true, pausedReason: 'budget exceeded', todaySpendUsd: 4.5, budgetPerDayUsd: 5 },
  ];
  const r = botsRollup(bots);
  assert.equal(r.enabled, 1);
  assert.equal(r.paused, 2);
  assert.equal(r.spendTodayUsd, 6);
  assert.equal(r.budgetTodayUsd, 10); // only the two bots that carry a budget
  assert.equal(r.nearBudgetCount, 1); // b3 is at 90% of its own budget
});

test('botsRollup reports a null budget total when no bot has one set', () => {
  const bots = [{ ...baseBot, id: 'b1', budgetPerDayUsd: null }, { ...baseBot, id: 'b2', budgetPerDayUsd: null }];
  const r = botsRollup(bots);
  assert.equal(r.budgetTodayUsd, null);
  assert.equal(r.nearBudgetCount, 0);
});

test('botsRollup is all-zero on an empty roster', () => {
  const r = botsRollup([]);
  assert.deepEqual(r, { enabled: 0, paused: 0, spendTodayUsd: 0, budgetTodayUsd: null, nearBudgetCount: 0 });
});

test('one list holds scheduled automations and on-demand bots, filterable by initiative', () => {
  const a: Bot = { ...baseBot, id: 'a', name: 'Nightly', trigger: 'cron', cronExpr: '0 2 * * *', orgProjectId: 'p-1', orgProjectName: 'Alpha' };
  const b: Bot = { ...baseBot, id: 'b', name: 'Ad hoc', trigger: 'manual', cronExpr: null, orgProjectId: 'p-2', orgProjectName: 'Beta' };
  const c: Bot = { ...baseBot, id: 'c', name: 'Loose', trigger: 'manual', cronExpr: null, orgProjectId: null, orgProjectName: null };
  assert.equal(botScheduleText(a), 'Scheduled: 0 2 * * *');
  assert.equal(botScheduleText(b), 'On demand');
  assert.equal(botScheduleText({ trigger: 'pr_watch', cronExpr: null }), 'On new pull requests');
  assert.deepEqual(botInitiatives([b, a, c]), [{ id: 'p-1', name: 'Alpha' }, { id: 'p-2', name: 'Beta' }]);
  assert.deepEqual(filterBots([a, b, c], { search: '', status: 'all', initiative: 'p-2' }).map((x) => x.id), ['b']);
  assert.equal(filterBots([a, b, c], { search: '', status: 'all' }).length, 3);
});
