/**
 * Synth the whole app under cdk-nag's AwsSolutions pack (work item 19): done
 * when every finding is either fixed or listed, with a reason, in
 * infra/nag-suppressions.ts.
 *
 * cdk-nag is not a dependency of this checkout yet (it needs `npm install`).
 * Until it is installed this test is SKIPPED, loudly, and the app synthesises
 * with a warning; `npm install -D cdk-nag@^2` turns it on. The invariants this
 * work item added do not wait for it: test/service-trust.test.ts and
 * test/least-privilege.test.ts run on every `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthApp } from './helpers/app-assembly';
import { NAG_SUPPRESSIONS } from '../nag-suppressions';

let installed = true;
try { require.resolve('cdk-nag'); } catch { installed = false; }

const EVERYTHING = {
  deployRuntimes: 'true', deployDevbox: 'true', deployCanary: 'true', deployMiddlewareService: 'true',
  deploySocial: 'true', deploySocialMedia: 'true', sfuAllowCidr: '203.0.113.4/32',
  deployPortal: 'true', certificateArn: 'arn:aws:acm:us-east-1:647757222309:certificate/nag',
  portalAlbOriginHost: 'mw.example.com',
};

test('every suppression names an AwsSolutions rule and gives a reason', () => {
  const ids = new Set<string>();
  for (const s of NAG_SUPPRESSIONS) {
    assert.match(s.id, /^AwsSolutions-[A-Z]+\d+$/);
    assert.ok(s.reason.length > 20, `${s.id}: a suppression needs a real reason`);
    assert.ok(!ids.has(`${s.id}:${s.stacks ?? '*'}:${s.paths ?? '*'}`), `${s.id} listed twice`);
    ids.add(`${s.id}:${s.stacks ?? '*'}:${s.paths ?? '*'}`);
  }
  // What this work item fixed must stay fixed, not suppressed.
  for (const fixed of ['AwsSolutions-RDS10', 'AwsSolutions-COG1', 'AwsSolutions-CFR5']) {
    assert.ok(!NAG_SUPPRESSIONS.some((s) => s.id === fixed), `${fixed} must not be suppressed`);
  }
});

test('cdk-nag AwsSolutions: no unsuppressed finding in the full app', { skip: installed ? false : 'cdk-nag is not installed (npm install -D cdk-nag@^2)' }, () => {
  const app = synthApp({ ...EVERYTHING, nag: 'true' });
  // Findings are error annotations in the cloud assembly manifest.
  const errors = Object.entries(app.errors).flatMap(([name, list]) => list.map((e) => `${name} ${e}`));
  assert.ok(app.stackNames.length > 15, 'the full app did not synthesise');
  assert.deepEqual(errors, [], 'fix the finding, or add it to infra/nag-suppressions.ts with a reason');
});
