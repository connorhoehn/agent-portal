// Where a canary score lands when there is no CloudWatch.
//
// `lib/emf-emitter.ts` writes one EMF log event per judged invocation into
// `/orgiq/canary/scores`, and CloudWatch extracts `composite_score`,
// `latency_ms` and `error` from it. Offline there is no log group, so
// `CreateLogStream` threw `CredentialsProviderError`, `PutLogEvents` swallowed
// its own failure, and every judged ask silently emitted nothing — the one
// shape of failure the emitter's own comment says must never happen quietly.
//
// This fixture is the offline log group: the same records, in the same shape,
// kept where `POST /api/__mock/reset` can take them back. It is a SINK, so its
// seed is deliberately empty — a score that nobody asked for is a score that
// did not happen, and pre-loading rows here would put invocations on the
// canary timeline that no request ever made.
//
// There is no `totalScored` or `passRate` field on this module and there must
// not be (contract.ts rule 1): both are one `countBy` away from the rows.

import { defineFixture, countBy } from './core/index.js';
import type { CanaryScoreRecord } from '../lib/emf-emitter.js';

/**
 * One emitted EMF record, plus the instant the emitter stamped it.
 *
 * `emittedAt` is the `_aws.Timestamp` the real record carries, taken from the
 * clock rather than `Date.now()` so a frozen-clock test asserts an exact
 * value.
 */
export interface EmittedCanaryScore extends CanaryScoreRecord {
  emittedAt: string;
}

/**
 * `default` — empty, and so is every other world: this is an append-only sink
 *             that only a judged `POST /ask` writes to. `empty` is declared
 *             explicitly anyway so the control plane can name it, rather than
 *             falling through to a default that happens to look the same.
 */
export const canaryScores = defineFixture<EmittedCanaryScore>({
  key: 'canary-scores',
  scenarios: {
    default: () => [],
    empty: () => [],
  },
});

/** Append one record. Returns it so a caller can log what it stored. */
export function mockEmitCanaryScore(rec: EmittedCanaryScore): EmittedCanaryScore {
  canaryScores.rows().push(rec);
  return rec;
}

/** How many records each version has emitted — derived, never stored. */
export function scoresByVersion(): Map<CanaryScoreRecord['version_label'], number> {
  return countBy(canaryScores.rows(), (r) => r.version_label);
}
