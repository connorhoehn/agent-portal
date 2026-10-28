// The schema load order for the PostgreSQL acceptance suites, read from
// schema/manifest.json (DE-20) so a new schema file is registered once.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ManifestEntry { id: string; file?: string; kind: 'repeatable' | 'versioned' | 'data' | 'seed' }

const SCHEMA_DIR = join(process.cwd(), '..', 'schema');

/** Every repeatable/versioned file in load order, cut at `through` (inclusive) or `before` (exclusive). */
export function schemaLoadOrder(opts: { through?: string; before?: string; exclude?: string[] } = {}): string[] {
  const manifest = JSON.parse(readFileSync(join(SCHEMA_DIR, 'manifest.json'), 'utf8')) as { entries: ManifestEntry[] };
  const files = manifest.entries
    .filter((e) => (e.kind === 'repeatable' || e.kind === 'versioned') && e.file)
    .map((e) => e.file!);
  const cut = opts.through ?? opts.before;
  const at = cut === undefined ? files.length : files.indexOf(cut);
  if (at < 0) throw new Error(`${cut} is not a schema entry in schema/manifest.json`);
  const end = opts.through !== undefined ? at + 1 : at;
  return files.slice(0, end).filter((f) => !(opts.exclude ?? []).includes(f));
}

/** The concatenated SQL of `schemaLoadOrder(opts)`. */
export function schemaSql(opts: Parameters<typeof schemaLoadOrder>[0] = {}): string {
  return schemaLoadOrder(opts).map((f) => readFileSync(join(SCHEMA_DIR, f), 'utf8')).join('\n');
}
