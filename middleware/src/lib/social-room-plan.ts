import { HangoutPlanValidationError, parseHangoutPlanInput, type HangoutPlan } from '@connorhoehn/realtime-modules/hangout-rooms';
import { ValidationError } from './async-handler.js';
import { clock } from '../mock/core/index.js';
export type { HangoutPlan, HangoutPlanInput } from '@connorhoehn/realtime-modules/hangout-rooms';

export function readHangoutPlan(input: unknown, userId: string): HangoutPlan {
  try {
    const { expectedVersion, ...content } = parseHangoutPlanInput(input);
    return { ...content, version: expectedVersion + 1, updatedAt: clock.nowIso(), updatedBy: userId };
  } catch (error) {
    if (error instanceof HangoutPlanValidationError) throw new ValidationError(error.message);
    throw error;
  }
}
