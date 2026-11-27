// What the code pad tells people about its runner, derived from the one selector (select.ts) and nothing else.
//   mock                 simulated    Run prints example output; it executes nothing
//   docker, agentcore    real         the code is executed
//   none                 unavailable  every run ends at once with "not set up"
// A setting the selector refuses (it throws) means no executor can be built, so it reads as unavailable.
import { runBackend, type RunBackend } from './select.js';

export type RunnerKind = 'real' | 'simulated' | 'unavailable';
export interface RunnerView { kind: RunnerKind }

export function runnerKindOf(backend: RunBackend): RunnerKind {
  switch (backend) {
    case 'mock': return 'simulated';
    case 'docker':
    case 'agentcore': return 'real';
    default: return 'unavailable';
  }
}

/** The runner this environment has, for the pad's read. Never throws. */
export function runnerView(env: NodeJS.ProcessEnv = process.env, mockWorld?: boolean): RunnerView {
  try {
    return { kind: runnerKindOf(mockWorld === undefined ? runBackend(env) : runBackend(env, mockWorld)) };
  } catch {
    return { kind: 'unavailable' };
  }
}
