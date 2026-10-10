// Explicit, private, one-boot replay for a coordinated local mock restart.
// Defaults stay seeded. This never runs in production or over real Aurora.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MockRestartSnapshot {
  schema: 'orgiq-private-runtime-snapshot/v1';
  pid: number; capturedAt: string; scenario: string;
  clock: { frozenStackDepth: 0 };
  idleDirectors: { demo: Record<string, unknown>; distillation: Record<string, unknown> };
  overrides: Array<[string, string]>;
  fixtures: Array<{ key: string; scenarios: Array<{ scenario: string; rows: unknown[] }> }>;
  mirrors: {
    crawlTargets: unknown[]; crawlSessions: Array<[string, unknown]>; ingestSchedules: unknown[];
    fleet: Array<{ id: string; box: { id: string; sessionId: string }; events: unknown[]; lastResultText: string; contextTokens: number }>;
    fleetSessions: Array<[string, string]>;
    notifications: { zsets: Array<[string, Array<{ score: number; value: string }>] >; hashes: Array<[string, Array<[string, string]>]> } | null;
  };
  sourceIntegrity: { schema: 'mock-restart-source/v1'; files: Record<string, string> };
}
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const scenarios = new Set(['default', 'empty', 'error', 'large', 'fresh', 'demo', 'distillation-demo']);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const pairs = (v: unknown, item: (key: unknown, value: unknown) => boolean): v is Array<[unknown, unknown]> => Array.isArray(v) && v.every(p => Array.isArray(p) && p.length === 2 && item(p[0], p[1]));
const rows = (v: unknown) => Array.isArray(v) && v.every(record);
export function validateMockRestartSnapshot(value: unknown): MockRestartSnapshot {
  if (!record(value) || value.schema !== 'orgiq-private-runtime-snapshot/v1' || !Number.isInteger(value.pid) || typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt)) || !scenarios.has(String(value.scenario))) throw Error('invalid mock restart snapshot header');
  if (!pairs(value.overrides, (key, scenario) => typeof key === 'string' && scenarios.has(String(scenario))) || value.overrides.length > 0) throw Error('invalid mock restart pins');
  if (!record(value.clock) || value.clock.frozenStackDepth !== 0) throw Error('mock restart requires a free-running clock');
  if (!record(value.idleDirectors) || !record(value.idleDirectors.demo) || !record(value.idleDirectors.distillation) || [value.idleDirectors.demo, value.idleDirectors.distillation].some(d => d.phase !== 'idle' || d.startedAt !== null || d.finishedAt !== null)) throw Error('mock restart requires idle demo directors');
  const fixtures = value.fixtures;
  if (!Array.isArray(fixtures) || fixtures.some(f => !record(f) || typeof f.key !== 'string' || !Array.isArray(f.scenarios) || f.scenarios.some(s => !record(s) || !scenarios.has(String(s.scenario)) || !Array.isArray(s.rows)))) throw Error('invalid mock restart fixtures');
  if (new Set(fixtures.map(f => f.key)).size !== fixtures.length || fixtures.some(f => new Set(f.scenarios.map((s: { scenario: string }) => s.scenario)).size !== f.scenarios.length)) throw Error('duplicate mock restart fixture/scenario');
  if (value.overrides.some(([key]) => !fixtures.some(f => f.key === key))) throw Error('unknown mock restart pin');
  const m = value.mirrors;
  if (!record(m) || !rows(m.crawlTargets) || !rows(m.ingestSchedules) || !pairs(m.crawlSessions, (id, row) => typeof id === 'string' && record(row) && row.id === id) || !pairs(m.fleetSessions, (session, id) => typeof session === 'string' && typeof id === 'string') || !Array.isArray(m.fleet) || m.fleet.some(f => !record(f) || typeof f.id !== 'string' || !record(f.box) || f.box.id !== f.id || typeof f.box.sessionId !== 'string' || !Array.isArray(f.events) || typeof f.lastResultText !== 'string' || typeof f.contextTokens !== 'number' || !Number.isFinite(f.contextTokens))) throw Error('invalid mock restart mirrors');
  if (m.fleetSessions.some(([session, id]) => !(m.fleet as Array<{ id: string; box: { sessionId: string } }>).some(f => f.id === id && f.box.sessionId === session))) throw Error('invalid mock restart fleet sessions');
  const n = m.notifications;
  if (n !== null && (!record(n) || !pairs(n.zsets, (key, list) => typeof key === 'string' && Array.isArray(list) && list.every(e => record(e) && typeof e.score === 'number' && Number.isFinite(e.score) && typeof e.value === 'string')) || !pairs(n.hashes, (key, list) => typeof key === 'string' && pairs(list, (field, entry) => typeof field === 'string' && typeof entry === 'string')))) throw Error('invalid mock restart notifications');
  if (!record(value.sourceIntegrity) || value.sourceIntegrity.schema !== 'mock-restart-source/v1' || !record(value.sourceIntegrity.files) || Object.entries(value.sourceIntegrity.files).some(([path, hash]) => !/^src\/(mock|providers)\/[a-zA-Z0-9_./-]+\.ts$/.test(path) || path.includes('..') || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw Error('invalid mock restart source integrity');
  return value as unknown as MockRestartSnapshot;
}
let loaded: MockRestartSnapshot | null | undefined;
let replayComplete = false;
const adopted = new Set<string>();
interface MockRestartHandoff { snapshotPath: string; snapshotSha256: string; archivePath: string; archiveSha256: string }
let handoff: { path: string; sha256: string; body: MockRestartHandoff } | null | undefined;
function offlineGuard(): void {
  if (process.env['NODE_ENV'] === 'production' || process.env['MOCK_AURORA'] !== 'true' || process.env['DEV_OFFLINE'] !== 'true') throw Error('mock restart snapshot is restricted to offline mock development');
}
function readHandoff(): typeof handoff {
  if (handoff !== undefined) return handoff;
  const destination = process.env['MOCK_INITIATIVE_DECKS_PATH'];
  const path = destination ? `${destination}.restart-handoff.json` : null;
  if (!path || !existsSync(path)) return handoff = null;
  offlineGuard();
  if ((statSync(path).mode & 0o077) !== 0) throw Error('mock restart handoff must be private');
  const raw = readFileSync(path);
  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  if (!record(parsed) || parsed.schema !== 'orgiq-private-restart-handoff/v1' || !record(parsed.body) || typeof parsed.bodySha256 !== 'string' || sha(JSON.stringify(parsed.body)) !== parsed.bodySha256) throw Error('invalid mock restart handoff integrity');
  const body = parsed.body;
  if (typeof body.snapshotPath !== 'string' || !body.snapshotPath.startsWith('/') || typeof body.archivePath !== 'string' || !body.archivePath.startsWith('/') || typeof body.snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.snapshotSha256) || typeof body.archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.archiveSha256)) throw Error('invalid mock restart handoff paths');
  return handoff = { path, sha256: sha(raw), body: body as unknown as MockRestartHandoff };
}
export function mockRestartArchive(): { path: string; sha256: string } | null {
  const pending = readHandoff();
  return pending ? { path: pending.body.archivePath, sha256: pending.body.archiveSha256 } : null;
}
/** Called only by the successful listen callback; a failed boot keeps the handoff for repair/retry. */
export function consumeMockRestartHandoff(): void {
  const pending = readHandoff();
  if (!pending) return;
  if (!replayComplete || sha(readFileSync(pending.path)) !== pending.sha256) throw Error('mock restart handoff changed or replay incomplete');
  renameSync(pending.path, `${pending.path}.applied-${process.pid}.json`);
  handoff = null;
}
export function mockRestartSnapshot(): MockRestartSnapshot | null {
  if (loaded !== undefined) return loaded;
  const pending = readHandoff();
  if (pending && process.env['MOCK_RESTART_SNAPSHOT_PATH']) throw Error('mock restart handoff conflicts with snapshot environment');
  const path = process.env['MOCK_RESTART_SNAPSHOT_PATH'] ?? pending?.body.snapshotPath;
  if (!path) return loaded = null;
  offlineGuard();
  const expected = process.env['MOCK_RESTART_SNAPSHOT_SHA256'] ?? pending?.body.snapshotSha256;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw Error('mock restart snapshot requires an exact SHA256');
  const raw = readFileSync(path);
  if (sha(raw) !== expected) throw Error('mock restart snapshot hash mismatch');
  const value = validateMockRestartSnapshot(JSON.parse(raw.toString('utf8')));
  for (const [file, expectedHash] of Object.entries(value.sourceIntegrity.files)) if (sha(readFileSync(resolve(process.cwd(), file))) !== expectedHash) throw Error(`mock restart source mismatch: ${file}`);
  return loaded = value;
}
export function restoredFixtureRows(key: string): Array<{ scenario: string; rows: unknown[] }> | null {
  const snapshot = mockRestartSnapshot();
  if (!snapshot) return null;
  const fixture = snapshot.fixtures.find(f => f.key === key);
  // The recovery's explicitly new metadata fixture was absent in the old process.
  if (!fixture && key !== 'orgiq.deck-archive-history') throw Error(`unknown registered fixture in mock restart: ${key}`);
  if (fixture) adopted.add(key);
  return fixture?.scenarios ?? null;
}
export function assertMockRestartAdopted(): void {
  const snapshot = mockRestartSnapshot();
  if (snapshot && snapshot.fixtures.some(f => !adopted.has(f.key))) throw Error('mock restart snapshot contains unregistered fixtures');
}
export function mockRestartMirror<K extends keyof MockRestartSnapshot['mirrors']>(key: K): MockRestartSnapshot['mirrors'][K] | undefined { return replayComplete ? undefined : mockRestartSnapshot()?.mirrors[key]; }

/** Mirrors seed one boot only; explicit resets must return to their normal factories. */
export function completeMockRestartReplay(): void { replayComplete = true; }

/** Idle director status is observable on /__mock/state; prove the unchanged native boot defaults reproduce it. */
export function assertMockRestartIdleDirectors(demo: unknown, distillation: unknown): void {
  const snapshot = mockRestartSnapshot();
  if (snapshot && (JSON.stringify(demo) !== JSON.stringify(snapshot.idleDirectors.demo) || JSON.stringify(distillation) !== JSON.stringify(snapshot.idleDirectors.distillation))) throw Error('mock restart idle director cache differs from its captured state');
}
