// The loading/error/dispatch triple every KB action button repeated.
//
// Each of Sync, Provision and Delete carried its own `useState(false)` +
// `useState<string|null>` + try/catch, and they disagreed about whether to
// clear `loading` on success: Sync always did, Provision and Delete
// deliberately did not (they navigate away, so clearing it would flash the
// idle label over a page that is leaving). `settleOnSuccess` makes that a
// stated choice instead of an accident.

import { useCallback, useState } from 'react';
import { writeJson } from '../../../lib/writeJson';

export interface KbAction {
  /** True from dispatch until the request settles. Disables the control. */
  loading: boolean;
  /** Backend `{ error }` text, or null. */
  error: string | null;
  /**
   * The refusal was "already running", not "broken" — see
   * `writeJson`'s `conflict`. A caller that ignores this renders a working
   * pipeline as a red alert, which is the exact reading this pass is undoing.
   * `onDone` fires for a conflict too: the refusal means a job IS in flight, so
   * refreshing is the useful response.
   */
  conflict: boolean;
  run: () => void;
}

export function useKbAction(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  onDone: () => void,
  opts: { settleOnSuccess?: boolean } = {},
): KbAction {
  const { settleOnSuccess = true } = opts;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    setConflict(false);
    void writeJson(url, method).then((res) => {
      if (!res.ok) {
        setError(res.error);
        setConflict(res.conflict);
        setLoading(false);
        // A conflict means the work is under way, so the list beside the button
        // has something new to show — the same reason the Ingest and Knowledge
        // surfaces refresh on it.
        if (res.conflict) onDone();
        return;
      }
      if (settleOnSuccess) setLoading(false);
      onDone();
    });
  }, [url, method, onDone, settleOnSuccess]);

  return { loading, error, conflict, run };
}
