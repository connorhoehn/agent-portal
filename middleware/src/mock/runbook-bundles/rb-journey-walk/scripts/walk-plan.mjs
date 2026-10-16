#!/usr/bin/env node
// runtime: node >=20
// deps: none (node built-ins only); live mode runs the repo's scripts/journeys/journeys.mjs judge
// Decide what a journey family needs BEFORE anyone opens a browser: measure, re-walk which
// directories, fix which logs — in the order that wastes no walk. It reads the freshness judge's
// TSV (MEASURED line, then one `log<TAB>verdict<TAB>detail` line per log) and prints a plan.
//
//   node scripts/walk-plan.mjs --repo ~/Projects/aws-agentcore --family work [--role member]
//   node scripts/walk-plan.mjs --tsv data/judge-sample.tsv --family work      # offline, from a saved judge run
//
// Exit: 0 nothing owed, 1 work owed (the plan says what), 2 bad arguments.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const NOT_LOGS = new Set(['PROTOCOL.md', 'DEFECTS.md', 'MATRIX.md', 'RAIL.md']);

/** Every .md under a family dir that is a log (not a protocol/ledger), relative to the repo. */
function familyLogs(repo, famDir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(join(repo, d)).sort()) {
      const p = join(d, n);
      if (statSync(join(repo, p)).isDirectory()) walk(p);
      else if (n.endsWith('.md') && !NOT_LOGS.has(n)) out.push(p);
    }
  };
  walk(famDir);
  return out;
}

/** Parse the judge's TSV into { measured, problems, logs: [{ log, verdict, detail }] }. */
export function parseJudge(tsv) {
  const lines = tsv.split('\n').filter((l) => l.trim());
  const res = { measured: true, problems: '', logs: [] };
  for (const l of lines) {
    const [a, b = '', c = ''] = l.split('\t');
    if (a === 'MEASURED') { res.measured = b === 'ok'; res.problems = c; continue; }
    res.logs.push({ log: a, verdict: b, detail: c });
  }
  return res;
}

/** The directory a log is sealed with: the first folder under docs/<family>-journeys/. */
const dirOf = (famDir, log) => {
  const rest = log.startsWith(famDir + '/') ? log.slice(famDir.length + 1) : log;
  return rest.includes('/') ? rest.split('/')[0] : '.';
};

/** The plan, as lines. Pure: the same TSV gives the same plan. */
export function plan(judged, { family, famDir }) {
  const out = [];
  const by = (v) => judged.logs.filter((x) => x.verdict === v);
  const counts = ['fresh', 'stale', 'unsealed', 'unswept', 'unrouted', 'record']
    .map((v) => [v, by(v).length]).filter(([, n]) => n).map(([v, n]) => `${n} ${v}`).join(', ');
  out.push(`family ${family}: ${judged.logs.length} logs — ${counts || 'none'}`);
  out.push(`contracts: ${judged.measured ? 'measured on the current source' : `NOT measured on the current source (${judged.problems})`}`);
  const steps = [];
  if (!judged.measured) {
    steps.push('Finish every portal/src edit and every library pin move first: the contracts are keyed on the source digest, so a later edit unmeasures them again.');
    steps.push('Run scripts/journeys/measure.sh (about 15 minutes; one sweep: measure.sh rail|cascade|type-scale).');
    steps.push('Rerun this plan: the stale list below is provisional until the contracts are measured.');
  }
  for (const x of by('unswept')) steps.push(`Add the route to OBSERVED_ROUTES in portal/e2e/route-inventory.ts, then measure, then walk: ${x.log} (${x.detail})`);
  for (const x of by('unrouted')) steps.push(`Give ${x.log} a url: line naming an inventoried route (or a pages: line), then walk it.`);
  const owed = new Map();
  for (const x of [...by('stale'), ...by('unsealed')]) {
    const d = dirOf(famDir, x.log);
    if (!owed.has(d)) owed.set(d, []);
    owed.get(d).push(x);
  }
  for (const [d, xs] of [...owed].sort(([a], [b]) => a.localeCompare(b))) {
    const names = xs.map((x) => `${x.log.split('/').pop()} (${x.verdict}${x.verdict === 'stale' ? `: ${x.detail}` : ''})`);
    const cmd = d === '.' ? `node scripts/journeys/run-maps.mjs walk ${family}` : `node scripts/journeys/run-maps.mjs walk ${family} --role ${d}`;
    steps.push(`Walk the whole ${d} directory so it can be sealed: ${cmd}  — owed: ${names.join('; ')}`);
  }
  if (owed.size && judged.measured) steps.push('Commit the logs, screenshots and .contract-sha together after each sealed directory.');
  if (!steps.length) out.push('plan: nothing owed — every log is fresh.');
  else { out.push('plan:'); steps.forEach((s, i) => out.push(`  ${i + 1}. ${s}`)); }
  return out;
}

