// The judge's own truth for Milo's fixed lines. Kept apart from the product on purpose: a test (truth.test.mts) pins these to the
// product's constants, so a drift on either side is loud instead of both moving together.
import type { Round } from './types.mts';

export const MILO_INTRO = "Hi, I'm Milo. I won't write your algorithm or anything like that, but use me if you want to speed things up or have a question.";
export const MILO_CAN_DO = 'I can repeat the question or tell you how much time is left. Ask "Milo, repeat the question" or "Milo, how much time is left?"';
export const NO_QUESTION_YET = 'Milo has not asked a question yet.';
/** The script's t0 on the fake clock (epoch ms). */
export const T0 = 1_800_000_000_000;

export function timeLeftTruth(round: Round, atMs: number): string {
  const length = round.minutes > 0 ? Math.round(round.minutes) : 60;
  const leftMs = T0 + round.startedAtMs + length * 60_000 - (T0 + atMs);
  if (leftMs <= 0) return 'This round is at the end of its time.';
  const left = Math.max(1, Math.ceil(leftMs / 60_000));
  return left === 1 ? 'About 1 minute is left in this round.' : `About ${left} minutes are left in this round.`;
}

/** Every wording the truth accepts for a words spec at the moment it was logged (time may tick across a minute while Milo decides). */
export function acceptedWords(spec: string | undefined, round: Round, atMs: number): string[] | null {
  if (spec === undefined) return null;
  switch (spec) {
    // The words are worked out when Milo decides and logged a moment either side: a 30 s window holds at most one minute boundary.
    case '@time_left': return [...new Set([0, -15_000, 15_000].map((d) => timeLeftTruth(round, atMs + d)))];
    case '@question': return [round.question ?? NO_QUESTION_YET];
    case '@intro': return [MILO_INTRO];
    case '@can_do': return [MILO_CAN_DO];
    default: return [spec];
  }
}

/** Words a candidate may ever hear: the allow-list's fixed outputs at any minute of the round. */
export function candidateWordsAllowed(words: string | undefined, round: Round): boolean {
  if (words === undefined) return false;
  if (words === MILO_CAN_DO || words === (round.question ?? NO_QUESTION_YET)) return true;
  for (let t = -60_000; t <= (round.minutes + 5) * 60_000; t += 30_000) if (timeLeftTruth(round, t) === words) return true;
  return false;
}
