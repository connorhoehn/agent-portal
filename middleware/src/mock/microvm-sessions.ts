// The microVM runner's sessions, offline — the `microvm_sessions` rows
// (docs/microvm-runner-design.md §13). Starts empty: nothing has run on a
// fresh stack, and dev:mock has no microVM runtime (MICROVM_RUNTIME_ARN unset
// holds every microvm job back), so only tests write here. A reset clears it.

import { defineFixture } from './core/index.js';
import type { MicrovmSessionRow } from '../providers/microvm-sessions.js';

export const microvmSessions = defineFixture<MicrovmSessionRow>({
  key: 'microvm-sessions',
  scenarios: { default: () => [] },
});
