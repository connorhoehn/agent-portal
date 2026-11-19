// Where a technical round is, so a suggestion fits it (the owner's note of 2026-11-18): a question about runtime
// complexity before there is working code, about testing before the candidate has run anything, or about what they would
// change in the solution (a sorted input, another constraint) before there is working code comes too early for the lead. Pure: the coach's code part (prompt.ts `coachCode`) is the only input.
//
// The stage, from the last run the coach is shown:
//   not-run   nothing has been run yet;
//   ran       a run exists, but it did not finish cleanly (an error, a compile error, a timeout, still running);
//   works     the last run finished with exit code 0: working code, as far as the coach can tell. It never judges
//             whether the output is right (decision 6); a run that finished is the floor for a complexity question.
// A round with no code part (not technical, or no code source) has no stage, and nothing is held back.
//
// What a suggestion is about is read from its words: COMPLEXITY, TESTING and CHANGE below. Both the stand-in (model.ts) and the
// model's answer (service.ts, after parse.ts) go through `fitsStage`; the model is also told the stage and the rule
// (prompt.ts `COACH_CODE_RULES`), so it should not offer one, and the check is the floor under that.
import type { CoachCode } from './prompt.js';

export type CodeStage = 'not-run' | 'ran' | 'works';
export type StageTopic = 'complexity' | 'testing' | 'change';

/** The stage of the code, or null when the round has no code part. */
export function codeStage(code: CoachCode | null | undefined): CodeStage | null {
  if (!code) return null;
  if (!code.run) return 'not-run';
  return code.run.status === 'succeeded' && code.run.exitCode === 0 ? 'works' : 'ran';
}

/** Runtime or space cost: "complexity", "big O", "runtime", "in time and in space". */
export const COMPLEXITY = /\b(?:complexity|big[- ]?o|run[- ]?time|in time and (?:in )?space|time and space)\b/i;
/** Testing the code: "test", "tests", "tested", "testing". */
export const TESTING = /\btest(?:s|ed|ing)?\b/i;
/** A change to the solution: "what would you change", "would you do anything differently". */
export const CHANGE = /\bwould you (?:change|do (?:anything |it |things )?differently)\b/i;

export function topicOf(text: string): StageTopic | null {
  if (COMPLEXITY.test(text)) return 'complexity';
  if (TESTING.test(text)) return 'testing';
  if (CHANGE.test(text)) return 'change';
  return null;
}

/** May a suggestion with this text be offered at this stage? */
export function fitsStage(text: string, stage: CodeStage | null): boolean {
  if (stage === null) return true;
  const topic = topicOf(text);
  if (topic === 'complexity' || topic === 'change') return stage === 'works';
  if (topic === 'testing') return stage !== 'not-run';
  return true;
}

/** The stage in words, for the model's request. */
export const STAGE_WORDS: Record<CodeStage, string> = {
  'not-run': 'the candidate has not run the code yet',
  ran: 'the candidate has run the code, but no run has finished cleanly yet',
  works: 'the last run finished cleanly (exit code 0)',
};
