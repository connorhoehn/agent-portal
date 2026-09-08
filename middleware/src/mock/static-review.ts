// The offline reviewer — a real reading of a real diff, with no model.
//
// WHY THIS EXISTS. `lib/change-reviewer.ts` is a live Bedrock `Converse` call.
// Offline it throws, and the catch resolves to `request_changes` with the
// thrown message as the summary — which is exactly right under a real Bedrock
// outage (the failure mode of a gate must be "ask a human", never "approve"),
// and useless as a way to exercise the gate: every offline review came back
// with the same verdict for the same reason, so no reviewer branch was ever
// reached and no `evaluate()` outcome other than `changes_requested` was ever
// produced by a live request.
//
// THE ONE THING THIS MUST NOT BE is a rubber stamp. A mock reviewer that
// approves everything is strictly worse than the 503 it replaces: it makes a
// broken gate look green, and the whole premise of `lib/sdlc-policy.ts` is
// that a change is not trustworthy just because an agent produced it. So this
// is not a canned verdict — it is a small static analyser that reads the diff
// it was actually handed, finds things that are actually in it, and reports
// line numbers that actually exist. Its verdict then flows into the real
// `evaluate()` in `lib/sdlc-policy.ts` unchanged, so the recorded gates and
// the change's status are genuine engine output over a genuine verdict, the
// same way `mock/sdlc.ts` derives its seeded statuses.
//
// WHAT IT IS NOT. It is not a model and does not claim to be: it reports
// itself as `offline/static-diff-review`, never as a Bedrock model id, so a
// review row can always be told apart from one a model wrote. It reads added
// and removed lines and nothing else — it cannot judge correctness, scope, or
// whether the change did what was asked, which are the three things the real
// SYSTEM prompt asks for. It is a floor, not a substitute.

import type { ReviewVerdict } from '../lib/sdlc-policy.js';

/** The model id this reviewer records. Deliberately not a Bedrock model id. */
export const STATIC_REVIEW_MODEL = 'offline/static-diff-review';

export interface StaticFinding {
  severity: 'high' | 'medium' | 'low';
  file?: string;
  line?: number;
  note: string;
}

export interface StaticReview {
  verdict: ReviewVerdict;
  summary: string;
  findings: StaticFinding[];
  model: string;
}

// ─── Diff walking ───────────────────────────────────────────────────────────

/** One line of a unified diff, tagged with where it lives on the new side. */
interface DiffLine {
  file: string;
  /** New-side line number. Null for a removed line, which has none. */
  line: number | null;
  added: boolean;
  text: string;
}

/** The `b/` side of every `diff --git` header — the paths a change touches. */
export function diffFiles(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/.* b\/(.*)$/gm)].map((m) => m[1]!);
}

/**
 * Every added and removed line, each carrying the file it is in and — for an
 * added line — its number on the NEW side.
 *
 * The new-side number is what a reviewer finding must point at: the portal
 * pins each finding to a line of the stored diff, so a number taken from the
 * old side, or a bare index into the diff text, silently highlights the wrong
 * line (or none). Hunk headers (`@@ -a,b +c,d @@`) reset the counter.
 */
export function walkDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file = '';
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    const header = /^\+\+\+ b\/(.*)$/.exec(raw);
    if (header) { file = header[1]!; continue; }
    if (raw.startsWith('--- ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) { out.push({ file, line: newLine, added: true, text: raw.slice(1) }); newLine++; }
    else if (raw.startsWith('-')) out.push({ file, line: null, added: false, text: raw.slice(1) });
    else if (raw.startsWith(' ')) newLine++;
  }
  return out;
}

/** `2 files changed, 18 insertions(+), 3 deletions(-)` — derived, never stored. */
export function diffStat(diff: string): string {
  const lines = walkDiff(diff);
  const files = diffFiles(diff).length;
  const ins = lines.filter((l) => l.added).length;
  const del = lines.length - ins;
  const parts = [`${files} file${files === 1 ? '' : 's'} changed`];
  if (ins > 0) parts.push(`${ins} insertion${ins === 1 ? '' : 's'}(+)`);
  if (del > 0) parts.push(`${del} deletion${del === 1 ? '' : 's'}(-)`);
  return ` ${parts.join(', ')}`;
}

// ─── The rules ──────────────────────────────────────────────────────────────
//
// Each rule states what it looks for, in what direction, and what it means.
// A rule that cannot say something true about the diff in front of it does not
// fire — an "everything looks fine" finding is noise, and a finding pointing
// at a line that is not there is worse than none.

interface Rule {
  id: string;
  severity: StaticFinding['severity'];
  /** Added lines, removed lines, or both. */
  side: 'added' | 'removed';
  match: RegExp;
  /** Skip in files whose path matches — a test fixture may legitimately hold one. */
  exceptIn?: RegExp;
  note: (text: string) => string;
}

