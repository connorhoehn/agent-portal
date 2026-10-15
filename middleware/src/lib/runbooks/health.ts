// Is a runbook version worth trusting? (design §2.1 "Derived on read".) The
// proven / drifting / unproven rule of providers/distillation.ts
// procedureHealth, counted from RunbookApplication rows that runs write
// themselves, per version: a new version starts unproven even when its
// predecessor was proven, because nobody has followed THESE steps yet.
//
//   unproven — no run has followed this version to the end.
//   drifting — it was followed once, but a later run failed or deviated, or
//              the last success is older than PROVEN_TTL_DAYS.
//   proven   — followed, nothing contradicting it since, inside the window.
//
// Pure: `nowMs` is an argument.
import type { RunbookApplication, RunbookHealth } from './types.js';

export const PROVEN_TTL_DAYS = 30;
const DAY_MS = 86_400_000;

const byTime = (a: RunbookApplication, b: RunbookApplication) =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function failureWarning(a: RunbookApplication): string {
  const where = a.failed_at_step !== null ? ` at step ${a.failed_at_step}` : '';
  const why = a.note ? `: ${a.note.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')}` : '';
  const what = a.outcome === 'followed_with_deviation' ? `Last run deviated${where}` : `Last run failed${where}`;
  return `${what}${why} — check that step before relying on it.`;
}

export function runbookHealth(applications: readonly RunbookApplication[], version: number, nowMs: number, ttlDays = PROVEN_TTL_DAYS): RunbookHealth {
  const apps = applications.filter((a) => a.version === version && a.outcome !== 'not_used').slice().sort(byTime);
  const followed = apps.filter((a) => a.outcome === 'followed');
  const total = apps.length;
  const last = apps[apps.length - 1];
  const lastFollowed = followed[followed.length - 1];

  if (!lastFollowed) {
    return {
      status: 'unproven',
      reason: total === 0
        ? `v${version} has not been run yet.`
        : `v${version}: ${total} run${total === 1 ? '' : 's'}, none followed it to the end.`,
      warning: last && last.outcome !== 'followed' ? failureWarning(last) : null,
    };
  }

  const after = apps.filter((a) => byTime(a, lastFollowed) > 0 && a.outcome !== 'followed');
  if (after.length > 0) {
    return {
      status: 'drifting',
      reason: `v${version} was followed on ${lastFollowed.at.slice(0, 10)}; since then ${after.length} run${after.length === 1 ? '' : 's'} failed or deviated.`,
      warning: failureWarning(after[after.length - 1]!),
    };
  }
  if (nowMs - Date.parse(lastFollowed.at) > ttlDays * DAY_MS) {
    return {
      status: 'drifting',
      reason: `v${version} was last followed on ${lastFollowed.at.slice(0, 10)}, more than ${ttlDays} days ago.`,
      warning: `Last followed ${lastFollowed.at.slice(0, 10)}, over ${ttlDays} days ago — check it still matches the repo before relying on it.`,
    };
  }
  return {
    status: 'proven',
    reason: `proven on ${followed.length} of ${total} run${total === 1 ? '' : 's'} of v${version} (last ${lastFollowed.at.slice(0, 10)}).`,
    warning: null,
  };
}
