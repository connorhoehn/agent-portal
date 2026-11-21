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
import { MAX_SCAN_TEXT, scannable } from '../pad-text.js';
import type { PadLanguage } from '../types.js';

/** One case: the arguments in order, and (checked against the question's reference) the value the call returns. JSON values only. */
/** `covers`: the case the asker named that this one answers. `edge`: an input the question's reference has no single answer for
 * (an empty array for two_sum), written because it was asked for: shown with what the function returns, no expected value. */
export interface TestCase { args: unknown[]; expected?: unknown; covers?: string; edge?: boolean; assumption?: string }

/** The block's first line in every language, after the comment marker: how a reader (and the record) finds Milo's block. */
export const TEST_CASES_TITLE = 'Test cases from Milo';

/** Each pad language's line comment (the one map). */
export const COMMENT: Readonly<Record<PadLanguage, string>> = { python: '#', swift: '//', javascript: '//', typescript: '//', java: '//', go: '//', cpp: '//' };

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

/** The note above the edge inputs that were asked for, in a checked block. */
export const EDGE_INPUTS_NOTE = 'Inputs you asked for that have no single right answer in the question: what should it return?';

/**
 * The function a case calls: the pad's first top-level function (a Swift, Go or Java/C++ function by its declaration, for the
 * comments' notation); null when none is found.
 */
