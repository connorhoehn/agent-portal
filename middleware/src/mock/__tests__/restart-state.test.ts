import { validateMockRestartSnapshot } from '../restart-state.js';
const valid = () => ({ schema: 'orgiq-private-runtime-snapshot/v1', pid: 43178, capturedAt: '2026-10-10T00:00:00.000Z', scenario: 'default', clock: { frozenStackDepth: 0 }, idleDirectors: { demo: { phase: 'idle', startedAt: null, finishedAt: null }, distillation: { phase: 'idle', startedAt: null, finishedAt: null } }, overrides: [], fixtures: [{ key: 'kept', scenarios: [{ scenario: 'default', rows: [{ id: 'existing', epoch: 17 }] }] }], mirrors: { crawlTargets: [], crawlSessions: [], ingestSchedules: [], fleet: [{ id: 'box', box: { id: 'box', sessionId: 'session' }, events: [{ type: 'completed' }], lastResultText: 'Preserved', contextTokens: 12 }], fleetSessions: [['session', 'box']], notifications: { zsets: [['inbox', [{ score: 2, value: 'saved' }]]], hashes: [['read', [['id', 'true']]]] } }, sourceIntegrity: { schema: 'mock-restart-source/v1', files: { 'src/mock/core/contract.ts': '0'.repeat(64) } } });
it('accepts a structure-complete private snapshot without rewriting existing rows or principals', () => { const snapshot = valid(); expect(validateMockRestartSnapshot(snapshot)).toBe(snapshot); expect(snapshot.fixtures[0]!.scenarios[0]!.rows[0]!.epoch).toBe(17); });
it.each(['duplicate fixture', 'unknown scenario', 'pin', 'broken fleet index', 'corrupt notification', 'source traversal', 'body not an array', 'frozen clock', 'active director'])('refuses %s before replay', kind => {
  const snapshot = valid() as any;
  if (kind === 'duplicate fixture') snapshot.fixtures.push(snapshot.fixtures[0]);
  if (kind === 'unknown scenario') snapshot.fixtures[0].scenarios[0].scenario = 'unknown';
  if (kind === 'pin') snapshot.overrides.push(['kept', 'empty']);
  if (kind === 'broken fleet index') snapshot.mirrors.fleetSessions[0][1] = 'missing-box';
  if (kind === 'corrupt notification') snapshot.mirrors.notifications.hashes[0][1][0][1] = {};
  if (kind === 'source traversal') snapshot.sourceIntegrity.files['src/mock/../config.ts'] = '0'.repeat(64);
  if (kind === 'frozen clock') snapshot.clock.frozenStackDepth = 1;
  if (kind === 'active director') snapshot.idleDirectors.demo.phase = 'running';
  if (kind === 'body not an array') snapshot.fixtures[0].scenarios[0].rows = {};
  expect(() => validateMockRestartSnapshot(snapshot)).toThrow();
});
