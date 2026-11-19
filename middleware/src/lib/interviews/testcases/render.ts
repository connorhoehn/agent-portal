// Milo's test cases as text in the pad (docs/interviews-tenant-plan.md, "Milo's interview tools", `pad_add_tests`). Pure.
//
// The cases arrive as data only (the live session's background agent writes each case's arguments and expected value as JSON:
// milo-tools/tests.ts checks them). The words in the pad are written here, never by a model, so nothing a model says reaches the
// pad as code: a case is JSON values turned into the language's literals.
//
// The block is marked ("Test cases from Milo") and says what the cases are. An expected value is written only when the question's
// reference agreed with it (`checked`); a question with no reference gets inputs only, and the expected values are the coder's to
// fill in. Never a judgement of the candidate's code. Where the pad's language runs as a script (Python, JavaScript, TypeScript)
// and the pad defines a top-level function, the block also runs each case through that function (ok or DIFF per case when
// checked, the result when not), so the round's Run button tries them as they are; elsewhere (Swift, Java, Go, C++, or no
// function found) the cases are comments, one per line, in the call's notation.
import { scannable } from '../pad-text.js';
import type { PadLanguage } from '../types.js';

/** One case: the arguments in order, and (checked against the question's reference) the value the call returns. JSON values only. */
export interface TestCase { args: unknown[]; expected?: unknown }

/** The block's first line in every language, after the comment marker: how a reader (and the record) finds Milo's block. */
export const TEST_CASES_TITLE = 'Test cases from Milo';

const COMMENT: Readonly<Record<PadLanguage, string>> = { python: '#', swift: '//', javascript: '//', typescript: '//', java: '//', go: '//', cpp: '//' };

/** The note under the title: what the cases are and are not. With expected values, each one agreed with the question's reference. */
export const TEST_CASES_NOTE = [
  'Inputs Milo wrote for the question; each expected value was checked',
  'against the question\'s reference. Milo did not run or judge your code:',
  'edit or delete any case.',
];
/** The note for inputs only (no reference to check expected values against). */
export const TEST_INPUTS_NOTE = [
  'Inputs Milo wrote for the question. The expected values are yours to',
  'fill in. Milo did not run or judge your code: edit or delete any case.',
];

/**
 * The function a case calls: the pad's first top-level function (a Swift, Go or Java/C++ function by its declaration, for the
 * comments' notation); null when none is found.
 */
export function functionOf(text: string, language: PadLanguage): string | null {
  const re: Record<PadLanguage, RegExp> = {
    python: /^def\s+([A-Za-z_]\w*)\s*\(/m,
    javascript: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(/m,
    typescript: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]|^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(/m,
    go: /^func\s+([A-Za-z_]\w*)\s*\(/m,
    swift: /^\s*func\s+([A-Za-z_]\w*)\s*[(<]/m,
    // No two parts can match the same characters (the old java and cpp forms let a run of spaces be split many ways, which took
    // seconds on one long line): a type is words and brackets, with spaces only after a comma inside it.
    java: /^[ \t]*(?:(?:public|private|protected|static|final)[ \t]+)+[\w<>[\]]+(?:,[ \t]*[\w<>[\]]+)*[ \t]+([a-z_]\w*)[ \t]*\(/m,
    cpp: /^(?:[\w:<>,*&]+[ \t]+)+[*&]?([A-Za-z_]\w*)[ \t]*\([^;{]*\)\s*(?:const\s*)?\{/m,
  };
  const m = re[language].exec(scannable(text));
  const name = m ? (m[1] ?? m[2] ?? null) : null;
  return name && name !== 'main' ? name : null;
}

/** Languages whose pad runs as a script, so the block can call the function and print each case. */
const RUNS_AS_SCRIPT: ReadonlySet<PadLanguage> = new Set(['python', 'javascript', 'typescript']);

/** A JSON value as a Python literal (True/False/None, dicts and lists as Python writes them). */
export function pythonLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pythonLiteral).join(', ')}]`;
  if (typeof v === 'object') return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${pythonLiteral(x)}`).join(', ')}}`;
  return 'None';
}

/** A JSON value as JavaScript writes it (also the comments' notation). */
export function scriptLiteral(v: unknown): string {
  if (v === undefined) return 'null';
  if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
  if (Array.isArray(v)) return `[${v.map(scriptLiteral).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${scriptLiteral(x)}`).join(', ')} }`;
  return JSON.stringify(v);
}

function header(language: PadLanguage, count: number, checked: boolean): string[] {
  const c = COMMENT[language];
  return [`${c} --- ${TEST_CASES_TITLE} (${count}) ---`, ...(checked ? TEST_CASES_NOTE : TEST_INPUTS_NOTE).map((l) => `${c} ${l}`)];
}

/**
 * The block for `cases` in `language`, calling `fn` where the language can; it ends with a newline. Checked (expected values
 * written) only when every case carries one; otherwise inputs only.
 */
export function renderTestCases(cases: readonly TestCase[], language: PadLanguage, fn: string | null): string {
  const c = COMMENT[language];
  const checked = cases.length > 0 && cases.every((t) => t.expected !== undefined);
  const lines = header(language, cases.length, checked);
  const runs = fn !== null && RUNS_AS_SCRIPT.has(language);
  const py = (t: TestCase) => `(${t.args.map(pythonLiteral).join(', ')}${t.args.length === 1 ? ',' : ''})`;
  if (runs && language === 'python') {
    if (checked) {
      lines.push('milo_test_cases = [', '    # (arguments, expected)');
      for (const t of cases) lines.push(`    (${py(t)}, ${pythonLiteral(t.expected)}),`);
      lines.push(']', 'for args, expected in milo_test_cases:', `    got = ${fn}(*args)`,
        '    print("ok  " if got == expected else "DIFF", args, "->", got, "| expected", expected)');
    } else {
      lines.push('milo_test_inputs = [', '    # arguments');
      for (const t of cases) lines.push(`    ${py(t)},`);
      lines.push(']', 'for args in milo_test_inputs:', `    print(args, "->", ${fn}(*args))`);
    }
  } else if (runs) {
    const typed = language === 'typescript';
    const call = typed ? `(${fn} as unknown as (...a: unknown[]) => unknown)(...args)` : `${fn}(...args)`;
    if (checked) {
      lines.push(`const miloTestCases${typed ? ': Array<[unknown[], unknown]>' : ''} = [`, '  // [arguments, expected]');
      for (const t of cases) lines.push(`  [[${t.args.map(scriptLiteral).join(', ')}], ${scriptLiteral(t.expected)}],`);
      lines.push('];', 'for (const [args, expected] of miloTestCases) {', `  const got = ${call};`,
        '  console.log(JSON.stringify(got) === JSON.stringify(expected) ? "ok  " : "DIFF", JSON.stringify(args), "->", JSON.stringify(got), "| expected", JSON.stringify(expected));',
        '}');
    } else {
      lines.push(`const miloTestInputs${typed ? ': unknown[][]' : ''} = [`, '  // arguments');
      for (const t of cases) lines.push(`  [${t.args.map(scriptLiteral).join(', ')}],`);
      lines.push('];', 'for (const args of miloTestInputs) {', `  console.log(JSON.stringify(args), "->", JSON.stringify(${call}));`, '}');
    }
  } else {
    const name = fn ?? 'f';
    for (const t of cases) lines.push(`${c} ${name}(${t.args.map(scriptLiteral).join(', ')})${checked ? ` -> ${scriptLiteral(t.expected)}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