function live(repo) {
  const up = (url) => { try { execFileSync('curl', ['-sf', '-o', '/dev/null', '--max-time', '3', url]); return true; } catch { return false; } };
  // Node processes only: a shell whose command line merely mentions the script is not a run.
  const ps = (() => { try { return execFileSync('ps', ['-Ao', 'pid=,comm=,args='], { encoding: 'utf8' }).split('\n'); } catch { return []; } })();
  const pids = (re) => ps.map((l) => l.trim().split(/\s+/)).filter(([pid, comm, ...args]) => /(^|\/)node$/.test(comm ?? '') && Number(pid) !== process.pid && re.test(args.join(' '))).map(([pid]) => pid);
  const lines = [`stack: portal :5183 ${up('http://localhost:5183/') ? 'up' : 'DOWN'}, middleware :3001 ${up('http://127.0.0.1:3001/api/health') ? 'up' : 'DOWN'}`];
  const audit = pids(/audit\.mjs/);
  const walks = pids(/run-maps\.mjs walk/);
  if (audit.length) lines.push(`busy: a ui-dom-audit run holds the seed identities (pids ${audit.join(', ')}); clone maps still walk, persona maps wait`);
  if (walks.length) lines.push(`busy: run-maps walks already running (pids ${walks.join(', ')}); do not walk the same directory twice at once`);
  const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', 'portal/src', 'portal/package.json'], { encoding: 'utf8' }).trim();
  if (dirty) lines.push(`warning: portal/src or portal/package.json has uncommitted edits (${dirty.split('\n').length} paths) — someone may still be changing what you would measure`);
  return lines;
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { repo: { type: 'string' }, family: { type: 'string' }, role: { type: 'string' }, tsv: { type: 'string' } } }));
  } catch (e) { console.error(e.message); process.exit(2); }
  if (!values.family || (!values.repo && !values.tsv)) {
    console.error('usage: walk-plan.mjs --family <family> (--repo <repo> | --tsv <saved judge output>) [--role <dir>]');
    process.exit(2);
  }
  const famDir = `docs/${values.family}-journeys`;
  let tsv; let pre = [];
  if (values.tsv) tsv = readFileSync(values.tsv, 'utf8');
  else {
    const repo = values.repo;
    if (!existsSync(join(repo, famDir))) { console.error(`no ${famDir} under ${repo}`); process.exit(2); }
    let logs = familyLogs(repo, famDir);
    if (values.role) logs = logs.filter((l) => relative(famDir, l).startsWith(`${values.role}/`));
    tsv = execFileSync('node', ['scripts/journeys/journeys.mjs', 'judge', famDir, ...logs], { cwd: repo, encoding: 'utf8', maxBuffer: 16 << 20 });
    pre = live(repo);
  }
  const judged = parseJudge(tsv);
  if (values.role && values.tsv) judged.logs = judged.logs.filter((x) => x.log.startsWith(`${famDir}/${values.role}/`));
  const lines = [...pre, ...plan(judged, { family: values.family, famDir })];
  console.log(lines.join('\n'));
  process.exit(lines.some((l) => l.startsWith('plan:') && !l.includes('nothing owed')) ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
