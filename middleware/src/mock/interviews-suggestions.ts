// The suggestion log's fixture (docs/interviews-tenant-plan.md decision 8, row I3.3): the mock world's interview_suggestions.
//
// A few answered suggestions on three of the finished interviews in mock/interviews.ts, so the log has rows: one the lead
// asked, one Milo was asked to put (not spoken: speech is row I3.5), one skipped, and one dropped attempt (a code, no text).
// Each quotes words a candidate could have said in that round; none rates or judges anyone. Registered from its own module
// (lib/interviews/coach/store.ts imports it), so mock/interviews.ts is untouched. Times follow mock/interviews.ts's
// `at()`: working days from today (mock/interviews-days.ts), computed on read.
import { defineFixture } from './core/index.js';
import { seedAt } from './interviews-days.js';
import type { SuggestionRecord } from '../lib/interviews/coach/store.js';

const PROMPT_VERSION = 'coach-2026-11-16.1';
const MODEL = 'scripted-coach';

/** Working days from today at an hour UTC (mock/interviews-days.ts). */
const at = seedAt;

type Seed = Pick<SuggestionRecord, 'id' | 'interviewId' | 'text' | 'competencyId' | 'basedOn' | 'answer' | 'throughSeq'> & { made: string; answeredAfterS?: number };

function row(s: Seed): SuggestionRecord {
  const made = s.made;
  const shown = new Date(Date.parse(made) + 1000).toISOString();
  return {
    id: s.id, interviewId: s.interviewId, callId: null, throughSeq: s.throughSeq,
    text: s.text, competencyId: s.competencyId, basedOn: s.basedOn,
    madeAt: made, shownAt: shown, answer: s.answer,
    answeredAt: s.answer ? new Date(Date.parse(made) + (s.answeredAfterS ?? 20) * 1000).toISOString() : null,
    spoken: false, modelId: MODEL, promptVersion: PROMPT_VERSION, dropped: null,
  };
}

function dropped(id: string, interviewId: string, made: string, code: SuggestionRecord['dropped'], throughSeq: number): SuggestionRecord {
  return {
    id, interviewId, callId: null, throughSeq, text: '', competencyId: null, basedOn: null,
    madeAt: made, shownAt: null, answer: null, answeredAt: null, spoken: false, modelId: MODEL, promptVersion: PROMPT_VERSION, dropped: code,
  };
}

export const interviewSuggestionsFixture = defineFixture<SuggestionRecord>({
  key: 'interviews.suggestions',
  scenarios: {
    default: () => [
      // Ingrid's "Working together" round (Wen leads; started at -6d 13:00).
      row({ id: 'sg-ingrid-together-1', interviewId: 'iv-f2b6t5zh', made: at(-6, 13, 9), throughSeq: 14, answer: 'ask',
        text: 'Who did you bring in first when the alerts started, and how did you keep them updated?', competencyId: 'communication',
        basedOn: 'I paged the on-call lead and we split the investigation' }),
      row({ id: 'sg-ingrid-together-2', interviewId: 'iv-f2b6t5zh', made: at(-6, 13, 21), throughSeq: 31, answer: 'skip', answeredAfterS: 8,
        text: 'Tell me about a time you disagreed with a technical decision. What did you do?', competencyId: 'collaboration', basedOn: null }),
      // Mateo's coding round (Hugo leads; started at -3d 14:00).
      row({ id: 'sg-mateo-coding-1', interviewId: 'iv-j6x2d9sb', made: at(-3, 14, 18), throughSeq: 22, answer: 'milo-ask',
        text: 'What happens to a request that arrives just as the window resets?', competencyId: 'problem-solving',
        basedOn: 'each key gets a fixed window that resets every minute' }),
      dropped('sg-mateo-coding-2', 'iv-j6x2d9sb', at(-3, 14, 31), 'malformed', 40),
      // Jonah's leadership round (Wen leads; started at -1d 16:00).
      row({ id: 'sg-jonah-leadership-1', interviewId: 'iv-g9r1y8lp', made: at(-1, 16, 12), throughSeq: 17, answer: 'ask',
        text: 'What did you say in the first conversation, and what did you agree to check on afterwards?', competencyId: 'people-leadership',
        basedOn: 'I set up a weekly one-to-one with him and we agreed a plan' }),
    ],
    empty: () => [],
  },
});
