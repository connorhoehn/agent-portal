#!/usr/bin/env node
// Fold the demo-content probe's per-walker shards (<shots>/captures/*.json)
// into docs/demo-content/probe-index.json, replacing only the walkers that ran.
//   node scripts/demo-content/merge-probe.mjs <shots-dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs/demo-content/probe-index.json');
const shots = process.argv[2];
if (!shots) { console.error('usage: merge-probe.mjs <shots-dir>'); process.exit(2); }
const dir = path.join(shots, 'captures');
const shards = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const fresh = shards.flatMap((s) => s.captures);
const ran = new Set(fresh.map((c) => `${c.tenant}:${c.role}`));
const prior = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { captures: [] };
const captures = [...prior.captures.filter((c) => !ran.has(`${c.tenant}:${c.role}`)), ...fresh]
  .sort((a, b) => `${a.tenant}\0${a.role}\0${a.route}`.localeCompare(`${b.tenant}\0${b.role}\0${b.route}`));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: shards.map((s) => s.generatedAt).sort().at(-1),
  gitHead: shards[0]?.gitHead ?? null,
  shots: 'PNG screenshots are kept outside the repo; `shot` is relative to the probe run\'s DEMO_PROBE_SHOTS directory',
  captures,
}, null, 1) + '\n');
console.log(`${captures.length} captures (${fresh.length} fresh from ${shards.length} walkers) -> ${path.relative(ROOT, OUT)}`);