export function functionOf(text: string, language: PadLanguage): string | null {
  const re: Record<PadLanguage, RegExp> = {
    // Whitespace in these is spaces and tabs only, and no run crosses a newline (review 2, item 1): `\s*` from every line's
    // start ran to the end of a pad of newlines, once per line.
    python: /^def[ \t]+([A-Za-z_]\w*)[ \t]*\(/m,
    javascript: /^(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(|^(?:export[ \t]+)?(?:const|let)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]+)?\(/m,
    typescript: /^(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*[(<]|^(?:export[ \t]+)?(?:const|let)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]+)?\(/m,
    go: /^func[ \t]+([A-Za-z_]\w*)[ \t]*\(/m,
    swift: /^[ \t]*func[ \t]+([A-Za-z_]\w*)[ \t]*[(<]/m,
    // No two parts can match the same characters (the old java and cpp forms let a run of spaces be split many ways, which took
    // seconds on one long line): a type is words and brackets, with spaces only after a comma inside it.
    java: /^[ \t]*(?:(?:public|private|protected|static|final)[ \t]+)+[\w<>[\]]+(?:,[ \t]*[\w<>[\]]+)*[ \t]+([a-z_]\w*)[ \t]*\(/m,
    // The parameters on the declaration's line; the brace there or at the start of the next.
    cpp: /^(?:[\w:<>,*&]+[ \t]+)+[*&]?([A-Za-z_]\w*)[ \t]*\([^;{\n]*\)[ \t]*(?:const[ \t]*)?\r?\n?[ \t]*\{/m,
  };
  const m = re[language].exec(scannable(text.length > MAX_SCAN_TEXT ? text.slice(0, MAX_SCAN_TEXT) : text));
  const name = m ? (m[1] ?? m[2] ?? null) : null;
  return name && name !== 'main' ? name : null;
}

/** Languages whose pad runs as a script, so the block can call the function and print each case. */
const RUNS_AS_SCRIPT: ReadonlySet<PadLanguage> = new Set(['python', 'javascript', 'typescript']);

/**
 * A string as a quoted literal: JSON's escaping, and U+2028 and U+2029 escaped too. JSON leaves them raw, and in a JavaScript
 * `//` comment either one ends the line, so the rest of a case string ran as code (review 2, item 6). The escapes mean the same
 * in every language's string literal here.
 */
export const quoted = (s: string): string => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** A JSON value as a Python literal (True/False/None, dicts and lists as Python writes them). */
export function pythonLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None';
  if (typeof v === 'string') return quoted(v);
  if (Array.isArray(v)) return `[${v.map(pythonLiteral).join(', ')}]`;
  if (typeof v === 'object') return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${quoted(k)}: ${pythonLiteral(x)}`).join(', ')}}`;
  return 'None';
}

/** A JSON value as JavaScript writes it (also the comments' notation). */
export function scriptLiteral(v: unknown): string {
  if (v === undefined) return 'null';
  if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
  if (Array.isArray(v)) return `[${v.map(scriptLiteral).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quoted(k)}: ${scriptLiteral(x)}`).join(', ')} }`;
  return typeof v === 'string' ? quoted(v) : JSON.stringify(v);
}

function header(language: PadLanguage, count: number, checked: boolean, assumed = false): string[] {
  const c = COMMENT[language];
  const note = assumed ? ['Expected values are reference-checked except those marked as assumptions.', 'Milo did not run or judge your code: edit or delete any case.'] : checked ? TEST_CASES_NOTE : TEST_INPUTS_NOTE;
  return [`${c} --- ${TEST_CASES_TITLE} (${count}) ---`, ...note.map((l) => `${c} ${l}`)];
}

/**
 * The block for `cases` in `language`, calling `fn` where the language can; it ends with a newline. Checked (expected values
 * written) only when every case carries one; otherwise inputs only.
 */
export function renderTestCases(all: readonly TestCase[], language: PadLanguage, fn: string | null): string {
  const c = COMMENT[language];
  // Checked when every case that is not an asked-for edge input carries an expected value; the edge inputs follow, inputs only.
  const edges = all.filter((t) => t.edge);
  const rest = all.filter((t) => !t.edge);
  const checked = rest.length > 0 && rest.every((t) => t.expected !== undefined);
  const cases = checked ? rest : all;
  const tail = checked ? edges : [];
  const lines = header(language, all.length, checked, all.some((t) => !!t.assumption));
  const runs = fn !== null && RUNS_AS_SCRIPT.has(language);
  const py = (t: TestCase) => `(${t.args.map(pythonLiteral).join(', ')}${t.args.length === 1 ? ',' : ''})`;
  if (runs && language === 'python') {
    if (checked) {
      lines.push('milo_test_cases = [', '    # (arguments, expected)');
      for (const t of cases) {
        if (t.assumption) lines.push(`    # ${t.assumption}`);
        lines.push(`    (${py(t)}, ${pythonLiteral(t.expected)}),`);
      }
      lines.push(']', 'milo_failures = 0', 'for args, expected in milo_test_cases:', `    got = ${fn}(*args)`,
        '    milo_failures += int(got != expected)',
        '    print("ok  " if got == expected else "DIFF", args, "->", got, "| expected", expected)',
        'assert milo_failures == 0, f"{milo_failures} test case(s) failed"');
      if (tail.length) {
        lines.push(`${c} ${EDGE_INPUTS_NOTE}`, 'milo_edge_inputs = [');
        for (const t of tail) lines.push(`    ${py(t)},`);
        lines.push(']', 'for args in milo_edge_inputs:', `    print("edge", args, "->", ${fn}(*args))`);
      }
    } else {
      lines.push('milo_test_inputs = [', '    # arguments');
      for (const t of cases) lines.push(`    ${py(t)},`);
      lines.push(']', 'for args in milo_test_inputs:', `    print(args, "->", ${fn}(*args))`);
    }
  } else if (runs) {
    const typed = language === 'typescript';
    const call = typed ? `(${fn} as unknown as (...a: unknown[]) => unknown)(...args)` : `${fn}(...args)`;
    // Each block in its own scope, so a second batch's `const` does not redeclare the first's (review 1, item 4).
    const body: string[] = [];
    if (checked) {
      body.push(`const miloTestCases${typed ? ': Array<[unknown[], unknown]>' : ''} = [`, '  // [arguments, expected]');
      for (const t of cases) {
        if (t.assumption) body.push(`  // ${t.assumption}`);
        body.push(`  [[${t.args.map(scriptLiteral).join(', ')}], ${scriptLiteral(t.expected)}],`);
      }
      body.push('];', 'let miloFailures = 0;', 'for (const [args, expected] of miloTestCases) {', `  const got = ${call};`,
        '  const passed = JSON.stringify(got) === JSON.stringify(expected);',
        '  if (!passed) miloFailures += 1;',
        '  console.log(passed ? "ok  " : "DIFF", JSON.stringify(args), "->", JSON.stringify(got), "| expected", JSON.stringify(expected));',
        '}', 'if (miloFailures) throw new Error(`${miloFailures} test case(s) failed`);');
      if (tail.length) {
        body.push(`// ${EDGE_INPUTS_NOTE}`, `const miloEdgeInputs${typed ? ': unknown[][]' : ''} = [`);
        for (const t of tail) body.push(`  [${t.args.map(scriptLiteral).join(', ')}],`);
        body.push('];', 'for (const args of miloEdgeInputs) {', `  console.log("edge", JSON.stringify(args), "->", JSON.stringify(${call}));`, '}');
      }
    } else {
      body.push(`const miloTestInputs${typed ? ': unknown[][]' : ''} = [`, '  // arguments');
      for (const t of cases) body.push(`  [${t.args.map(scriptLiteral).join(', ')}],`);
      body.push('];', 'for (const args of miloTestInputs) {', `  console.log(JSON.stringify(args), "->", JSON.stringify(${call}));`, '}');
    }
    lines.push('{', ...body.map((l) => `  ${l}`), '}');
  } else {
    const name = fn ?? 'f';
    for (const t of cases) {
      if (t.assumption) lines.push(`${c} ${t.assumption}`);
      lines.push(`${c} ${name}(${t.args.map(scriptLiteral).join(', ')})${checked ? ` -> ${scriptLiteral(t.expected)}` : ''}`);
    }
    for (const t of tail) lines.push(`${c} ${name}(${t.args.map(scriptLiteral).join(', ')}) -> ? (asked for; no single right answer)`);
  }
  return `${lines.join('\n')}\n`;
}
