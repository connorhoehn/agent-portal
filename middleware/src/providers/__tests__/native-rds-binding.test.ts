import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The native harness (test-support/native-rds-preload.mjs) runs provider SQL on
// a real Postgres. The Data API binds a stringValue as text unless it has a
// typeHint, so the harness must cast each bind the same way, or `uuid = text`
// passes locally and fails on Aurora (DE-28). The preload is a side-effecting
// ES module mounted alone into containers, so the binder is evaluated from its
// source rather than imported.
const source = readFileSync(join(__dirname, '../../../test-support/native-rds-preload.mjs'), 'utf8');
const start = source.indexOf('function value(field)');
const end = source.indexOf('function cell(');
if (start < 0 || end < start) throw new Error('native-rds-preload.mjs no longer has value()...cell(); update this test');
// eslint-disable-next-line no-new-func
const bind = new Function(`${source.slice(start, end)}; return bind;`)() as
  (sql: string, parameters: unknown[]) => { text: string; values: unknown[] };

const str = (name: string, stringValue: string, typeHint?: string) => ({ name, value: { stringValue }, ...(typeHint ? { typeHint } : {}) });

describe('native RDS harness types binds like the Data API', () => {
  afterEach(() => { delete process.env.ORGIQ_NATIVE_RDS_UNTYPED; });

  it('a stringValue with no typeHint binds as text, so uuid = text fails here as on Aurora', () => {
    const { text } = bind('SELECT 1 FROM t WHERE document_id = :document OR other_id = :document', [str('document', 'x')]);
    expect(text).toBe('SELECT 1 FROM t WHERE document_id = $1::text OR other_id = $1::text');
  });

  it('typeHint selects the type; an explicit CAST is still the SQL author\'s tool', () => {
    const { text, values } = bind('VALUES (:a, :b, :c, :d, CAST(:e AS uuid))', [
      str('a', 'u', 'UUID'), str('b', '{}', 'JSON'), str('c', '2026-01-01 00:00:00', 'TIMESTAMP'), str('d', 'plain'), str('e', 'u'),
    ]);
    expect(text).toBe('VALUES ($1::uuid, $2::json, $3::timestamp, $4::text, CAST($5::text AS uuid))');
    expect(values).toHaveLength(5);
  });

  it('numbers, booleans and nulls stay untyped', () => {
    const { text } = bind('SELECT :n, :b, :z', [
      { name: 'n', value: { longValue: 3 } }, { name: 'b', value: { booleanValue: true } }, { name: 'z', value: { isNull: true } },
    ]);
    expect(text).toBe('SELECT $1, $2, $3');
  });

  it('ORGIQ_NATIVE_RDS_UNTYPED=1 restores untyped binds', () => {
    process.env.ORGIQ_NATIVE_RDS_UNTYPED = '1';
    expect(bind('SELECT :a', [str('a', 'x')]).text).toBe('SELECT $1');
  });
});
