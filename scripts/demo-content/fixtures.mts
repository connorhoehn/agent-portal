// Load every registered dev:mock fixture (middleware/src/mock/*.ts, distillation
// excepted — docs/distillation-runbooks-design.md rebuilds it) and hand back
// its default rows. (Runbooks, distillation's replacement, likewise.) Shared by the demo-content judge's cross-reference and
// stored-count checks. Run through the middleware's tsx:
//   (cd middleware && npx tsx ../scripts/demo-content/<script>.mts)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MOCK = path.join(ROOT, 'middleware/src/mock');
export const SKIP_FILE = /^(?:distillation|runbooks)/;

export interface LoadedFixture { key: string; file: string | null; rows: unknown[] }

/** The file that defines a fixture key (`key: '<key>'`): imports pull fixtures in transitively, so the import order cannot say. */
export function fileOfKey(key: string, files = mockFiles()): { file: string; line: number } | null {
  for (const f of files) {
    const src = fs.readFileSync(path.join(MOCK, f), 'utf8');
    const i = src.search(new RegExp(`key:\\s*['"\`]${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`));
    if (i >= 0) return { file: `middleware/src/mock/${f}`, line: src.slice(0, i).split('\n').length };
  }
  return null;
}

export const mockFiles = () => fs.readdirSync(MOCK).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !SKIP_FILE.test(f)).sort();

export async function loadFixtures(): Promise<LoadedFixture[]> {
  const files = mockFiles();
  const { fixtureRegistry } = await import(pathToFileURL(path.join(MOCK, 'core/fixture.ts')).href);
  for (const f of files) {
    try { await import(pathToFileURL(path.join(MOCK, f)).href); } catch (e) { console.error(`skip ${f}: ${(e as Error).message.split('\n')[0]}`); }
  }
  return fixtureRegistry.all()
    .filter((fx: { key: string }) => !/^(?:distillation|runbooks)/.test(fx.key))
    .map((fx: { key: string; rows: () => unknown[] }) => {
      let rows: unknown[] = [];
      try { rows = fx.rows(); } catch { rows = []; }
      const at = fileOfKey(fx.key, files);
      return { key: fx.key, file: at ? `${at.file}:${at.line}` : null, rows };
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = await loadFixtures();
  for (const f of all) {
    const r = f.rows[0];
    console.log(`${f.key}\t${f.file}\t${f.rows.length}\t${r && typeof r === 'object' ? Object.keys(r as object).slice(0, 14).join(',') : typeof r}`);
  }
}
