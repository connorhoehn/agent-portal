// The canary, offline: the subject answers a mock cannot generate.
//
// WHY THIS EXISTS. `POST /api/observability/canary/ask` is two live model
// calls — a `ConverseStream` against whichever subject prompt the weighted
// router picked, then a fire-and-forget judge in `lib/canary-judge.ts` whose
// score is emitted as EMF. Offline both threw before they reached a model, so
// the ask streamed a single `error` frame, the judge never ran, and nothing on
// the canary timeline ever appeared. The surface could not be exercised.
//
// A MOCK CANNOT GENERATE TEXT, so what an offline subject returns is
// DECLARED, exactly as `mock/devbox-workspace.ts`'s work products are declared
// because a mock cannot write code. Two answers, one per subject, chosen to
// differ in the way the canary exists to detect: A is the terse baseline, B is
// the verbose challenger that buys a little coverage with a lot of hedging. So
// the A/B comparison the page renders is a real comparison of two real texts,
// not two copies of one canned string.
//
// THE JUDGE IS NOT HERE. It is `mock/answer-check.ts`, the same reading
// `lib/judge.ts` uses — `offline/lexical-answer-check`, which measures
// coverage, specificity, concision and shape and ABSTAINS on a dimension it
// cannot measure rather than awarding full marks. One offline judge in the
// repo, not two: a second reader with its own rubric would let a trace and a
// canary score disagree about the same text, which is the class of bug the
// mock floor exists to stop.

import { defineFixture } from './core/index.js';
import type { CanaryVersionLabel } from '../lib/canary-types.js';

export interface CanarySubjectAnswer {
  /** Which subject this is the answer for. */
  versionLabel: CanaryVersionLabel;
  /** The whole answer. Streamed to the client in chunks, as a model would be. */
  text: string;
  /** Why this text is the one declared for this subject. */
  characterises: string;
}

/**
 * `default` — the two subjects a live canary compares: a terse A and a
 *             longer, more hedged B. Both mention `{{person_name}}` and
 *             `{{topic}}` because both prompts ask for them; they differ in
 *             length and in how much they qualify, which is what the rubric
 *             separates them on.
 * `empty`   — no declared answer for either subject, so `/ask` streams the
 *             same `error` frame it streams when a real ConverseStream fails.
 *             Declared explicitly so an auditor can see the failure path
 *             without breaking anything.
 */
export const canarySubjectAnswers = defineFixture<CanarySubjectAnswer>({
  key: 'canary-subject-answers',
  scenarios: {
    default: () => [
      {
        versionLabel: 'A',
        characterises: 'the terse baseline — answers in three sentences and stops',
        text:
          '{{person_name}} is the strongest match for {{topic}}. They own the ' +
          'two most recent decisions in that area and are cited in the ' +
          'postmortems that follow from them. Start there, and bring in the ' +
          'owning team only if the question turns out to be broader.',
      },
      {
        versionLabel: 'B',
        characterises: 'the verbose challenger — more coverage, more hedging, four times the length',
        text:
          'Based on the material available, {{person_name}} appears to be the ' +
          'most relevant person for {{topic}}, though this should be treated as ' +
          'a starting point rather than a definitive answer. They are associated ' +
          'with several decisions in this area and appear in a number of related ' +
          'documents, which suggests sustained involvement rather than a one-off ' +
          'contribution. It may also be worth considering the wider team, since ' +
          'expertise of this kind is rarely held by a single individual, and the ' +
          'documents that mention {{person_name}} frequently mention colleagues ' +
          'alongside them. If the question is narrow, {{person_name}} is likely ' +
          'sufficient; if it is broad, a short conversation with the owning team ' +
          'would probably surface context that the documents do not capture. ' +
          'Note that document coverage varies considerably by area, so absence ' +
          'of evidence here should not be read as evidence of absence.',
      },
    ],
    empty: () => [],
  },
});

/**
 * The declared answer for a subject, with the ask's own variables filled in.
 *
 * Rendering `{{person_name}}`/`{{topic}}` here rather than storing a finished
 * string is the point: the answer has to be *about the question asked*, or the
 * judge's "did it name what it was asked about" reading is measuring the
 * fixture rather than the answer.
 */
export function offlineSubjectAnswer(
  versionLabel: CanaryVersionLabel,
  vars: { personName: string; topic: string },
): string | null {
  const row = canarySubjectAnswers.rows().find((r) => r.versionLabel === versionLabel);
  if (!row) return null;
  return row.text
    .replaceAll('{{person_name}}', vars.personName)
    .replaceAll('{{topic}}', vars.topic);
}
