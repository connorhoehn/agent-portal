// Opt-in SQL acceptance against a dedicated disposable PostgreSQL container.
// Only the RDS Data API transport is replaced; the provider SQL and migration
// execute in PostgreSQL. This does not establish Aurora/IAM acceptance.
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { exec } from '../aurora.js';
import { schemaSql } from '../../test-support/schema-manifest.js';
import { getDocumentRecord, linkWorkDocument, listWorkDocuments, searchDocumentRecords, unlinkWorkDocument } from '../work-documents.js';

const enabled = process.env.REAL_WORK_DOCUMENTS_POSTGRES === '1';
const container = process.env.ORGIQ_WORK_DOCUMENTS_POSTGRES_CONTAINER ?? '';
const runFile = promisify(execFile);
const migration = readFileSync(`${process.cwd()}/../schema/work_item_documents_schema.sql`, 'utf8');
// Everything the manifest (schema/manifest.json) loads before the file under test.
const parents = schemaSql({ before: 'work_item_documents_schema.sql' });
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

async function sql(statement: string): Promise<void> {
  await runFile('docker', ['exec', '-i', container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'orgiq_validation', '-c', `SET search_path TO work_document_acceptance; ${statement}`]);
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
    '-U', 'postgres', '-d', 'orgiq_validation', '-c', `SET search_path TO work_document_acceptance;
      WITH result AS (${bound}) SELECT COALESCE(json_agg(result), '[]'::json) FROM result`]);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>[];
}

