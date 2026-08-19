// One way to say "this did not load".
//
// 41 of the 66 portal files that fetch never read the error from their
// request, so a failed load renders as zeros and empty lists — which reads
// exactly like a healthy, idle system. Fixing that file by file produced four
// slightly different wordings in an afternoon, so this is the shared shape:
// what failed, why it probably failed, and the way to retry.
//
// The `source` prop matters more than it looks. "Could not load" tells someone
// nothing they can act on; "Cost history lives in Aurora" tells them to go
// look at the database rather than at the cost page.

import { Card } from '@connorhoehnslalom/ui-components/shared';

interface Props {
  /** The error text from useFetch. Rendered verbatim — it names the status. */
  error: string;
  /** What could not be loaded, as a noun phrase: "the cost history". */
  what: string;
  /** Where the data comes from, so the reader knows where to look. */
  source?: string;
  onRetry?: () => void;
  className?: string;
}

export function UnavailableNotice({ error, what, source, onRetry, className }: Props) {
  return (
    <Card padding="md" className={`border-danger/40 ${className ?? ''}`}>
      <div className="text-[13px] font-semibold text-danger">Could not load {what}</div>
      <div className="text-[12px] text-text-secondary mt-1 leading-snug">
        {error}
        {source ? `. ${source}, so this is unknown rather than empty.` : '.'}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 px-3 py-1.5 rounded-md border border-border bg-surface text-[12px] font-semibold text-text-secondary cursor-pointer hover:text-primary hover:border-primary/50 transition-colors"
        >
          Try again
        </button>
      )}
    </Card>
  );
}

/**
 * Render a number that might be unknown.
 *
 * An em dash, not a zero. The whole point is that "0 errors" and "we could not
 * find out how many errors" must not look the same.
 */
export function orUnknown(value: number | string | null | undefined, failed: boolean): string {
  if (failed) return '—';
  if (value === null || value === undefined) return '—';
  return typeof value === 'number' ? value.toLocaleString() : value;
}
