// One place that counts things in words. A template like `${n} errors` reads
// "1 errors" the day n is one (walk, 9 November: "1 errors" on the
// observability summary), and the copies of a local `plural` that grew in
// several modules disagreed on whether the number came with the word.

/** The noun for `n`: `one` when n is exactly 1, `many` (default `one + 's'`) otherwise. */
export function pluralWord(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** The count and its noun: `plural(1, 'error')` → "1 error", `plural(3, 'error')` → "3 errors", `plural(2, 'person', 'people')` → "2 people". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${pluralWord(n, one, many)}`;
}

/** "3 of 12 requests", "1 of 1 request": the noun agrees with the total. */
export function ofTotal(shown: number, total: number, one: string, many = `${one}s`): string {
  return `${shown.toLocaleString('en-US')} of ${plural(total, one, many)}`;
}
