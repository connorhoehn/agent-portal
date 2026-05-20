// Pure weighted-pick for canary version selection.
//
// `weightB` is the percentage (0..100) of traffic routed to version B.
// Values outside [0, 100] are clamped. A roll of `Math.random() * 100` against
// the clamped weight gives an unbiased Bernoulli draw.

import type { CanaryVersionLabel } from './canary-types.js';

export function pickVersion(weightB: number): CanaryVersionLabel {
  const clamped = Math.max(0, Math.min(100, weightB));
  return Math.random() * 100 < clamped ? 'B' : 'A';
}
