// The canary router's weight + control state — SSM, offline.
//
// Two parameters back the prompt canary: `/orgiq/canary/weight_b` (the percent
// of traffic routed to the B prompt) and `/orgiq/canary/control` (the halt
// switch and the two "leave it alone until" stamps). `lib/weight-cache.ts`
// reads them on the hot path.
//
// Why this exists: `getWeightB` already handled `ParameterNotFound` — the
// PromptCanary stack is gated behind `--context deployCanary=true`, and an
// undeployed canary is a canary at weight 0, not a 500. But offline there is
// no credential to make the call with at all, so the SDK threw
// `CredentialsProviderError` long before SSM could say the parameter is
// missing, and `GET /api/observability/canary/weight` 500'd — taking the
// PromptOps home page's weight tile and the manual weight slider with it.
//
// Everything here is a fixture rather than a constant so a PUT in dev:mock
// moves the same row the GET reads: the slider's optimistic update is
// confirmed by the next poll instead of snapping back.

import { defineFixture } from './core/index.js';
import type { CanaryControlState } from '../lib/canary-types.js';

/** The pair of SSM parameters, as one row. */
export interface CanaryWeightState {
  /** `/orgiq/canary/weight_b` — 0..100, the share of traffic on the B prompt. */
  weightB: number;
  /** `/orgiq/canary/control` — the JSON blob, field for field. */
  control: CanaryControlState;
}

/**
 * `default` — a canary mid-ramp: a quarter of traffic on B, nothing halted and
 *             no override, which is the state the controller is allowed to act
 *             on and therefore the one the page's controls are written for.
 * `empty`   — the PromptCanary stack was never deployed, so both parameters
 *             are absent: weight 0 and a control blob of defaults. Declared
 *             explicitly, because an undeclared scenario falls back to
 *             `default` and this state — the one an operator hits on a fresh
 *             account — would otherwise be unreachable offline.
 *
 * The two `*_until` stamps are empty strings, which is what `getControl`
 * substitutes for an absent field and what the controller reads as "no window
 * is open". A future instant would have to be minted, and a fixture may not
 * mint one at import (contract.ts rule 3); when a scenario needs a live
 * override window, derive it from the clock inside the factory.
 */
export const canaryWeight = defineFixture<CanaryWeightState>({
  key: 'canary-weight',
  scenarios: {
    default: () => [
      {
        weightB: 25,
        control: { manual_override_until: '', cooldown_until: '', halted: false },
      },
    ],
    empty: () => [
      {
        weightB: 0,
        control: { manual_override_until: '', cooldown_until: '', halted: false },
      },
    ],
  },
});

/** The single state row. A scenario that empties the fixture reads as "canary off". */
function state(): CanaryWeightState {
  return (
    canaryWeight.rows()[0] ?? {
      weightB: 0,
      control: { manual_override_until: '', cooldown_until: '', halted: false },
    }
  );
}

export function mockGetWeightB(): number {
  return state().weightB;
}

export function mockGetControl(): CanaryControlState {
  return { ...state().control };
}

export function mockSetWeightB(weightB: number): void {
  const row = canaryWeight.rows()[0];
  if (row) row.weightB = weightB;
}

/** Merge, exactly as `setControl` does — a partial update must not clobber the rest. */
export function mockSetControl(patch: Partial<CanaryControlState>): void {
  const row = canaryWeight.rows()[0];
  if (!row) return;
  row.control = {
    manual_override_until: patch.manual_override_until ?? row.control.manual_override_until,
    cooldown_until: patch.cooldown_until ?? row.control.cooldown_until,
    halted: patch.halted ?? row.control.halted,
  };
}
