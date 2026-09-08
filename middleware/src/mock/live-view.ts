// A live view onto a fixture's rows.
//
// WHY THIS EXISTS. `defineFixture` hands back a NEW array on the first read
// after every `reset()` (mock/core/fixture.ts clears its materialization map),
// which is exactly what makes `POST /api/__mock/reset` total. The cost is that
// a module which captured `fixture.rows()` once — or, worse, a module-level
// `export const MOCK_THING = [...]` that a dozen callers imported — is stale the
// moment the world is reset: it keeps handing out the pre-reset array while the
// provider reads the post-reset one. Two answers, one table, which is the whole
// class of bug this floor exists to end.
//
// Several providers publish their mock rows under such a name and are read
// across module boundaries (providers/projects.ts reads `MOCK_BUDGETS`,
// providers/agent-jobs.ts reads `MOCK_BOTS`/`MOCK_BOT_RUNS`). Those names are a
// real API. `liveArrayView` keeps the name and the array shape while making
// every read resolve through the fixture, so a reset reaches those callers too
// without any of them having to know a fixture exists.
//
// HOW. The proxy's target IS a real array (and a real object, for the record
// view), re-synced from the fixture immediately before each trap runs. Reporting
// on a target we have just made truthful means every proxy invariant is
// satisfied by construction — no hand-rolled `ownKeys`/`getOwnPropertyDescriptor`
// arithmetic that a future array shape could violate.
//
// A view is a READ path. It hands back the fixture's own row objects, so
// mutating a row through it (`MOCK_BOTS.find(...)!.enabled = false`) mutates the
// fixture and is undone by reset — which is the point. Mutating the *view
// itself* (`push`, `splice`, index assignment) is not: the next sync discards
// it. Push to `fixture.rows()` instead.

/** The rows a view resolves to, read afresh on every access. */
export type RowsReader<Row> = () => readonly Row[];

/**
 * An array-shaped live view. `.length`, indexing, iteration, spread,
 * `Object.keys` and every `Array.prototype` method resolve against the
 * fixture's current rows.
 */
export function liveArrayView<Row>(read: RowsReader<Row>): Row[] {
  const target: Row[] = [];
  const sync = (): Row[] => {
    const rows = read();
    target.length = 0;
    for (const row of rows) target.push(row);
    return target;
  };
  return new Proxy(target, {
    get(_t, prop, receiver) { return Reflect.get(sync(), prop, receiver); },
    has(_t, prop) { return Reflect.has(sync(), prop); },
    ownKeys() { return Reflect.ownKeys(sync()); },
    getOwnPropertyDescriptor(_t, prop) { return Reflect.getOwnPropertyDescriptor(sync(), prop); },
  });
}

/**
 * A record-shaped live view, for a fixture whose rows one caller reads grouped
 * (`MOCK_BOT_RUNS[botId]`). The grouping is a SELECTOR over the flat rows, never
 * a second stored copy of them — the flat array stays the one source of truth,
 * which is what lets `bot_runs` be one table here as it is in Aurora.
 */
export function liveRecordView<Value>(read: () => Record<string, Value>): Record<string, Value> {
  const target: Record<string, Value> = {};
  const sync = (): Record<string, Value> => {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, read());
    return target;
  };
  return new Proxy(target, {
    get(_t, prop, receiver) { return Reflect.get(sync(), prop, receiver); },
    has(_t, prop) { return Reflect.has(sync(), prop); },
    ownKeys() { return Reflect.ownKeys(sync()); },
    getOwnPropertyDescriptor(_t, prop) { return Reflect.getOwnPropertyDescriptor(sync(), prop); },
  });
}
