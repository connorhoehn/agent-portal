#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, '.docker-libraries');
mkdirSync(output, { recursive: true });
const manifest = {};
for (const project of ['middleware', 'portal']) {
  const pkg = JSON.parse(readFileSync(resolve(root, project, 'package.json')));
  const lock = JSON.parse(readFileSync(resolve(root, project, 'package-lock.json')));
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (!entry.resolved?.startsWith('git+')) continue;
    const match = /^git\+ssh:\/\/git@github.com\/(connorhoehn(?:slalom)?)\/([a-z-]+)\.git#([a-f0-9]{40})$/.exec(entry.resolved);
    if (!match) throw new Error(`Unsupported Git locator: ${entry.resolved}`);
    const name = packagePath.split('node_modules/').at(-1);
    const [, owner, repo, commit] = match;
    const spec = pkg.dependencies[name];
    if (spec && spec !== `github:${owner}/${repo}#${commit}`) {
      throw new Error(`${project}: ${name} manifest does not match its locked commit`);
    }
    if (manifest[name]) {
      if (manifest[name].resolved !== entry.resolved) throw new Error(`Conflicting pins for ${name}`);
      continue;
    }
    const checkout = resolve(root, '..', repo);
    // Read committed objects, never the sibling's working tree or its built dist.
    execFileSync('git', ['-C', checkout, 'cat-file', '-e', `${commit}:dist/index.js`]);
    const temp = mkdtempSync(resolve(tmpdir(), 'orgiq-library-'));
    try {
      const archive = execFileSync('git', ['-C', checkout, 'archive', '--format=tar', commit], { maxBuffer: 256 * 1024 * 1024 });
      execFileSync('tar', ['-xf', '-', '-C', temp], { input: archive });
      const packageFile = resolve(temp, 'package.json');
      const archived = JSON.parse(readFileSync(packageFile));
      for (const section of ['dependencies', 'optionalDependencies']) {
        for (const [dep, range] of Object.entries(archived[section] ?? {})) {
          if (!range.startsWith('github:')) continue;
          const pin = /^github:connorhoehn(?:slalom)?\/([a-z-]+)#([a-f0-9]{40})$/.exec(range);
          const target = lock.packages[`node_modules/${dep}`];
          if (!pin || !target?.resolved.endsWith(`#${pin[2]}`)) throw new Error(`Unpinned nested dependency ${dep}`);
          archived[section][dep] = `file:/vendor/${pin[1]}-${pin[2]}.tgz`;
        }
      }
      writeFileSync(packageFile, JSON.stringify(archived, null, 2) + '\n');
      const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: temp, encoding: 'utf8' }));
      const file = `${repo}-${commit}.tgz`;
      copyFileSync(resolve(output, packed[0].filename), resolve(output, file));
      rmSync(resolve(output, packed[0].filename));
      const integrity = `sha512-${createHash('sha512').update(readFileSync(resolve(output, file))).digest('base64')}`;
      manifest[name] = { resolved: entry.resolved, commit, file, integrity };
      console.log(`${name}: packaged committed dist at ${commit}`);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
}
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
copyFileSync(resolve(root, 'scripts/docker/install-locked.mjs'), resolve(output, 'install-locked.mjs'));
