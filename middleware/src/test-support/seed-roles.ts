// Jest cannot load lib/role-registry.ts (its `import.meta.url` is rejected by
// the CommonJS test transform), so open-mode authz in a suite would deny every
// Cedar action. Suites whose realtime authority asks a real policy decision
// mock the registry with this: the SAME Cedar seed files, read from the
// middleware root, permit blocks only, so tests exercise the real role matrix.
//
//   jest.mock('../role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function permittedActions(cedar: string): string[] {
  const noComments = cedar.replace(/\/\/[^\n]*/g, '');
  const actions = new Set<string>();
  for (const block of noComments.split(/\bpermit\b/).slice(1)) {
    const stmt = block.split(';')[0] ?? '';
    if (/,\s*action\s*,/.test(stmt)) return ['*'];
    for (const m of stmt.matchAll(/OrgIQ::Action::"([^"]+)"/g)) actions.add(m[1]!);
  }
  return [...actions];
}

export function seedRoleRegistry(): Array<{ id: string; tenant: string | null; label: string; summary: string; capabilities: string[] }> {
  const dir = join(process.cwd(), 'seeds', 'roles');
  const out: Array<{ id: string; tenant: string | null; label: string; summary: string; capabilities: string[] }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.cedar')) {
      const id = entry.name.slice(0, -6);
      out.push({ id, tenant: null, label: id, summary: '', capabilities: permittedActions(readFileSync(join(dir, entry.name), 'utf8')) });
    } else if (entry.isDirectory()) {
      for (const file of readdirSync(join(dir, entry.name)).filter(f => f.endsWith('.cedar'))) {
        const id = file.slice(0, -6);
        out.push({ id, tenant: entry.name, label: id, summary: '', capabilities: permittedActions(readFileSync(join(dir, entry.name, file), 'utf8')) });
      }
    }
  }
  return out;
}
