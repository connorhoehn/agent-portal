import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const installer = fileURLToPath(new URL('./install-locked.mjs', import.meta.url));
function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'orgiq-lock-test-'));
  const vendor = resolve(dir, 'vendor'); mkdirSync(vendor);
  const commit = 'a'.repeat(40);
  const spec = `github:connorhoehn/example#${commit}`;
  const resolved = `git+ssh://git@github.com/connorhoehn/example.git#${commit}`;
  const data = Buffer.from('committed package bytes');
  const integrity = 'sha512-' + createHash('sha512').update(data).digest('base64');
  const manifest = { example: { commit, resolved, file: 'example.tgz', integrity } };
  const pkg = { dependencies: { example: spec, public: '^1.0.0' } };
  const lock = { lockfileVersion: 3, packages: { '': structuredClone(pkg), 'node_modules/example': { version: '1.0.0', resolved }, 'node_modules/public': { version: '1.2.3', resolved: 'https://registry.npmjs.org/public/-/public-1.2.3.tgz', integrity: 'sha512-pinned' } } };
  writeFileSync(resolve(vendor, 'example.tgz'), data);
  writeFileSync(resolve(vendor, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(resolve(dir, 'package-lock.json'), JSON.stringify(lock));
  return { dir, vendor, lock, manifest, run: () => execFileSync(process.execPath, [installer, vendor], { cwd: dir, stdio: 'pipe' }) };
}

test('registry pins survive the Git-to-local artifact conversion unchanged', () => {
  const f = fixture(); try {
    f.run();
    const result = JSON.parse(readFileSync(resolve(f.dir, 'package-lock.json')));
    assert.deepEqual(result.packages['node_modules/public'], f.lock.packages['node_modules/public']);
    assert.equal(result.packages[''].dependencies.example, `file:${f.vendor}/example.tgz`);
    assert.equal(result.packages['node_modules/example'].integrity, f.manifest.example.integrity);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const corruption of ['artifact bytes', 'commit']) test(`rejects stale ${corruption} without rewriting the manifest`, () => {
  const f = fixture(); try {
    const original = readFileSync(resolve(f.dir, 'package.json'), 'utf8');
    if (corruption === 'artifact bytes') writeFileSync(resolve(f.vendor, 'example.tgz'), 'tampered');
    else {
      f.manifest.example.resolved = f.manifest.example.resolved.replace(/a{40}$/, 'b'.repeat(40));
      writeFileSync(resolve(f.vendor, 'manifest.json'), JSON.stringify(f.manifest));
    }
    assert.throws(f.run);
    assert.equal(readFileSync(resolve(f.dir, 'package.json'), 'utf8'), original);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('distinct nested commits retain their own artifacts and dependency edges', () => {
  const f = fixture(); try {
    const commit = 'b'.repeat(40);
    const spec = `github:connorhoehn/example#${commit}`;
    const resolved = `git+ssh://git@github.com/connorhoehn/example.git#${commit}`;
    const bytes = Buffer.from('second committed version');
    const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    writeFileSync(resolve(f.vendor, 'example-b.tgz'), bytes);
    const manifests = {
      [f.manifest.example.resolved]: f.manifest.example,
      [resolved]: { commit, resolved, integrity, file: 'example-b.tgz' },
    };
    f.lock.packages['node_modules/public'].dependencies = { example: spec };
    f.lock.packages['node_modules/public/node_modules/example'] = { version: '2.0.0', resolved };
    writeFileSync(resolve(f.vendor, 'manifest.json'), JSON.stringify(manifests));
    writeFileSync(resolve(f.dir, 'package-lock.json'), JSON.stringify(f.lock));
    f.run();
    const result = JSON.parse(readFileSync(resolve(f.dir, 'package-lock.json')));
    assert.equal(result.packages[''].dependencies.example, `file:${f.vendor}/example.tgz`);
    assert.equal(result.packages['node_modules/public'].dependencies.example, `file:${f.vendor}/example-b.tgz`);
    assert.equal(result.packages['node_modules/public/node_modules/example'].resolved, `file:${f.vendor}/example-b.tgz`);
    assert.equal(result.packages['node_modules/public/node_modules/example'].integrity, integrity);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a tarball outside the build context is pointed at its exported copy', () => {
  const f = fixture(); try {
    const data = Buffer.from('tracked tarball bytes');
    const integrity = 'sha512-' + createHash('sha512').update(data).digest('base64');
    const outside = 'file:../portal/vendor/outside-1.0.0.tgz';
    writeFileSync(resolve(f.vendor, 'outside-1.0.0.tgz'), data);
    f.manifest[outside] = { resolved: outside, file: 'outside-1.0.0.tgz', integrity };
    writeFileSync(resolve(f.vendor, 'manifest.json'), JSON.stringify({ [f.manifest.example.resolved]: f.manifest.example, [outside]: f.manifest[outside] }));
    const pkg = JSON.parse(readFileSync(resolve(f.dir, 'package.json')));
    pkg.dependencies.outside = outside;
    f.lock.packages[''].dependencies.outside = outside;
    f.lock.packages['node_modules/outside'] = { version: '1.0.0', resolved: outside, integrity };
    writeFileSync(resolve(f.dir, 'package.json'), JSON.stringify(pkg));
    writeFileSync(resolve(f.dir, 'package-lock.json'), JSON.stringify(f.lock));
    f.run();
    const result = JSON.parse(readFileSync(resolve(f.dir, 'package-lock.json')));
    assert.equal(result.packages['node_modules/outside'].resolved, `file:${f.vendor}/outside-1.0.0.tgz`);
    assert.equal(result.packages['node_modules/outside'].integrity, integrity);
    assert.equal(JSON.parse(readFileSync(resolve(f.dir, 'package.json'))).dependencies.outside, `file:${f.vendor}/outside-1.0.0.tgz`);
    writeFileSync(resolve(f.vendor, 'outside-1.0.0.tgz'), 'tampered');
    writeFileSync(resolve(f.dir, 'package.json'), JSON.stringify(pkg));
    writeFileSync(resolve(f.dir, 'package-lock.json'), JSON.stringify(f.lock));
    assert.throws(f.run);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
