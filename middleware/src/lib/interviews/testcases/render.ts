// Milo's test cases as text in the pad (docs/interviews-tenant-plan.md, "Milo writes test cases"). Pure.
//
// The model answers with data only: each case's arguments and expected value as JSON. The words in the pad are written here,
// never by the model, so nothing it says reaches the pad as code: a case is JSON values turned into the language's literals.
//
// The block is marked ("Test cases from Milo") and says what the cases are: inputs and expected values written from the
// question alone, not checked, and not a judgement of the candidate's code. Where the pad's language runs as a script
// (Python, JavaScript, TypeScript) and the pad defines a top-level function, the block also runs each case through that
// function and prints ok or DIFF per case, so the round's Run button tries them as they are; elsewhere (Swift, Java, Go,
// C++, or no function found) the cases are comments, one per line, in the call's notation.
import type { PadLanguage } from '../types.js';

/** One case: the arguments in order, and the value the question says the call returns. JSON values only. */
export interface TestCase { args: unknown[]; expected: unknown }

/** The block's first line in every language, after the comment marker: how a reader (and the record) finds Milo's block. */
export const TEST_CASES_TITLE = 'Test cases from Milo';

const COMMENT: Readonly<Record<PadLanguage, string>> = { python: '#', swift: '//', javascript: '//', typescript: '//', java: '//', go: '//', cpp: '//' };

/** The note under the title: what the cases are and are not. */
export const TEST_CASES_NOTE = [
  'Inputs and expected values Milo wrote from the question alone.',
  'Milo did not run or check your code, and the expected values are',
  'unchecked: edit or delete any case.',
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
    java: /^\s*(?:(?:public|private|protected|static|final)\s+)+[\w<>\[\], ]+\s+([a-z_]\w*)\s*\(/m,
    cpp: /^[\w:<>,* &]+\s+[*&]?([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/m,
  };
  const m = re[language].exec(text);
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

function header(language: PadLanguage, count: number): string[] {
  const c = COMMENT[language];
  return [`${c} --- ${TEST_CASES_TITLE} (${count}) ---`, ...TEST_CASES_NOTE.map((l) => `${c} ${l}`)];
}

/** The block for `cases` in `language`, calling `fn` where the language can; it ends with a newline. */
export function renderTestCases(cases: readonly TestCase[], language: PadLanguage, fn: string | null): string {
  const c = COMMENT[language];
  const lines = header(language, cases.length);
  const runs = fn !== null && RUNS_AS_SCRIPT.has(language);
  if (runs && language === 'python') {
    lines.push('milo_test_cases = [', '    # (arguments, expected)');
    for (const t of cases) lines.push(`    ((${t.args.map(pythonLiteral).join(', ')}${t.args.length === 1 ? ',' : ''}), ${pythonLiteral(t.expected)}),`);
    lines.push(']', 'for args, expected in milo_test_cases:', `    got = ${fn}(*args)`,
      '    print("ok  " if got == expected else "DIFF", args, "->", got, "| expected", expected)');
  } else if (runs) {
    const typed = language === 'typescript';
    lines.push(`const miloTestCases${typed ? ': Array<[unknown[], unknown]>' : ''} = [`, '  // [arguments, expected]');
    for (const t of cases) lines.push(`  [[${t.args.map(scriptLiteral).join(', ')}], ${scriptLiteral(t.expected)}],`);
    const call = typed ? `(${fn} as unknown as (...a: unknown[]) => unknown)(...args)` : `${fn}(...args)`;
    lines.push('];', 'for (const [args, expected] of miloTestCases) {', `  const got = ${call};`,
      '  console.log(JSON.stringify(got) === JSON.stringify(expected) ? "ok  " : "DIFF", JSON.stringify(args), "->", JSON.stringify(got), "| expected", JSON.stringify(expected));',
      '}');
  } else {
    const name = fn ?? 'f';
    for (const t of cases) lines.push(`${c} ${name}(${t.args.map(scriptLiteral).join(', ')}) -> ${scriptLiteral(t.expected)}`);
  }
  return `${lines.join('\n')}\n`;
}
