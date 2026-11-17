// The runs fixture (docs/interviews-tenant-plan.md row I4.4): the mock world's interview_runs table.
//
// The seed holds no run: a run is made in a live technical round, so a walk starts one and resets the world after.
// Registered from its own module (lib/interviews/runs/store.ts imports it), so mock/interviews.ts is untouched.
// `POST /api/__mock/reset` empties it like every other fixture.
import { defineFixture } from './core/index.js';
import type { RunRecord } from '../lib/interviews/runs/store.js';

export const interviewRunsFixture = defineFixture<RunRecord>({
  key: 'interviews.runs',
  scenarios: { default: () => [] },
});
