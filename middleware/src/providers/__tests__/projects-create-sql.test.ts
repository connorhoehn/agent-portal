// createProject on the cluster: only existing projects columns are written, a
// colliding id moves to the next number, the owner becomes a contributor, and the
// project row is deleted again when the contribution fails.

const send = jest.fn();
jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn().mockImplementation(() => ({ send })),
  ExecuteStatementCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: false }, aurora: { clusterArn: 'arn:cluster', secretArn: 'arn:secret', database: 'orgiq' } },
}));
jest.mock('../../lib/search-index/writes.js', () => ({ noteSearchWrite: jest.fn(async () => undefined) }));

import { createProject } from '../projects.js';

const rows = (col: string, value: string) => ({ columnMetadata: [{ name: col }], records: [[{ stringValue: value }]] });
const none = { columnMetadata: [], records: [] };

function script(sql: string[], handler: (q: string) => unknown) {
  send.mockImplementation(async (cmd: { input: { sql: string } }) => {
    sql.push(cmd.input.sql);
    return handler(cmd.input.sql) ?? none;
  });
}

beforeEach(() => send.mockReset());

it('writes (id, name, status, summary, sponsor_person_id, owner_id), tries -2 on a collision, then adds the owner as a contributor', async () => {
  const sql: string[] = [];
  let inserts = 0;
  script(sql, (q) => {
    if (/SELECT 1 FROM people/.test(q)) return rows('x', '1');
    if (/INSERT INTO projects/.test(q)) return ++inserts === 1 ? none : rows('id', 'p-q-2');
    if (/INSERT INTO project_contributions/.test(q)) return rows('person_id', 'p-002');
    if (/SELECT 1 FROM projects/.test(q)) return rows('x', '1');
    return none;
  });
  await createProject({ name: 'Q', ownerPersonId: 'p-002' }).catch(() => undefined);
  const insert = sql.find((q) => /INSERT INTO projects/.test(q))!;
  expect(insert).toMatch(/\(id, name, status, summary, sponsor_person_id, owner_id\)/);
  expect(inserts).toBe(2);
  const contribution = sql.find((q) => /INSERT INTO project_contributions/.test(q));
  expect(contribution).toBeDefined();
  const asked = send.mock.calls.map((c) => c[0].input).find((i: { sql: string }) => /INSERT INTO project_contributions/.test(i.sql));
  expect(JSON.stringify(asked.parameters)).toContain('"owner"');
});

it('deletes the project row when the contribution fails', async () => {
  const sql: string[] = [];
  script(sql, (q) => {
    if (/SELECT 1 FROM people/.test(q)) return rows('x', '1');
    if (/INSERT INTO projects/.test(q)) return rows('id', 'p-q');
    if (/SELECT 1 FROM projects/.test(q)) return rows('x', '1');
    if (/INSERT INTO project_contributions/.test(q)) throw new Error('boom');
    return none;
  });
  await expect(createProject({ name: 'Q', ownerPersonId: 'p-002' })).rejects.toThrow('boom');
  expect(sql.some((q) => /DELETE FROM projects WHERE id/.test(q))).toBe(true);
});

it('refuses a name already taken, ignoring case, and names the existing initiative', async () => {
  const sql: string[] = [];
  script(sql, (q) => {
    if (/SELECT 1 FROM people/.test(q)) return rows('x', '1');
    if (/lower\(name\)/.test(q)) return rows('id', 'p-q');
    return none;
  });
  await expect(createProject({ name: 'q', ownerPersonId: 'p-002' })).resolves.toMatchObject({ ok: false, status: 409, code: 'NAME_TAKEN', existingId: 'p-q' });
  expect(sql.some((q) => /INSERT INTO projects/.test(q))).toBe(false);
});
