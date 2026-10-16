// Predefined bot starters — the mundane-work automations an SME or program
// owner reaches for without writing a mission from scratch. Each starter
// prefills the create wizard (mission, outcome template, trigger, budgets);
// everything stays editable before launch, and every run still passes the
// same review + policy gates as a hand-written bot.
//
// Pure data — no React — so the catalog is testable and the wizard stays
// markup.

export interface BotStarter {
  id: string;
  label: string;
  blurb: string;
  /** Outcome contract (the wizard's Template field). */
  template: 'epic' | 'story' | 'bug';
  mission: string;
  trigger: 'manual' | 'cron' | 'pr_watch';
  /** Only meaningful when trigger === 'cron'. */
  cronExpr: string | null;
  budgetPerRunUsd: number;
  budgetPerDayUsd: number;
  maxRunsPerDay: number;
}

export const BOT_STARTERS: BotStarter[] = [
  {
    id: 'pr-analysis',
    label: 'PR code analysis',
    blurb: 'Review every new PR: diff-scoped findings + a risk summary.',
    template: 'bug',
    mission: 'On every new pull request: run static analysis on the diff, leave review comments scoped to the changed lines only, and post one summary comment with a risk rating and the two or three findings that matter. Never approve or merge; never comment on unchanged code.',
    trigger: 'pr_watch', cronExpr: null,
    budgetPerRunUsd: 0.5, budgetPerDayUsd: 3, maxRunsPerDay: 10,
  },
  {
    id: 'dep-watch',
    label: 'Dependency & CVE watch',
    blurb: 'Weekday loop: bump patch versions, flag advisories.',
    template: 'bug',
    mission: 'Each weekday morning: check dependencies for patch updates and security advisories. Open small, single-dependency bump PRs; anything with a CVE gets filed as a critical bug with the advisory linked as evidence. Keep the test suite green — abandon a bump that breaks it and file the failure instead.',
    trigger: 'cron', cronExpr: '0 5 * * 1-5',
    budgetPerRunUsd: 0.4, budgetPerDayUsd: 1.5, maxRunsPerDay: 4,
  },
  {
    id: 'flake-triage',
    label: 'Test-flake triage',
    blurb: 'Nightly: find flaky tests, quarantine with evidence.',
    template: 'bug',
    mission: 'Every night: rerun the test suite twice, diff the outcomes, and for each test that passes only sometimes file a bug with both logs attached and a suspected cause. Quarantine a flake only when the repo has a documented quarantine mechanism; never delete a test.',
    trigger: 'cron', cronExpr: '0 3 * * *',
    budgetPerRunUsd: 0.6, budgetPerDayUsd: 2, maxRunsPerDay: 2,
  },
  {
    id: 'doc-sync',
    label: 'Docs drift sync',
    blurb: 'Weekly: bring README/config docs back in line with the code.',
    template: 'story',
    mission: 'Once a week: compare the README, configuration reference and API docs against the current code. Where they disagree, fix the docs (never the code) in one small PR per document, quoting the code that contradicts the old text in the PR description.',
    trigger: 'cron', cronExpr: '0 6 * * 1',
    budgetPerRunUsd: 0.5, budgetPerDayUsd: 1, maxRunsPerDay: 1,
  },
  {
    id: 'debt-hunter',
    label: 'Tech-debt hunter',
    blurb: 'Dead code, unused deps, stale to-do comments — small reviewable PRs.',
    template: 'bug',
    mission: 'Hunt down dead code, unused dependencies and stale TODO comments. Prefer many small, reviewable changes over one sweeping one; one theme per PR. Never touch generated files or public API signatures.',
    trigger: 'cron', cronExpr: '30 6 * * 2,4',
    budgetPerRunUsd: 0.5, budgetPerDayUsd: 2, maxRunsPerDay: 3,
  },
];
