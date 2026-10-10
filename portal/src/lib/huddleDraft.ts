interface Draft { html: string; files: readonly unknown[] }
/** A receipt belongs to the submitted draft, never to a newer edit. */
export function settleHuddleDraft<T extends Draft>(current: T, submitted: T, confirmed: boolean, empty: T): T {
  if (confirmed) return current === submitted ? empty : current;
  return !current.html && current.files.length === 0 ? submitted : current;
}
