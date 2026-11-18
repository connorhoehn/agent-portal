// The coach log's fixture (docs/interviews-tenant-plan.md decision 8, row I3.6): the mock world's interview_coach_log.
//
// A few private questions on two finished interviews in mock/interviews.ts: one answered with its quoted line, one asking
// for a judgement and refused before any model (its code only, no answer text), and one whose answer was dropped (its
// code only). None rates or judges anyone. Registered from its own module (lib/interviews/milo-notes/store.ts imports it),
// so mock/interviews.ts is untouched. Times follow mock/interviews.ts's `at()`: working days from today (mock/interviews-days.ts).
import { defineFixture } from './core/index.js';
import { seedAt } from './interviews-days.js';
import type { CoachLogRecord } from '../lib/interviews/milo-notes/store.js';

const PROMPT_VERSION = 'milo-ask-2026-11-17.1';
const MODEL = 'scripted-milo';

/** Working days from today at an hour UTC (mock/interviews-days.ts). */
const at = seedAt;

export const interviewCoachLogFixture = defineFixture<CoachLogRecord>({
  key: 'interviews.coach-log',
  scenarios: {
    default: () => [
      // Ingrid's "Working together" round (Wen leads; started at -6d 13:00).
      { id: 'ml-ingrid-together-1', interviewId: 'iv-f2b6t5zh', kind: 'answer', askedBy: 'u-wen',
        question: 'What did she say about the on-call lead?', answer: 'The candidate spoke of it in line 8.',
        sources: [{ seq: 8, quote: 'I paged the on-call lead and we split the investigation' }],
        code: null, askedAt: at(-6, 13, 12), modelId: MODEL, promptVersion: PROMPT_VERSION },
      { id: 'ml-ingrid-together-2', interviewId: 'iv-f2b6t5zh', kind: 'answer', askedBy: 'u-wen',
        question: 'Is she a strong candidate?', answer: '', sources: [],
        code: 'refused-judgement', askedAt: at(-6, 13, 25), modelId: 'none', promptVersion: PROMPT_VERSION },
      // Mateo's coding round (Hugo leads; started at -3d 14:00).
      { id: 'ml-mateo-coding-1', interviewId: 'iv-j6x2d9sb', kind: 'answer', askedBy: 'u-hugo',
        question: 'Where did he talk about the window reset?', answer: 'The candidate spoke of it in lines 19 and 24.',
        sources: [{ seq: 19, quote: 'Honestly it was a fixed-window counter: each key gets a fixed window that resets every minute, and we count requests in it.' },
          { seq: 24, quote: "It lands in the new window, so a client can send a full window's worth just before the reset and another just after." }],
        code: null, askedAt: at(-3, 14, 20), modelId: MODEL, promptVersion: PROMPT_VERSION },
    ],
    empty: () => [],
  },
});
