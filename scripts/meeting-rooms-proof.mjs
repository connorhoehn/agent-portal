// E3 acceptance is a current, strict audit plus two passing, sealed journeys.
// A spec/map merely existing is not acceptance. Called by the meeting validator.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceDigest } from '../portal/e2e/route-inventory.ts';
import { judge } from './journeys/journeys.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function auditProof(report, digest, version) {
  assert.equal(report.revision?.sourceDigest, digest, 'audit must measure the current portal source');
  assert.equal(report.revision?.uiComponents, version, 'audit must measure the installed UI release');
  assert.equal(report.strictCoverage, true, 'strict coverage must be enabled');
  assert.deepEqual(report.unclassified, [], 'audit has unclassified controls');
  for (const theme of ['light', 'dark']) for (const width of [1440, 900]) {
    const cases = (report.cases ?? []).filter(c => c.tenant === 'orgiq' && c.route === '/iq/projects/p-observability' && c.state === 'call-rooms-pane' && c.theme === theme && c.width === width);
    assert.equal(cases.length, 1, `missing or duplicate Rooms case: ${theme}/${width}`);
    assert.ok(cases[0].measuredElements > 0, `Rooms case was not measured: ${theme}/${width}`);
    assert.ok(cases[0].samples?.some(s => s.selector.includes('breakout-')), `Rooms controls were not measured: ${theme}/${width}`);
    assert.deepEqual(cases[0].issues, [], `Rooms case has findings: ${theme}/${width}`);
  }
}

async function main() {
  assert.match(fs.readFileSync(path.join(ROOT, 'portal/e2e/ui-dom-audit.adapter.ts'), 'utf8'), /name: 'call-rooms-pane'/, 'audit adapter must expose the Rooms state');
  const dir = path.join(ROOT, 'docs/realtime-validation');
  const proof = fs.readdirSync(dir).sort().reverse().map(d => path.join(dir, d, 'meeting-ui-audit.json')).find(f => fs.existsSync(f));
  assert.ok(proof, 'no dated meeting UI audit');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'portal/node_modules/@connorhoehnslalom/ui-components/package.json'), 'utf8')).version;
  auditProof(JSON.parse(fs.readFileSync(proof, 'utf8')), sourceDigest(), version);
  const logs = [];
  for (const role of ['org-leader', 'sme']) {
    const { default: map } = await import(`../docs/journeys/maps/work/${role}/call-rooms.ts`);
    assert.ok(!map.hold, `${role} meeting map is held`);
    const log = `docs/work-journeys/${role}/call-rooms.md`;
    assert.match(fs.readFileSync(path.join(ROOT, log), 'utf8'), /^verdict: pass/m, `${role} meeting walk has not passed`);
    logs.push(log);
  }
  const verdicts = judge('docs/work-journeys', logs).split('\n').map(line => line.split('\t'));
  assert.equal(verdicts[0][1], 'ok', 'rendered contracts must measure current source');
  for (const [log, verdict, detail] of verdicts.slice(1)) assert.equal(verdict, 'fresh', `${log}: ${detail}`);
  console.log('E3: four strict Rooms cases and both current, sealed meeting journeys pass');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
