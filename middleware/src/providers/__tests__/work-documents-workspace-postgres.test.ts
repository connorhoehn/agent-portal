// Opt-in SQL acceptance for the workspace pages (schema/work_documents_schema.sql)
// against the dedicated disposable PostgreSQL container the link provider's
// acceptance uses (REAL_WORK_DOCUMENTS_POSTGRES=1, the container labelled
// orgiq.validation=work-documents-postgres). Only the RDS Data API transport is
// replaced; the provider SQL and the migration execute in PostgreSQL. This does
// not establish Aurora/IAM acceptance.
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { exec } from '../aurora.js';
import { schemaSql } from '../../test-support/schema-manifest.js';
import { createWorkspaceDocument, getWorkspaceDocument, listWorkspaceDocuments, updateWorkspaceDocument } from '../work-documents.js';

const enabled = process.env.REAL_WORK_DOCUMENTS_POSTGRES === '1';
const container = process.env.ORGIQ_WORK_DOCUMENTS_POSTGRES_CONTAINER ?? '';
const runFile = promisify(execFile);
const migration = readFileSync(`${process.cwd()}/../schema/work_documents_schema.sql`, 'utf8');
const parents = schemaSql({ before: 'work_documents_schema.sql' });
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const SCHEMA = 'work_page_acceptance';
// pgvector's type lives wherever the container first created the extension (the link suite's schema, or public).
let searchPath = `${SCHEMA}, public`;

async function sql(statement: string): Promise<void> {
  await runFile('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'orgiq_validation', '-c', `SET search_path TO ${searchPath}; ${statement}`]);
}
async function rows(statement: string, params: Parameters<typeof exec>[1] = []) {
  const bindings = new Map(params?.map(parameter => {
    if (parameter.value?.stringValue === undefined) throw new Error('Acceptance transport supports string parameters only');
    return [parameter.name, parameter.value.stringValue] as const;
  }));
  const bound = statement.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    if (!bindings.has(name)) throw new Error(`Unbound parameter ${name}`);
    return literal(bindings.get(name)!);
  });
  const result = await runFile('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'orgiq_validation', '-c', `SET search_path TO ${searchPath};
      WITH result AS (${bound}) SELECT COALESCE(json_agg(result), '[]'::json) FROM result`]);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>[];
}

(enabled ? describe : describe.skip)('workspace pages with real PostgreSQL', () => {
  beforeAll(async () => {
    if (!container) throw new Error('ORGIQ_WORK_DOCUMENTS_POSTGRES_CONTAINER is required');
    const owned = execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', container], { encoding: 'utf8' });
    if (owned.trim() !== 'work-documents-postgres') throw new Error('Refusing a container without the dedicated acceptance label');
    const vector = await rows("SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'");
    if (vector[0]?.schema) searchPath = `${SCHEMA}, public, ${vector[0].schema}`;
    await sql(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}; ${parents}\n${migration}`);
    jest.mocked(exec).mockImplementation(rows);
  });
  beforeEach(async () => {
    await sql(`TRUNCATE projects, work_items, work_documents CASCADE;
      INSERT INTO projects (id, name) VALUES ('project-1', 'Acceptance project'), ('project-2', 'Other project');
      INSERT INTO work_items (id, project_id, type, title) VALUES ('work-1', 'project-1', 'story', 'Acceptance work 1');`);
  });

  it('creates a page in its initiative, lists newest edit first, edits fields independently and reapplies the migration', async () => {
    const page = await createWorkspaceDocument({ projectId: 'project-1', workItemId: 'work-1', title: 'Cutover notes', kind: 'page', markdown: '# Plan' }, 'author');
    expect(page).toMatchObject({ projectId: 'project-1', workItemId: 'work-1', title: 'Cutover notes', kind: 'page', markdown: '# Plan', scene: '', createdBy: 'author', href: `/iq/documents/${page.id}` });
    const board = await createWorkspaceDocument({ projectId: 'project-1', workItemId: null, title: 'Board', kind: 'whiteboard', markdown: '' }, 'author');
    expect(board).toMatchObject({ kind: 'whiteboard', workItemId: null, scene: '' });
    expect((await listWorkspaceDocuments('project-1')).map(d => d.id)).toEqual([board.id, page.id]);
    expect(await listWorkspaceDocuments('project-2')).toEqual([]);
    expect((await updateWorkspaceDocument(page.id, { markdown: '# Plan\n\nTenant by tenant.' }))?.title).toBe('Cutover notes');
    expect((await updateWorkspaceDocument(board.id, { scene: 'AQID' }))?.scene).toBe('AQID');
    expect((await updateWorkspaceDocument(board.id, { title: 'Sequence board' }))?.scene).toBe('AQID');
    expect((await listWorkspaceDocuments('project-1')).map(d => d.id)).toEqual([board.id, page.id]);
    await sql(migration);
    expect((await getWorkspaceDocument(page.id))?.markdown).toBe('# Plan\n\nTenant by tenant.');
    expect(await updateWorkspaceDocument('wdoc-missing', { title: 'x' })).toBeNull();
  });

  it('refuses a page for an unknown initiative and drops a work item link that belongs elsewhere', async () => {
    await expect(createWorkspaceDocument({ projectId: 'project-9', workItemId: null, title: 'Nope', kind: 'page', markdown: '' }, 'author')).rejects.toThrow('Initiative not found');
    const stray = await createWorkspaceDocument({ projectId: 'project-2', workItemId: 'work-1', title: 'Stray', kind: 'page', markdown: '' }, 'author');
    expect(stray.workItemId).toBeNull();
    await sql("DELETE FROM work_items WHERE id = 'work-1'");
    const page = await createWorkspaceDocument({ projectId: 'project-1', workItemId: null, title: 'Alone', kind: 'page', markdown: '' }, 'author');
    expect((await getWorkspaceDocument(page.id))?.workItemId).toBeNull();
  });
});