(enabled ? describe : describe.skip)('work/document provider with real PostgreSQL', () => {
  beforeAll(async () => {
    if (!container) throw new Error('ORGIQ_WORK_DOCUMENTS_POSTGRES_CONTAINER is required');
    const owned = execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', container], { encoding: 'utf8' });
    if (owned.trim() !== 'work-documents-postgres') throw new Error('Refusing a container without the dedicated acceptance label');
    await sql(`CREATE SCHEMA IF NOT EXISTS work_document_acceptance;
      ${parents}\n${migration}`);
    jest.mocked(exec).mockImplementation(rows);
  });
  beforeEach(async () => {
    await sql(`TRUNCATE projects, work_items, documents CASCADE;
      INSERT INTO projects (id, name) VALUES ('project-1', 'Acceptance project');
      INSERT INTO work_items (id, project_id, type, title) VALUES
        ('work-1', 'project-1', 'story', 'Acceptance work 1'), ('work-2', 'project-1', 'bug', 'Acceptance work 2');
      INSERT INTO documents (id, title, source, source_uri, ingested_at) VALUES
        ('doc:1', 'Original title', 'adr', 's3://local/example', '2026-10-04T00:00:00Z'),
        ('doc:2', NULL, NULL, NULL, '2026-10-04T00:00:00Z');`);
  });

  it('reapplies the migration without losing attribution and resolves current corpus metadata', async () => {
    expect(await linkWorkDocument('work-1', 'doc:1', "author's identity")).toEqual({ created: true });
    const original = (await listWorkDocuments('work-1'))[0]!;
    await sql(migration);
    expect(await linkWorkDocument('work-1', 'doc:1', 'later actor')).toEqual({ created: false });
    await sql("UPDATE documents SET title = 'Renamed corpus record' WHERE id = 'doc:1'");
    expect((await listWorkDocuments('work-1'))[0]).toEqual({ ...original, title: 'Renamed corpus record' });
    expect(original.linkedBy).toBe("author's identity");
    expect(original.href).toBe('/iq/documents/doc%3A1');
    expect(Number.isFinite(Date.parse(original.linkedAt))).toBe(true);
    expect((await getDocumentRecord('doc:1'))?.title).toBe('Renamed corpus record');
    expect(await getDocumentRecord('doc:2')).toMatchObject({ title: null, source: null, sourceUri: null });
  });

  it('admits exactly one of concurrent identical links and keeps the winning actor', async () => {
    const actors = Array.from({ length: 12 }, (_, index) => `actor-${index}`);
    const outcomes = await Promise.all(actors.map(actor => linkWorkDocument('work-1', 'doc:1', actor)));
    expect(outcomes.filter(outcome => outcome.created)).toHaveLength(1);
    const links = await listWorkDocuments('work-1');
    expect(links).toHaveLength(1);
    expect(links[0]!.linkedBy).toBe(actors[outcomes.findIndex(outcome => outcome.created)]);
  });

  it('removes only the association, with idempotent deletion and independent work contexts', async () => {
    await linkWorkDocument('work-1', 'doc:1', 'first');
    await linkWorkDocument('work-2', 'doc:1', 'second');
    expect(await unlinkWorkDocument('work-1', 'doc:1')).toBe(true);
    expect(await unlinkWorkDocument('work-1', 'doc:1')).toBe(false);
    expect(await listWorkDocuments('work-1')).toEqual([]);
    expect(await listWorkDocuments('work-2')).toHaveLength(1);
    expect(await getDocumentRecord('doc:1')).not.toBeNull();
    expect(await rows('SELECT id FROM work_items')).toHaveLength(2);
  });

  it('enforces both parent identities and cascades links while preserving the other parent', async () => {
    await expect(sql("INSERT INTO work_item_documents VALUES ('missing', 'doc:1', 'actor', NOW())")).rejects.toThrow(/foreign key/);
    await expect(sql("INSERT INTO work_item_documents VALUES ('work-1', 'missing', 'actor', NOW())")).rejects.toThrow(/foreign key/);
    await linkWorkDocument('work-1', 'doc:1', 'actor');
    await sql("DELETE FROM work_items WHERE id = 'work-1'");
    expect(await listWorkDocuments('work-1')).toEqual([]);
    expect(await getDocumentRecord('doc:1')).not.toBeNull();
    await linkWorkDocument('work-2', 'doc:1', 'actor');
    await sql("DELETE FROM documents WHERE id = 'doc:1'");
    expect(await listWorkDocuments('work-2')).toEqual([]);
    expect(await rows("SELECT id FROM work_items WHERE id = 'work-2'")).toHaveLength(1);
  });

  it('searches wildcard characters literally, binds quoted text, and caps newest-first results at 25', async () => {
    const special = "20%_\\ O'Reilly";
    await sql(`INSERT INTO documents (id, title) VALUES ('literal', ${literal(special)});
      INSERT INTO documents (id, title, ingested_at)
      SELECT 'bounded-' || n, 'Bounded record ' || n, TIMESTAMPTZ '2026-01-01' + n * INTERVAL '1 day'
      FROM generate_series(1, 30) n`);
    expect((await searchDocumentRecords(special)).map(document => document.id)).toEqual(['literal']);
    expect(await searchDocumentRecords("' OR TRUE; --")).toEqual([]);
    const bounded = await searchDocumentRecords('bounded');
    expect(bounded).toHaveLength(25);
    expect(bounded[0]?.id).toBe('bounded-30');
    expect(bounded[24]?.id).toBe('bounded-6');
    expect(await getDocumentRecord('doc:1')).not.toBeNull();
  });

  it('rejects missing pairs and reports an unapplied relation migration as unavailable', async () => {
    await expect(linkWorkDocument('missing', 'doc:1', 'actor')).rejects.toMatchObject({ status: 404 });
    await expect(linkWorkDocument('work-1', 'missing', 'actor')).rejects.toMatchObject({ status: 404 });
    await sql('ALTER TABLE work_item_documents RENAME TO work_item_documents_held');
    try {
      await expect(listWorkDocuments('work-1')).rejects.toMatchObject({ status: 503 });
      await expect(linkWorkDocument('work-1', 'doc:1', 'actor')).rejects.toMatchObject({ status: 503 });
    } finally { await sql('ALTER TABLE work_item_documents_held RENAME TO work_item_documents'); }
  });
});
