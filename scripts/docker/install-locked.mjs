// Runs inside the Docker deps stage. Only Git locators change: all registry
// versions, integrity hashes and the dependency graph remain lockfile-owned.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const vendor = process.argv[2] ?? '/vendor';
const pkg = JSON.parse(readFileSync('package.json'));
const lock = JSON.parse(readFileSync('package-lock.json'));
const libraries = JSON.parse(readFileSync(resolve(vendor, 'manifest.json')));
for (const [packagePath, entry] of Object.entries(lock.packages)) {
  if (!entry.resolved?.startsWith('git+')) continue;
  const name = packagePath.split('node_modules/').at(-1);
  const lib = libraries[entry.resolved] ?? libraries[name];
  if (!lib || lib.resolved !== entry.resolved) {
    throw new Error(`Stale or mismatched build artifact for ${name}; run node scripts/docker/prepare-libraries.mjs`);
  }
  const tar = resolve(vendor, lib.file);
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tar)).digest('base64')}`;
  if (integrity !== lib.integrity) throw new Error(`Corrupt library artifact for ${name}`);
  const locator = `file:${tar}`;
  if (packagePath === `node_modules/${name}` && pkg.dependencies[name]) {
    if (pkg.dependencies[name] !== lock.packages[''].dependencies[name] ||
        !pkg.dependencies[name].endsWith(`#${lib.commit}`)) {
      throw new Error(`Manifest and lock disagree for ${name}`);
    }
    pkg.dependencies[name] = locator;
    lock.packages[''].dependencies[name] = locator;
  }
  entry.resolved = locator;
  entry.integrity = integrity;
}
for (const entry of Object.values(lock.packages)) {
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(entry[section] ?? {})) {
      if (!spec.startsWith('github:')) continue;
      const matching = Object.values(libraries).find((candidate) => {
        const locator = candidate.resolved.replace('git+ssh://git@github.com/', 'github:').replace('.git#', '#');
        return locator === spec;
      });
      const lib = matching;
      if (!lib || !spec.endsWith(`#${lib.commit}`)) throw new Error(`Unpinned nested library ${name}`);
      entry[section][name] = `file:${resolve(vendor, lib.file)}`;
    }
  }
}
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
