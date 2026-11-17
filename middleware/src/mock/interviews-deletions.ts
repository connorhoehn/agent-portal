// The deletion log's fixture (docs/interviews-tenant-plan.md row I6.3): the mock world's interview_deletions.
//
// Empty in the seed: a deletion happens on purpose (the recruiter asks, or a period runs out), and every seeded
// interview is younger than the media period. Registered from its own module (lib/interviews/retention/store.ts
// imports it), so mock/interviews.ts is untouched.
import { defineFixture } from './core/index.js';
import type { DeletionRow } from '../lib/interviews/retention/store.js';

export const interviewDeletionsFixture = defineFixture<DeletionRow>({
  key: 'interviews.deletions',
  scenarios: {
    default: () => [],
  },
});
