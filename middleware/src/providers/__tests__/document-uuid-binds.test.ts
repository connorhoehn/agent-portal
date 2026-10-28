import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The canvas identity columns are uuid, and the Data API binds every
// stringValue as text: Postgres refuses `uuid = text` and a text VALUES entry
// for a uuid column, so each bind needs CAST(... AS uuid). The mocked-Aurora
// tests never reach the SQL, which is how every draft creation failed 503 on
// the deployed stack. scripts/check-uuid-binds.mjs is the class-wide check
// (DE-28); this test runs it over the tree and over per-class fixtures.
const ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(ROOT, 'scripts/check-uuid-binds.mjs');

function run(...extra: string[]) {
  const res = spawnSync('node', [SCRIPT, '--json', ...extra], { encoding: 'utf8' });
  return { status: res.status, out: JSON.parse(res.stdout || '{}') as { findings: { table: string; column: string; param: string; exempt: string | null }[]; stale: string[] } };
}

describe('uuid binds (scripts/check-uuid-binds.mjs)', () => {
  it('the tree casts every bind to a uuid column', () => {
    const { status, out } = run();
    expect({ status, bad: out.findings.filter(f => !f.exempt), stale: out.stale }).toEqual({ status: 0, bad: [], stale: [] });
  });

  describe('fixtures', () => {
    let dir: string;
    beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'uuid-binds-')); });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const fixture = (name: string, sql: string) => {
      const file = join(dir, name);
      writeFileSync(file, `export const q = \`${sql}\`;\n`);
      return run('--source', file);
    };

    it('a bare :document against assessment_document_proposals fails', () => {
      const { status, out } = fixture('bad.ts', 'SELECT * FROM assessment_document_proposals WHERE document_id = :document');
      expect(status).toBe(1);
      expect(out.findings.map(f => `${f.table}.${f.column}:${f.param}`)).toEqual(['assessment_document_proposals.document_id:document']);
    });

    it('the same text against work_item_documents passes (document_id is text there)', () => {
      expect(fixture('text.ts', 'SELECT * FROM work_item_documents WHERE document_id = :document').status).toBe(0);
    });

    it('CAST and ::uuid pass; a positional INSERT of a bare param fails', () => {
      expect(fixture('cast.ts', 'SELECT * FROM assessment_document_proposals WHERE document_id = CAST(:document AS uuid) OR document_id = :other::uuid').status).toBe(0);
      const ins = fixture('ins.ts', 'INSERT INTO assessment_document_mappings (tenant_id, document_id) VALUES (:t, :document)');
      expect(ins.status).toBe(1);
      expect(ins.out.findings[0]).toMatchObject({ column: 'document_id', param: 'document' });
    });
  });
});
