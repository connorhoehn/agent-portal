// Check every test fixture against the captured truth.
//
// THE BUG THIS EXISTS FOR. `knowledgeFormat.test.ts` built a section keyed
// `enterprise`. The server sends `enterprise_context`. The portal read
// `enterprise`, six documents were unreachable on /assessment/enterprise, and
// the test passed — because the test used the same invented key the code did.
// A test that agrees with the code proves nothing when both were typed from
// the same wrong memory. The only referee is the server.
//
// HOW IT WORKS. Every object literal in a test file is matched against the
// objects the server really sends (`vocabulary.matchObject`). An object that
// matches nothing is not a fixture for a response and is ignored. An object
// that matches gets two checks:
//
//   1. Invented wire VALUE — `key: 'enterprise'` where that object's `key`
//      on the real route is one of {enterprise_context, prompts, …}. This is
//      the bug, exactly.
//   2. Invented KEY — the fixture carries a field its matched shape has not
//      got. Only reported on a NEAR match (the shape accounts for most of the
//      fixture), because on no match there is no claim to contradict.
//
// The objects come from BOTH snapshots — the GET sweep and the write replay
// (`capture-writes.ts`). A `POST /api/bots` 201 carrying `{ bot: {...} }` is
// exactly as good a witness to what a bot looks like as a `GET /api/bots` row
// is, and a fixture standing in for a create/update/decide response is measured
// against the real one rather than against nothing at all.
//
// A fixture may OMIT anything. It may never INVENT. That asymmetry is the
// whole rule: omitting keeps the fixture small; inventing makes it fiction.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

import { repoRoot } from './paths.js';
import { WIRE_FIELDS } from './shape.js';
import { matchObject, valuesFor, loadVocabulary, fixtureFilesRoots, type Vocabulary } from './vocabulary.js';
import { serverCorpus, type ServerCorpus } from './corpus.js';
import type { Match } from './vocabulary.js';
import { ALLOWED, isAllowed, knownBugs } from './allow.js';

export interface Finding {
  /** Repo-relative `portal/src/.../knowledgeFormat.test.ts:64`. */
  where: string;
  file: string;
  line: number;
  kind: 'value' | 'key';
  /** The field the value sat under, or the invented key name. */
  field: string;
  value?: string;
  /** The route whose shape the fixture was measured against. */
  route: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Which files hold fixtures
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'snapshots']);

/**
 * This module's own tests are exempt: they contain deliberately wrong fixtures
 * as test input, and flagging those would make the checker fail on itself.
 */
const SELF = 'middleware/src/mock/core/wire/';

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.test\.tsx?$/.test(name) && full.includes('__tests__')) out.push(full);
  }
}

