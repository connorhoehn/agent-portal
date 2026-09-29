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
    const spec = packagePath === `node_modules/${name}` ? pkg.dependencies[name] : undefined;
    if (spec && spec !== `github:${owner}/${repo}#${commit}`) {
      throw new Error(`${project}: ${name} manifest does not match its locked commit`);
    }
    if (manifest[entry.resolved]) {
      continue;
    }
    const checkout = resolve(root, '..', repo);
    // The sibling directory is keyed by repo NAME, but a pin identifies an
    // owner TOO — and both owners are in play here: `connorhoehn/distributed-core`
    // (the 0.4x line this repo pins) and `connorhoehnslalom/distributed-core` are
    // different repositories that both land at `../distributed-core`, whichever
    // was cloned first. Trusting the checkout's origin therefore reads the wrong
    // history: eb6e4910 (v0.45.6) is absent from the slalom remote, which answers
    // `upload-pack: not our ref` for it, so this step reported the pin as a
    // vanished commit when it was simply asking the wrong server. Fetch the exact
    // sha from the OWNER named in the lockfile before concluding anything.
    const remote = `git@github.com:${owner}/${repo}.git`;
    try {
      execFileSync('git', ['-C', checkout, 'cat-file', '-e', `${commit}:dist/index.js`], { stdio: 'ignore' });
    } catch {
      execFileSync('git', ['-C', checkout, 'fetch', '--no-tags', remote, commit], { stdio: 'inherit' });
      // Still read committed objects, never the working tree or its built dist.
      execFileSync('git', ['-C', checkout, 'cat-file', '-e', `${commit}:dist/index.js`]);
    }
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
          // Follow Node's nearest-package resolution, including nested Git pins.
          let parent = packagePath;
          let target;
          while (true) {
            target = lock.packages[`${parent ? parent + '/' : ''}node_modules/${dep}`];
            if (target || !parent) break;
            parent = parent.includes('/node_modules/') ? parent.slice(0, parent.lastIndexOf('/node_modules/')) : '';
          }
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
      manifest[entry.resolved] = { resolved: entry.resolved, commit, file, integrity };
      console.log(`${name}: packaged committed dist at ${commit}`);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
}
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
copyFileSync(resolve(root, 'scripts/docker/install-locked.mjs'), resolve(output, 'install-locked.mjs'));
