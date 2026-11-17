// Milo's recaps and who opened them (docs/interviews-tenant-plan.md decision 14, row I5.2): the mock world's
// interview_recaps and interview_recap_opens.
//
// Two recaps on finished, scored interviews of mock/interviews.ts, so the debrief has something to show: Ingrid's
// "Working together" round and Mateo's coding round. Each holds one statement in the scripted recap's own form, quoting
// a candidate line the record's seeded transcript holds (the same words the suggestion log quotes), and lists the
// competencies nothing bore on. Each lead's open is seeded with the ratings their seeded scorecard kept, at the time the
// recap was written (the first open writes it). Registered from its own module (lib/interviews/recap/store.ts imports
// it), so mock/interviews.ts is untouched.
// Times follow mock/interviews.ts's `at()`: days from today's UTC midnight, computed on read.
import { clock, defineFixture } from './core/index.js';
import type { RecapOpen, RecapRecord } from '../lib/interviews/recap/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROMPT_VERSION = 'recap-2026-11-17.1';
const MODEL = 'scripted-recap';

function at(days: number, hour: number, minute = 0): string {
  const now = clock.now().getTime();
  const midnight = now - (now % DAY_MS);
  return new Date(midnight + days * DAY_MS + (hour * 60 + minute) * 60 * 1000).toISOString();
}

const said = (seq: number, quote: string) => ({ text: `The candidate said: “${quote}”`, seq, quote });

export const interviewRecapsFixture = defineFixture<RecapRecord>({
  key: 'interviews.recaps',
  scenarios: {
    default: () => [
      // Ingrid's "Working together" round (ended at -6d 13:45).
      {
        interviewId: 'iv-ingrid-together', state: 'ready', writtenAt: at(-6, 14, 50), modelId: MODEL, promptVersion: PROMPT_VERSION,
        attempts: 1, droppedCodes: [], droppedClaims: 0,
        content: {
          competencies: [{ id: 'communication', evidence: [said(8, 'I paged the on-call lead and we split the investigation')] }],
          notCovered: ['problem-solving', 'code-quality', 'system-design', 'collaboration'],
        },
      },
      // Mateo's coding round (ended at -3d 15:00).
      {
        interviewId: 'iv-mateo-coding', state: 'ready', writtenAt: at(-3, 16, 0), modelId: MODEL, promptVersion: PROMPT_VERSION,
        attempts: 1, droppedCodes: [], droppedClaims: 0,
        content: {
          competencies: [{ id: 'problem-solving', evidence: [said(19, 'each key gets a fixed window that resets every minute')] }],
          notCovered: ['code-quality', 'system-design', 'communication', 'collaboration'],
        },
      },
    ],
    empty: () => [],
  },
});

export const interviewRecapOpensFixture = defineFixture<RecapOpen>({
  key: 'interviews.recap-opens',
  scenarios: {
    default: () => [
      // The leads opened the recap after rating, with the ratings their scorecards then kept (so nothing changed after it).
      { interviewId: 'iv-ingrid-together', interviewerId: 'u-wen', openedAt: at(-6, 14, 50),
        ratings: [{ competencyId: 'communication', rating: 3 }, { competencyId: 'collaboration', rating: 3 }] },
      { interviewId: 'iv-mateo-coding', interviewerId: 'u-hugo', openedAt: at(-3, 16, 0),
        ratings: [{ competencyId: 'problem-solving', rating: 3 }, { competencyId: 'code-quality', rating: 3 }] },
    ],
    empty: () => [],
  },
});
