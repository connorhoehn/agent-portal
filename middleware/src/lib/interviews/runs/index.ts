// The runs module (docs/interviews-tenant-plan.md rows I4.4 and I4.5; contract U4).
//
//   startRun / listRuns / getRun / cancelRun / openRunEvents   for routes/interviews/runs.ts and routes/interview-invite-runs.ts
//   lastRun                                                    U4: the interview's newest run, as its view
//   eraseRuns                                                  D6: a media-class eraser (lib/interviews/retention/erasers.ts)
//
// Loading this module registers the coach's code source (I4.5): the coach reads `lastRun` and, this round, no pad
// with `pad` read from the pad log's `latestPadSnapshot` (UI round 1 combine).
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { setCoachCodeSource } from '../coach/service.js';
import { latestPadSnapshot, postedPadQuestionIds } from '../pad/log/index.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { eraseRunRows, lastRunRecord, runView, type RunView } from './service.js';

export * from './executor.js';
export { createMockExecutor, MockExecutor, MOCK_MARKERS, MOCK_RUNTIME_VERSIONS, literalPrints, markerOf, simulatedOutput, type MockMarker } from './mock-executor.js';
export { createDockerExecutor, DockerExecutor, DOCKER_BACKEND, DOCKER_RUNTIME_VERSIONS, DOCKER_SENTENCES } from './docker-executor.js';
export { DOCKER_RUNTIMES, DOCKER_IMAGES } from './docker-runtimes.js';
export { createExecutor, runBackend, RUN_BACKEND_SETTING, CODE_INTERPRETER_SETTING, type RunBackend } from './select.js';
export { runnerKindOf, runnerView, type RunnerKind, type RunnerView } from './runner-kind.js';
export { runStore, setRunStore, MemoryRunStore, type RunPerson, type RunRecord, type RunSide, type RunStore, type StoredRunEvent } from './store.js';
export {
  MAX_RUNS_PER_INTERVIEW, DEFAULT_RUN_PRICE_USD, RUN_PRICE_SETTING, runPriceUsd, checkRunBody, startRun, listRuns, getRun, cancelRun, openRunEvents,
  runView, guestRunView, eventId, setRunDeps, resetRunService, ensureRecovered, runsSettled, runReaders,
  type RunView, type RunEvent, type RunBody, type RunDeps, type StartOutcome, type CancelOutcome,
} from './service.js';

/** U4: the interview's newest run, or null. Runs in the interviews tenant's db context. */
export async function lastRun(interviewId: string): Promise<RunView | null> {
  const row = await runWithDbTenant(INTERVIEWS_TENANT, () => lastRunRecord(interviewId));
  return row ? runView(row) : null;
}

/** D6: remove these interviews' runs; how many went. */
export async function eraseRuns(interviewIds: readonly string[]): Promise<number> {
  if (!interviewIds.length) return 0;
  return runWithDbTenant(INTERVIEWS_TENANT, () => eraseRunRows(interviewIds));
}

/** I4.5: the coach's code source as this module can give it: the last run, and no pad until hook H2. */
export function registerRunsCodeSource(): void {
  setCoachCodeSource(async (interviewId) => ({
    pad: await latestPadSnapshot(interviewId), lastRun: await lastRun(interviewId), posted: await postedPadQuestionIds(interviewId),
  }));
}
registerRunsCodeSource();