/** Every `__tests__/*.test.ts(x)` under middleware/src and portal/src. */
export function fixtureFiles(roots = fixtureFilesRoots): string[] {
  const base = repoRoot();
  const out: string[] = [];
  for (const r of roots) {
    const dir = join(base, r);
    if (existsSync(dir)) walk(dir, out);
  }
  return out
    .map((f) => relative(base, f))
    .filter((f) => !f.startsWith(SELF))
    .sort();
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

function quoteList(values: Iterable<string>, max = 8): string {
  const all = [...values].sort();
  const shown = all.slice(0, max).map((v) => `'${v}'`).join(', ');
  return all.length > max ? `${shown}, … (${all.length} total)` : shown;
}

function propertyName(p: ts.ObjectLiteralElementLike): string | null {
  const name = p.name;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** `GET /api/assessment/knowledge/tree sections[]` — how a shape is named. */
function shapeName(route: string, path: string): string {
  return path === '$' ? route : `${route} \`${path}\``;
}

/** Say out loud when the fixture could be several responses. */
function others(match: Match): string {
  const n = match.refs.length - 1;
  return n > 0 ? ` (and ${n} other response shape${n === 1 ? '' : 's'} it could be)` : '';
}

/**
 * Scan one file. `text` is passed in so a test can scan a string without
 * writing it to disk.
 */
export function scanSource(
  relPath: string,
  text: string,
  vocab: Vocabulary,
  corpus: ServerCorpus = serverCorpus(),
): Finding[] {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];

  const at = (node: ts.Node): { line: number; where: string } => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    return { line, where: `${relPath}:${line}` };
  };

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const props = node.properties.filter(ts.isPropertyAssignment);
      const keys = props.map(propertyName).filter((k): k is string => k !== null);
      // A spread means the literal is a patch over something else, so its key
      // set is not the whole object and "invents a key" cannot be concluded.
      const hasSpread = node.properties.some(ts.isSpreadAssignment);
      const match = matchObject(vocab, keys);

      if (match) {
        // ---- check 1: invented wire values -----------------------------
        for (const p of props) {
          const field = propertyName(p);
          if (field === null || !WIRE_FIELDS.has(field)) continue;
          const known = valuesFor(match, field);
          if (known.size === 0) continue; // server never sent a string there

          const init = p.initializer;
          const literals: ts.StringLiteral[] = [];
          if (ts.isStringLiteral(init)) literals.push(init);
          else if (ts.isArrayLiteralExpression(init)) {
            for (const el of init.elements) if (ts.isStringLiteral(el)) literals.push(el);
          }
          for (const lit of literals) {
            if (known.has(lit.text)) continue;
            // Second witness: the capture is a lower bound, so a value the
            // server's own source spells somewhere is real even if this
            // capture did not happen to contain it. See corpus.ts.
            if (corpus.strings.has(lit.text)) continue;
            if (isAllowed(relPath, { field, value: lit.text })) continue;
            const { line, where } = at(lit);
            findings.push({
              where,
              file: relPath,
              line,
              kind: 'value',
              field,
              value: lit.text,
              route: match.ref.route,
              message:
                `fixture \`${relPath}\` invents ${field} \`${lit.text}\`; ` +
                `${shapeName(match.ref.route, match.ref.path)}${others(match)} sends ` +
                `${quoteList(known)}, and no middleware source file spells ` +
                `'${lit.text}' either.`,
            });
          }
        }

        // ---- check 2: invented key names -------------------------------
        if (!hasSpread) {
          for (const p of props) {
            const field = propertyName(p);
            if (field === null || !match.missing.includes(field)) continue;
            if (corpus.words.has(field)) continue;
            if (isAllowed(relPath, { key: field })) continue;
            const { line, where } = at(p);
            findings.push({
              where,
              file: relPath,
              line,
              kind: 'key',
              field,
              route: match.ref.route,
              message:
                `fixture \`${relPath}\` invents key \`${field}\`; it otherwise matches ` +
                `${shapeName(match.ref.route, match.ref.path)}, which sends ` +
                `${quoteList(match.ref.keys)}, and no middleware source file names ` +
                `\`${field}\` either.`,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return findings;
}

export function scanRepo(vocab: Vocabulary, files = fixtureFiles()): Finding[] {
  const base = repoRoot();
  const corpus = serverCorpus();
  const out: Finding[] = [];
  for (const rel of files) {
    out.push(...scanSource(rel, readFileSync(join(base, rel), 'utf8'), vocab, corpus));
  }
  return out.sort((a, b) => a.where.localeCompare(b.where));
}

/**
 * The known PRODUCT bugs — disagreements that are real and not the fixture's
 * fault. Printed on every run, passing or failing, so they cannot rot into
 * background noise the way an unexplained exemption does.
 */
export function formatKnownBugs(): string {
  const bugs = knownBugs();
  if (bugs.length === 0) return '';
  const lines = [`${bugs.length} known product bug(s) recorded in ${ALLOWED.file}:`, ''];
  for (const b of bugs) {
    lines.push(`  ${b.file}${b.key ? ` — key \`${b.key}\`` : ''}${b.value ? ` — ${b.field} '${b.value}'` : ''}`);
    lines.push(`    ${b.reason}`, '');
  }
  return lines.join('\n');
}

/** Multi-line, one finding per paragraph. Readable without curling anything. */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'no fixture disagrees with the captured server shapes';
  const lines = [`${findings.length} fixture(s) disagree with the captured server shapes:`, ''];
  for (const f of findings) lines.push(`  ${f.where}`, `    ${f.message}`, '');
  lines.push(
    'A fixture may omit a field the server sends. It may never invent one.',
    'If the server changed, regenerate the snapshot (middleware/src/mock/core/contract.ts, "Wire capture").',
    `If the disagreement is intentional, declare it with a reason in ${ALLOWED.file}.`,
  );
  return lines.join('\n');
}

// `npx tsx src/mock/core/wire/scan.ts` — the sweep, on demand.
if (process.argv[1]?.endsWith('scan.ts')) {
  const vocab = loadVocabulary();
  const files = fixtureFiles();
  const findings = scanRepo(vocab, files);
  const refused = Object.values(vocab.writeRefusedByRule).reduce((a, b) => a + b, 0);
  console.log(
    `wire: ${vocab.capturedCount}/${vocab.routeCount} GET routes captured ${vocab.capturedAt}; ` +
      `${vocab.writeCapturedCount}/${vocab.writeRouteCount} write routes replayed ` +
      `(${refused} refused by write-policy.ts); ` +
      `${vocab.objects.length} server object shapes; scanned ${files.length} fixture file(s)`,
  );
  const rules = Object.entries(vocab.writeRefusedByRule).sort((a, b) => b[1] - a[1]);
  if (rules.length > 0) {
    console.log(`  refused: ${rules.map(([rule, n]) => `${n} ${rule}`).join(', ')}`);
  }
  const bugs = formatKnownBugs();
  if (bugs) console.log(`\n${bugs}`);
  console.log(formatFindings(findings));
  process.exit(findings.length === 0 ? 0 : 1);
}
