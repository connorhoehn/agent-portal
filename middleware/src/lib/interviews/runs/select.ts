// Which executor runs the code pad (docs/interviews-tenant-plan.md decision 13, rows I4.4 and I4.7).
//
//   INTERVIEWS_RUN_BACKEND=mock        the scripted mock (mock-executor.ts); it never runs anything.
//   INTERVIEWS_RUN_BACKEND=agentcore   the AgentCore Code Interpreter named by INTERVIEWS_CODE_INTERPRETER_ID.
//   unset                              the mock under the mock providers (dev:mock, the journeys, tests); on a cluster the
//                                      interpreter when INTERVIEWS_CODE_INTERPRETER_ID is set, otherwise none.
//
// "None" is an executor that answers every run with `internal_error` and one plain sentence, which gives the run's money back.
// A cluster never falls back to the mock: a real candidate would read scripted output as their program's.
import { config } from '../../../config.js';
import { AgentCoreExecutor } from './agentcore-executor.js';
import { serviceResult, type Executor, type ExecutorOutput, type RunRequest } from './executor.js';
import { createMockExecutor } from './mock-executor.js';

export const RUN_BACKEND_SETTING = 'INTERVIEWS_RUN_BACKEND';
export const CODE_INTERPRETER_SETTING = 'INTERVIEWS_CODE_INTERPRETER_ID';
export const NOT_SET_UP = 'Running code is not set up in this deployment.';

export type RunBackend = 'mock' | 'agentcore' | 'none';

/** The backend this environment selects. Throws on a value it does not know, and on `agentcore` without an interpreter. */
export function runBackend(env: NodeJS.ProcessEnv = process.env, mockWorld: boolean = config.mock?.aurora === true): RunBackend {
  const raw = String(env[RUN_BACKEND_SETTING] ?? '').trim().toLowerCase();
  const interpreter = String(env[CODE_INTERPRETER_SETTING] ?? '').trim();
  if (raw === 'mock') return 'mock';
  if (raw === 'agentcore') {
    if (!interpreter) throw new Error(`${RUN_BACKEND_SETTING}=agentcore needs ${CODE_INTERPRETER_SETTING}`);
    return 'agentcore';
  }
  if (raw !== '') throw new Error(`${RUN_BACKEND_SETTING} must be mock or agentcore, got ${JSON.stringify(raw)}`);
  if (mockWorld) return 'mock';
  return interpreter ? 'agentcore' : 'none';
}

/** Every run ends at once, money returned, with NOT_SET_UP. */
export const unavailableExecutor: Executor = {
  backend: 'none',
  runtimeVersions: { python: 'none', javascript: 'none', typescript: 'none', java: 'none', go: 'none', cpp: 'none', swift: 'none' },
  start(request: RunRequest, emit: (out: ExecutorOutput) => void) {
    queueMicrotask(() => emit({ type: 'result', result: serviceResult('internal_error', unavailableExecutor, request.language, { stderr: NOT_SET_UP }) }));
    return { cancel() { /* already ended */ } };
  },
};

export function createExecutor(env: NodeJS.ProcessEnv = process.env): Executor {
  switch (runBackend(env)) {
    case 'mock': return createMockExecutor();
    case 'agentcore': return new AgentCoreExecutor({ interpreterId: String(env[CODE_INTERPRETER_SETTING]).trim(), region: config.region });
    default: return unavailableExecutor;
  }
}
