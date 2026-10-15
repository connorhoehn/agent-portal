import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sha = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
let dir: string, destination: string, handoffPath: string, snapshotPath: string;
function configure(overrides: Record<string, unknown> = {}) {
  const snapshot = { schema: 'orgiq-private-runtime-snapshot/v1', pid: 43178, capturedAt: '2026-10-10T00:00:00.000Z', scenario: 'default', clock: { frozenStackDepth: 0 }, idleDirectors: { demo: { phase: 'idle', startedAt: null, finishedAt: null } }, overrides: [], fixtures: [{ key: 'kept', scenarios: [{ scenario: 'default', rows: [{ id: 'existing', epoch: 17 }] }] }], mirrors: { crawlTargets: [], crawlSessions: [], ingestSchedules: [], fleet: [], fleetSessions: [], notifications: null }, sourceIntegrity: { schema: 'mock-restart-source/v1', files: { 'src/mock/core/contract.ts': sha(readFileSync('src/mock/core/contract.ts')) } }, ...overrides };
  const raw = JSON.stringify(snapshot); writeFileSync(snapshotPath, raw, { mode: 0o600 });
  const body = { snapshotPath, snapshotSha256: sha(raw), archivePath: join(dir, 'archive.json'), archiveSha256: '4'.repeat(64) };
  writeFileSync(handoffPath, JSON.stringify({ schema: 'orgiq-private-restart-handoff/v1', body, bodySha256: sha(JSON.stringify(body)) }), { mode: 0o600 });
}
beforeEach(() => {
  jest.resetModules(); dir = mkdtempSync(join(tmpdir(), 'mock-restart-handoff-')); destination = join(dir, 'decks.json'); handoffPath = `${destination}.restart-handoff.json`; snapshotPath = join(dir, 'snapshot.private.json');
  process.env['MOCK_INITIATIVE_DECKS_PATH'] = destination; process.env['MOCK_AURORA'] = 'true'; process.env['DEV_OFFLINE'] = 'true'; process.env['NODE_ENV'] = 'development';
  delete process.env['MOCK_RESTART_SNAPSHOT_PATH']; delete process.env['MOCK_RESTART_SNAPSHOT_SHA256']; configure();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); for (const key of ['MOCK_INITIATIVE_DECKS_PATH', 'MOCK_RESTART_SNAPSHOT_PATH', 'MOCK_RESTART_SNAPSHOT_SHA256']) delete process.env[key]; });
it('keeps the one-shot file during partial boot, then consumes it only after successful adoption/completion', () => {
  const state = require('../restart-state.js'); expect(state.mockRestartSnapshot().fixtures[0].scenarios[0].rows[0].epoch).toBe(17);
  expect(state.mockRestartArchive()).toEqual({ path: join(dir, 'archive.json'), sha256: '4'.repeat(64) });
  expect(() => state.consumeMockRestartHandoff()).toThrow(/incomplete/); expect(existsSync(handoffPath)).toBe(true);
  state.restoredFixtureRows('kept'); state.assertMockRestartAdopted(); state.assertMockRestartIdleDirectors({ phase: 'idle', startedAt: null, finishedAt: null }, { phase: 'idle', startedAt: null, finishedAt: null }); state.completeMockRestartReplay(); state.consumeMockRestartHandoff();
  expect(existsSync(handoffPath)).toBe(false); expect(readdirSync(dir).some(name => name.includes('.applied-'))).toBe(true);
  jest.resetModules(); expect(require('../restart-state.js').mockRestartSnapshot()).toBeNull();
});
it.each(['changed snapshot', 'unknown fixture', 'source mismatch', 'frozen clock', 'live director', 'production', 'changed handoff'])('fails closed on %s and leaves the private handoff available for repair/retry', kind => {
  if (kind === 'source mismatch') { configure({ sourceIntegrity: { schema: 'mock-restart-source/v1', files: { 'src/mock/core/contract.ts': '0'.repeat(64) } } }); }
  if (kind === 'frozen clock') configure({ clock: { frozenStackDepth: 1 } });
  if (kind === 'live director') configure({ idleDirectors: { demo: { phase: 'running', startedAt: null, finishedAt: null } } });
  if (kind === 'production') process.env['NODE_ENV'] = 'production';
  if (kind === 'changed snapshot') writeFileSync(snapshotPath, '{}');
  const state = require('../restart-state.js');
  expect(() => {
    state.mockRestartSnapshot();
    if (kind === 'unknown fixture') state.restoredFixtureRows('unrecognized-native-fixture');
    if (kind === 'changed handoff') { state.restoredFixtureRows('kept'); state.assertMockRestartAdopted(); state.completeMockRestartReplay(); writeFileSync(handoffPath, '{}'); state.consumeMockRestartHandoff(); }
  }).toThrow();
  expect(existsSync(handoffPath)).toBe(true);
});
it('does not accept missing fixture adoption or changed observable idle status', () => {
  const state = require('../restart-state.js'); state.mockRestartSnapshot(); expect(() => state.assertMockRestartAdopted()).toThrow(/unregistered/);
  expect(() => state.assertMockRestartIdleDirectors({ phase: 'different' }, {})).toThrow(/cache differs/);
});
