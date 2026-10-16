// A collection page whose rows are the records a tenant's fixed-fact answer cites
// (docs/user-search-goal.md S4) narrows its table to them while the answer is
// showing: the person sees the fact and the rows it was read from. Only the
// intents the page lists apply; any other answer leaves the table alone.
import { useCallback, useMemo, useState } from 'react';
import type { TenantAnswerFact } from '../../lib/tenantAnswer';

export function useAnswerScope(intents: readonly string[]) {
  const [answer, setAnswer] = useState<TenantAnswerFact | null>(null);
  const showAnswer = useCallback((next: TenantAnswerFact | null) => {
    setAnswer(next && intents.includes(next.intent) ? next : null);
    // `intents` is a module constant at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** `type:id` keys of the cited records, or null while no answer scopes the table. */
  const keys = useMemo(() => (answer ? new Set(answer.records.map((r) => `${r.type}:${r.id}`)) : null), [answer]);
  return { answer, keys, showAnswer };
}
