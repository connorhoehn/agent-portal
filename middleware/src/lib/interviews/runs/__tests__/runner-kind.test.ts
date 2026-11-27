// What the pad is told about its runner: one word per backend, from the selector and nothing else.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } } }));

import { runnerKindOf, runnerView } from '../runner-kind.js';

describe('runnerKindOf', () => {
  it('says simulated for the mock, real for docker and agentcore, unavailable for none', () => {
    expect(runnerKindOf('mock')).toBe('simulated');
    expect(runnerKindOf('docker')).toBe('real');
    expect(runnerKindOf('agentcore')).toBe('real');
    expect(runnerKindOf('none')).toBe('unavailable');
  });
});

describe('runnerView', () => {
  it('follows the selector for each environment', () => {
    expect(runnerView({}, true)).toEqual({ kind: 'simulated' });
    expect(runnerView({}, false)).toEqual({ kind: 'unavailable' });
    expect(runnerView({ INTERVIEWS_RUN_BACKEND: 'mock' }, false)).toEqual({ kind: 'simulated' });
    expect(runnerView({ INTERVIEWS_RUN_BACKEND: 'docker' }, false)).toEqual({ kind: 'real' });
    expect(runnerView({ INTERVIEWS_RUN_BACKEND: 'agentcore', INTERVIEWS_CODE_INTERPRETER_ID: 'ci' }, true)).toEqual({ kind: 'real' });
    expect(runnerView({ INTERVIEWS_CODE_INTERPRETER_ID: 'ci' }, false)).toEqual({ kind: 'real' });
  });

  it('never throws: a setting the selector refuses reads as unavailable', () => {
    expect(runnerView({ INTERVIEWS_RUN_BACKEND: 'lambda' }, true)).toEqual({ kind: 'unavailable' });
    expect(runnerView({ INTERVIEWS_RUN_BACKEND: 'agentcore' }, true)).toEqual({ kind: 'unavailable' });
    expect(runnerView({ INTERVIEWS_RUN_BACKEND: 'docker', NODE_ENV: 'production' }, true)).toEqual({ kind: 'unavailable' });
  });
});
