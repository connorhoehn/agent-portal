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
//
// TWO WAYS TO BE BLIND, ONE TREATMENT. There is a second failure that looks
// identical from the reader's seat: the request SUCCEEDS and the server hands
// back a well-formed empty answer it does not itself believe, marked
// `degraded: true` with the first line of the query error. `useFetch` unwraps
// that into `degraded` (see lib/degraded.ts) and it renders here, in the same
// block, because to a person "we could not fetch it" and "we fetched a number
// we could not compute" are one fact: this page is not a reading of the world.
// What must NOT share a treatment is the honest empty — a page with no notice
// and its ordinary empty state is saying "there is genuinely nothing here",
// and that distinction is the entire point of the marker.

import { Card, Button } from '@connorhoehnslalom/ui-components/shared';

interface Props {
  /**
   * The error text. Either `useFetch`'s transport `error` or its `degraded`
   * line — rendered verbatim, because both name the actual failure.
   */
  error: string;
  /** What could not be loaded, as a noun phrase: "the cost history". */
  what: string;
  /** Where the data comes from, so the reader knows where to look. */
  source?: string;
  onRetry?: () => void;
  className?: string;
  'data-testid'?: string;
}

export function UnavailableNotice({
  error, what, source, onRetry, className, 'data-testid': testId,
}: Props) {
  return (
    <Card
      padding="md"
      className={`border-danger/40 ${className ?? ''}`}
      data-testid={testId ?? 'unavailable-notice'}
      role="alert"
    >
      <div className="text-[13px] font-semibold text-danger">Could not load {what}</div>
      <div className="text-[12px] text-text-secondary mt-1 leading-snug">
        {/* Server error lines sometimes end in a period of their own
            ("…request is invalid."), and appending ours produced "invalid.. Score
            history lives in Aurora". Trim one before joining. */}
        {error.replace(/\.\s*$/, '')}
        {source ? `. ${source}, so this is unknown rather than empty.` : '.'}
      </div>
      {onRetry && (
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
        </div>
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
