// The loading/error/dispatch triple every KB action button repeated.
//
// Each of Sync, Provision and Delete carried its own `useState(false)` +
// `useState<string|null>` + try/catch, and they disagreed about whether to
// clear `loading` on success: Sync always did, Provision and Delete
// deliberately did not (they navigate away, so clearing it would flash the
// idle label over a page that is leaving). `settleOnSuccess` makes that a
// stated choice instead of an accident.

import { useCallback, useState } from 'react';
import { writeJson } from './writeJson';

export interface KbAction {
  /** True from dispatch until the request settles. Disables the control. */
  loading: boolean;
  /** Backend `{ error }` text, or null. */
  error: string | null;
  run: () => void;
}

export function useKbAction(
  url: string,
  method: string,
  onDone: () => void,
  opts: { settleOnSuccess?: boolean } = {},
): KbAction {
  const { settleOnSuccess = true } = opts;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    void writeJson(url, method).then((res) => {
      if (!res.ok) {
        setError(res.error);
        setLoading(false);
        return;
      }
      if (settleOnSuccess) setLoading(false);
      onDone();
    });
  }, [url, method, onDone, settleOnSuccess]);

  return { loading, error, run };
}
