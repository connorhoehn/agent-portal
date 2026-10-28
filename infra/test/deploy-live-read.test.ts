/**
 * deploy.sh's `live_read`: second-phase context is inferred from the live
 * account, and an inference that reads a FAILED query as "nothing live"
 * deploys without deployRuntimes / deployMiddlewareService and deletes them
 * (DE-16). The function is extracted from the real script and run against a
 * fake `aws` on PATH.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = readFileSync(join(__dirname, '..', 'scripts', 'deploy.sh'), 'utf8');
const fn = script.slice(script.indexOf('live_read() {'), script.indexOf('\n}\n', script.indexOf('live_read() {')) + 3);

function run(awsBehaviour: string, call = 'live_read OUT cloudformation describe-stacks --stack-name X') {
  const dir = mkdtempSync(join(tmpdir(), 'live-read-'));
  writeFileSync(join(dir, 'aws'), `#!/bin/bash\n${awsBehaviour}\n`);
  chmodSync(join(dir, 'aws'), 0o755);
  return spawnSync('bash', ['-c', `set -euo pipefail\n${fn}\n${call}\necho "OUT=[$OUT]"`], {
    env: { ...process.env, PATH: `${dir}:${process.env['PATH']}` }, encoding: 'utf8',
  });
}

describe('live_read', () => {
  test('returns what the account says', () => {
    const r = run('echo 8');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OUT=\[8\]/);
  });

  test('"None" and a missing resource both read as absent', () => {
    assert.match(run('echo None').stdout, /OUT=\[\]/);
    const missing = run('echo "An error occurred (ValidationError): Stack with id X does not exist" >&2; exit 254');
    assert.equal(missing.status, 0);
    assert.match(missing.stdout, /OUT=\[\]/);
    assert.match(run('echo "ParameterNotFound" >&2; exit 254').stdout, /OUT=\[\]/);
  });

  test('an expired session or throttling stops the deploy (75) instead of reading as "not live"', () => {
    for (const err of [
      'An error occurred (ExpiredToken): The security token included in the request is expired',
      'An error occurred (Throttling): Rate exceeded',
      'Could not connect to the endpoint URL',
    ]) {
      const r = run(`echo "${err}" >&2; exit 254`);
      assert.equal(r.status, 75, err);
      assert.doesNotMatch(r.stdout, /OUT=/, 'nothing after the failed read may run');
      assert.match(r.stderr, /Refusing to infer/);
    }
  });

  test('every inference read in deploy.sh goes through live_read, none swallows an error', () => {
    const block = script.slice(script.indexOf('Inferring second-phase context'), script.indexOf('── Running cdk deploy ──'));
    assert.doesNotMatch(block, /2>\/dev\/null \|\| (true|echo)/);
    assert.doesNotMatch(block, /\$\(aws /);
  });
});

test('bash -n accepts deploy.sh', () => {
  execFileSync('bash', ['-n', join(__dirname, '..', 'scripts', 'deploy.sh')]);
});
