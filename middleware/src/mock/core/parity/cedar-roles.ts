// Which roles exist, read off disk rather than asked of the registry.
//
// `lib/role-registry.ts` is the production answer to "what roles are there",
// but it cannot be imported from a test: it resolves its own directory with
// `import.meta.url`, and this repo's jest transform compiles to CommonJS, where
// that is a TS1343 the module throws on before it ever runs. (The failure is
// silent in an ugly way — the TSError surfaces as an assertion with an EMPTY
// message, which is how this file came to exist rather than a `jest.mock`.)
//
// Reading the directory is not a lesser source. A role IS its Cedar file:
// `middleware/seeds/roles/{tenant}/{role}.cedar` is what gets seeded into
// Verified Permissions, and `role-registry.ts` derives its own list from
// exactly this listing. Nothing here is hand-typed, which is the harness's
// whole rule — a list of expected role names in a test file would be the same
// bug as a list of expected ids.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The same fallback chain `role-registry.ts` and `authz-matrix.test.ts` use. */
function rolesDir(): string {
  for (const candidate of [
    join(process.cwd(), 'seeds', 'roles'),
    join(process.cwd(), 'middleware', 'seeds', 'roles'),
    join(process.cwd(), '..', 'seeds', 'roles'),
    '/app/seeds/roles',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Cannot locate middleware/seeds/roles/ — the parity harness reads the Cedar files, never a typed list');
}

const roleId = (file: string): string => file.replace(/\.cedar$/, '');

/** Roles that are not scoped to one tenant: a `.cedar` directly under roles/. */
export function crossTenantRoles(): Set<string> {
  return new Set(
    readdirSync(rolesDir(), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.cedar'))
      .map((e) => roleId(e.name)),
  );
}

/** tenant → the roles its own directory defines. */
export function rolesByTenant(): Map<string, Set<string>> {
  const dir = rolesDir();
  const out = new Map<string, Set<string>>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    out.set(entry.name, new Set(
      readdirSync(join(dir, entry.name)).filter((f) => f.endsWith('.cedar')).map(roleId),
    ));
  }
  return out;
}