const RULES: Rule[] = [
  {
    id: 'secret',
    severity: 'high',
    side: 'added',
    match: /AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"']{8,}["']/i,
    note: () => 'This line looks like a credential committed into the repository. A secret in a diff is not a review comment, it is a rotation — do not merge this.',
  },
  {
    id: 'removed-guard',
    severity: 'high',
    side: 'removed',
    match: /\brequire(?:Action|Session|Tenant|ServiceAuth|TraceAuth)\b|\bassert\w*\(|\bvalidate\w*\(|\bverify\w*\(|\bcheckAuth\b/,
    note: (t) => `This change removes a check (\`${t.trim().slice(0, 80)}\`). Removing a guard is exactly the class of change a reviewer exists to stop — say why it is safe, or put it back.`,
  },
  {
    id: 'disabled-test',
    severity: 'medium',
    side: 'added',
    match: /\b(?:it|test|describe)\.(?:skip|only)\s*\(|\bxit\s*\(|\bxdescribe\s*\(/,
    note: () => 'A test is skipped or focused here. `.only` hides every other test in the file from CI; `.skip` hides this one.',
  },
  {
    id: 'debug-output',
    severity: 'medium',
    side: 'added',
    match: /\bconsole\.log\s*\(|\bdebugger\b|\bbinding\.pry\b/,
    exceptIn: /(?:^|\/)(?:scripts|tools|bin)\//,
    note: () => 'Debug output left in the change. It will run in production and it is not a log line anyone chose to keep.',
  },
  {
    id: 'unfinished',
    severity: 'low',
    side: 'added',
    match: /\b(?:TODO|FIXME|XXX|HACK)\b/,
    note: (t) => `The change adds an unfinished marker: \`${t.trim().slice(0, 80)}\`.`,
  },
];

/** Test-ish paths, for the "changed code, added no test" observation. */
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|spec)\/|\.(?:test|spec)\.[jt]sx?$|_test\.(?:py|go)$/;
/** Paths that are not code — a docs-only change is not missing a test. */
const NON_CODE_PATH = /\.(?:md|markdown|txt|rst|json|ya?ml|toml|lock|svg|png|jpe?g)$/i;

/**
 * Read a diff and judge it.
 *
 * The verdict follows from the findings, in the same fixed severity order the
 * gate aggregate uses: a committed credential is a `reject` (revision does not
 * un-leak a secret), any other high or medium finding is `request_changes`,
 * and a diff with only low findings — or none — is `approve`. An approve here
 * means "nothing this analyser can see is wrong", which is a real statement
 * about a real diff, and is said in those words in the summary so nobody reads
 * it as a model having vouched for the change.
 */
export function staticReview(input: { title: string; diff: string; truncated: boolean }): StaticReview {
  const lines = walkDiff(input.diff);
  const files = diffFiles(input.diff);
  const findings: StaticFinding[] = [];
  const fired = new Set<string>();

  for (const rule of RULES) {
    // One finding per rule per FILE. A rule that fires on forty lines of the
    // same file tells a reviewer nothing it did not say on the first; a second
    // file with the same problem is still worth its own line.
    const reported = new Set<string>();
    for (const l of lines) {
      if (l.added !== (rule.side === 'added')) continue;
      if (reported.has(l.file)) continue;
      if (rule.exceptIn?.test(l.file)) continue;
      if (!rule.match.test(l.text)) continue;
      reported.add(l.file);
      fired.add(rule.id);
      findings.push({
        severity: rule.severity,
        file: l.file,
        ...(l.line !== null ? { line: l.line } : {}),
        note: rule.note(l.text),
      });
    }
  }

  const codeFiles = files.filter((f) => !TEST_PATH.test(f) && !NON_CODE_PATH.test(f));
  const testFiles = files.filter((f) => TEST_PATH.test(f));
  if (codeFiles.length > 0 && testFiles.length === 0) {
    fired.add('no-test');
    findings.push({
      severity: 'low',
      ...(codeFiles[0] ? { file: codeFiles[0] } : {}),
      note: `The change edits ${codeFiles.length} code file${codeFiles.length === 1 ? '' : 's'} and adds no test. Not a blocker, but nothing pins the new behaviour.`,
    });
  }

  if (input.truncated) {
    fired.add('truncated');
    findings.push({
      severity: 'medium',
      note: 'The stored diff was truncated for size, so part of this change was not read. Judge the size itself before approving.',
    });
  }

  const worst = findings.some((f) => f.severity === 'high') ? 'high'
    : findings.some((f) => f.severity === 'medium') ? 'medium' : 'low';
  const verdict: ReviewVerdict = fired.has('secret') ? 'reject'
    : worst === 'low' ? 'approve' : 'request_changes';

  const what = fired.size > 0 ? [...fired].sort().join(', ') : 'nothing';
  const summary = verdict === 'approve'
    ? `Offline static review of ${files.length} file${files.length === 1 ? '' : 's'}: no credential, removed guard, skipped test or debug statement in the diff. This is a text scan, not a model — it does not vouch for correctness or scope.`
    : `Offline static review of ${files.length} file${files.length === 1 ? '' : 's'} found ${what}. This is a text scan, not a model — a clean scan would still not vouch for correctness or scope.`;

  return { verdict, summary, findings: findings.slice(0, 30), model: STATIC_REVIEW_MODEL };
}
