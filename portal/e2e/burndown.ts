// Burn-down files (audit 2026-10-07 J1, stop-doing rule 3): debt that a judge
// tolerates is listed entry by entry, each with an OWNER SURFACE and a DUE
// DATE. A ratchet that only says "never up" blesses whatever existed the day
// it was minted; a burn-down fails the day an entry outlives its date.
//
// Format (tab-separated, `#` comments):
//   <group>  <item>  <count>  <owner>  <due YYYY-MM-DD>
// type-scale:   group = inventory route key, item = "rule region size/weight", count = 1
// layout drift: group = drift class,         item = portal file,                count = offenders in it
//
// The judge (this module's `check`):
//   PASTDUE  a row still counting after its due date           -> fail
//   OVER     current count above the row (0 when no row)       -> fail
//   BURNED   current count below the row                       -> note: lower the row
//   INVALID  a malformed row (no owner, bad date, bad count)   -> fail
// and the remaining count per owner surface, with its due dates.
//
//   node portal/e2e/burndown.ts check <file> [--current <group\titem\tcount file>] [--today YYYY-MM-DD]
//   node portal/e2e/burndown.ts owner <portal-file-or-route>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Row { group: string; item: string; count: number; owner: string; due: string }
/** The date the 2026-10-07 baselines are scheduled to reach zero (the retired scripts/layout-drift-budget.txt said so on adoption). */
export const DEFAULT_DUE = '2026-10-21';

export function parseBurndown(text: string): { rows: Row[]; invalid: string[] } {
  const rows: Row[] = []; const invalid: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim() || line.startsWith('#')) return;
    const [group, item, count, owner, due] = line.split('\t');
    const n = Number(count);
    if (!group || !item || !Number.isInteger(n) || n < 0 || !owner || !/^\d{4}-\d{2}-\d{2}$/.test(due ?? '')) { invalid.push(`${i + 1}: ${line}`); return; }
    rows.push({ group, item, count: n, owner, due: due! });
  });
  return { rows, invalid };
}

export function readRows(file: string): Row[] | null {
  try { return parseBurndown(fs.readFileSync(file, 'utf8')).rows; } catch { return null; }
}

export function writeRows(file: string, header: string[], rows: Row[]) {
  const body = [...rows].sort((a, b) => a.group.localeCompare(b.group) || a.item.localeCompare(b.item))
    .map((r) => [r.group, r.item, r.count, r.owner, r.due].join('\t'));
  fs.writeFileSync(file, `${[...header.map((h) => `# ${h}`.trimEnd()), ...body].join('\n')}\n`);
}

/** The owner surface of a portal file or an inventory route key. */
export function ownerOf(subject: string): string {
  if (subject.endsWith(' · primary rail')) return 'shell/primary-rail';
  const route = subject.match(/^\/(iq|assessment|social|pipelines|admin|settings)(?:\/([^/?\s·]+))?/);
  if (route) {
    const tenant = route[1] === 'iq' ? 'orgiq' : route[1]!;
    return route[1] === 'settings' ? 'shell/settings' : `${tenant}/${route[2] ?? 'landing'}`;
  }
  const rel = subject.replace(/^.*?portal\/src\//, '');
  const parts = rel.split('/');
  if (parts.length === 1) return parts[0]!.replace(/\.[tj]sx?$/, '');
  if (parts.length === 2 && /\.[tj]sx?$/.test(parts[1]!)) return `${parts[0]}/${parts[1]!.replace(/\.[tj]sx?$/, '')}`;
  return `${parts[0]}/${parts[1]}`;
}

export interface Verdict { pastDue: Row[]; over: Array<{ group: string; item: string; current: number; allowed: number }>; burned: Array<{ group: string; item: string; current: number; allowed: number }>; owners: Map<string, { remaining: number; first: string; last: string }>; total: number }

export function check(rows: Row[], today: string, current?: Map<string, number>): Verdict {
  const v: Verdict = { pastDue: [], over: [], burned: [], owners: new Map(), total: 0 };
  const byKey = new Map(rows.map((r) => [`${r.group}\t${r.item}`, r]));
  for (const r of rows) {
    const now = current ? (current.get(`${r.group}\t${r.item}`) ?? 0) : r.count;
    if (now > 0 && r.due < today) v.pastDue.push(r);
    if (current && now < r.count) v.burned.push({ group: r.group, item: r.item, current: now, allowed: r.count });
    const live = Math.min(now, r.count);
    v.total += live;
    if (live > 0) {
      const o = v.owners.get(r.owner) ?? { remaining: 0, first: r.due, last: r.due };
      o.remaining += live; if (r.due < o.first) o.first = r.due; if (r.due > o.last) o.last = r.due;
      v.owners.set(r.owner, o);
    }
  }
  if (current) for (const [key, n] of current) {
    const r = byKey.get(key);
    if (n > (r?.count ?? 0)) { const [group, item] = key.split('\t'); v.over.push({ group: group!, item: item!, current: n, allowed: r?.count ?? 0 }); }
  }
  return v;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  if (cmd === 'owner' && file) { process.stdout.write(`${ownerOf(file)}\n`); process.exit(0); }
  if (cmd !== 'check' || !file) { process.stderr.write('usage: burndown.ts check <file> [--current <tsv>] [--today YYYY-MM-DD] | owner <file|route>\n'); process.exit(2); }
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { process.stdout.write(`MISSING ${file}\n`); process.exit(0); }
  const { rows, invalid } = parseBurndown(text);
  const today = arg('--today') ?? new Date().toISOString().slice(0, 10);
  let current: Map<string, number> | undefined;
  const cur = arg('--current');
  if (cur) {
    current = new Map();
    for (const line of fs.readFileSync(cur === '-' ? 0 : cur, 'utf8').split('\n').filter(Boolean)) {
      const [g, i, n] = line.split('\t'); current.set(`${g}\t${i}`, (current.get(`${g}\t${i}`) ?? 0) + Number(n));
    }
  }
  const v = check(rows, today, current);
  const out: string[] = [`TOTAL ${v.total}`, `TODAY ${today}`];
  for (const line of invalid) out.push(`INVALID ${line}`);
  for (const r of v.pastDue) out.push(`PASTDUE ${r.group}\t${r.item}\t${r.count}\t${r.owner}\t${r.due}`);
  for (const o of v.over) out.push(`OVER ${o.group}\t${o.item}\t${o.current}\t${o.allowed}`);
  for (const b of v.burned) out.push(`BURNED ${b.group}\t${b.item}\t${b.current}\t${b.allowed}`);
  for (const [owner, o] of [...v.owners].sort((a, b) => b[1].remaining - a[1].remaining || a[0].localeCompare(b[0]))) out.push(`OWNER ${owner}\t${o.remaining}\t${o.first === o.last ? o.first : `${o.first}..${o.last}`}`);
  process.stdout.write(`${out.join('\n')}\n`);
}
