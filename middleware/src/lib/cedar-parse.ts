// Cedar source parsing helpers, dependency-free so tests can import them
// without dragging in AVP clients or import.meta-based path resolution.

/**
 * Split a Cedar file into individual policy statements. AVP's CreatePolicy
 * only accepts one statement (permit/forbid) per call.
 *
 * The scope `(...)` and every trailing `when`/`unless` clause `{...}` are
 * walked with a depth counter, so nested braces inside conditions (record
 * literals, `{ "a": 1 }.has(...)`) parse correctly — a flat regex here
 * silently truncated any condition containing `}`.
 */
export function splitStatements(cedar: string): string[] {
  const noComments = cedar.replace(/\/\/[^\n]*/g, '');
  const statements: string[] = [];
  let remaining = noComments;
  while (remaining.length > 0) {
    const m = remaining.match(/\b(permit|forbid)\s*\(/);
    if (!m || m.index === undefined) break;
    remaining = remaining.slice(m.index);

    // Walk the scope parens.
    let depth = 0;
    let i = 0;
    for (; i < remaining.length; i++) {
      if (remaining[i] === '(') depth++;
      else if (remaining[i] === ')') { depth--; if (depth === 0) { i++; break; } }
    }

    // Walk any number of `when { ... }` / `unless { ... }` clauses with a
    // brace-depth counter (braces may nest inside the condition).
    for (;;) {
      const clause = remaining.slice(i).match(/^\s*(when|unless)\s*\{/);
      if (!clause) break;
      let j = i + clause[0].length;
      let braces = 1;
      for (; j < remaining.length && braces > 0; j++) {
        if (remaining[j] === '{') braces++;
        else if (remaining[j] === '}') braces--;
      }
      i = j;
    }
    // Consume a trailing semicolon if present.
    const semi = remaining.slice(i).match(/^\s*;/);
    if (semi) i += semi[0].length;

    const trimmed = remaining.slice(0, i).trim().replace(/;?\s*$/, ';');
    if (trimmed.length > 1) statements.push(trimmed);
    remaining = remaining.slice(i);
  }
  return statements;
}
