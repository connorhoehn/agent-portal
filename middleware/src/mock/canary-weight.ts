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
import { MOCK_PROMPT_LIBRARY } from './canary-library.js';
import type { CanaryControlState } from '../lib/canary-types.js';

/** The four SSM parameters the canary runs on, as one row. */
export interface CanaryWeightState {
  /** `/orgiq/canary/weight_b` — 0..100, the share of traffic on the B prompt. */
  weightB: number;
  /** `/orgiq/canary/control` — the JSON blob, field for field. */
  control: CanaryControlState;
  /** `/orgiq/canary/subject_a_arn` — the baseline prompt the router falls back to. */
  subjectAArn: string;
  /** `/orgiq/canary/subject_b_arn` — the challenger. */
  subjectBArn: string;
}

/**
 * The DRAFT ARN of a prompt in the offline library, or ''.
 *
 * The subjects are not free-form strings: a canary compares two prompts that
 * exist, and `GET /prompts` renders each one's template by ARN. Pointing the
 * fixture at `mock/canary-library.ts` — the same rows Prompt Studio lists —
 * is what keeps "start an experiment" and "read the prompt it started" in
 * agreement offline. Inventing an ARN here would give the page a subject that
 * resolves to nothing, which is contract.ts rule 2.
 */
function libraryArn(agentId: string): string {
  const prompt = MOCK_PROMPT_LIBRARY.find((p) => p.id === `mock-${agentId}-system-prompt`);
  return prompt?.versions[0]?.arn ?? '';
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
        subjectAArn: libraryArn('supervisor'),
        subjectBArn: libraryArn('search'),
      },
    ],
    empty: () => [
      {
        weightB: 0,
        control: { manual_override_until: '', cooldown_until: '', halted: false },
        // No experiment has ever been started, so neither subject parameter
        // exists. `/ask` answers 500 "Canary subject A ARN not configured" in
        // this world exactly as it does against a fresh account — that refusal
        // is the state the "start an experiment" call to action is written for.
        subjectAArn: '',
        subjectBArn: '',
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
      subjectAArn: '',
      subjectBArn: '',
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

export function mockGetSubjectArns(): { a: string; b: string } {
  const row = state();
  return { a: row.subjectAArn, b: row.subjectBArn };
}

/**
 * Write both subject parameters, as `setSubjectArns` writes both in one
 * `Promise.all`. A start that stored one of the two would leave the router
 * picking a version it cannot invoke.
 */
export function mockSetSubjectArns(aArn: string, bArn: string): void {
  const row = canaryWeight.rows()[0];
  if (!row) return;
  row.subjectAArn = aArn;
  row.subjectBArn = bArn;
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
