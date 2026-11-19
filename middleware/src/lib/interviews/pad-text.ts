/**
 * The bounds on pad text that Milo's tools read (the rule for interviews/milo-tools and interviews/testcases, review 1 item 2):
 * no regular expression runs over a pad line longer than MAX_PAD_LINE (a scan sees such a line as empty), and a pad longer than
 * MAX_PAD_TEXT is not edited at all. A pad is typed by the candidate, so its text is untrusted input to every pattern here.
 */
export const MAX_PAD_LINE = 500;
export const MAX_PAD_TEXT = 100_000;

/** Is a line of pad text too long for any pattern to look at? */
export const lineTooLong = (line: string): boolean => line.length > MAX_PAD_LINE;

/** The pad text as patterns may scan it: every line over MAX_PAD_LINE emptied (the line count stays, so line numbers hold). */
export function scannable(text: string): string {
  if (text.length <= MAX_PAD_LINE) return text;
  let long = false;
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i += 1) if (lineTooLong(rows[i]!)) { rows[i] = ''; long = true; }
  return long ? rows.join('\n') : text;
}
