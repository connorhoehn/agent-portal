// Which executor runs code (docs/interviews-tenant-plan.md "I4.6 answer", "The Docker runner on a developer's
// machine"). `INTERVIEWS_RUN_BACKEND=docker` picks the Docker runner, for a developer's machine only; anything else,
// or nothing, keeps the mock. A production process never gets the Docker runner: the deployed backends are separate.
import type { Executor } from './executor.js';
import { createDockerExecutor } from './docker-executor.js';
import { createMockExecutor } from './mock-executor.js';

export const RUN_BACKEND_SETTING = 'INTERVIEWS_RUN_BACKEND';
export type RunBackendChoice = 'mock' | 'docker';

/** The backend the setting asks for, as this process may have it. */
export function runBackendChoice(env: NodeJS.ProcessEnv = process.env): RunBackendChoice {
  const raw = (env[RUN_BACKEND_SETTING] ?? '').trim().toLowerCase();
  if (raw !== 'docker') return 'mock';
  if (env['NODE_ENV'] === 'production') {
    console.warn(`[interviews] ${RUN_BACKEND_SETTING}=docker is for a developer's machine; this production process keeps the mock`);
    return 'mock';
  }
  return 'docker';
}

export function createRunExecutor(env: NodeJS.ProcessEnv = process.env): Executor {
  return runBackendChoice(env) === 'docker' ? createDockerExecutor() : createMockExecutor();
}
