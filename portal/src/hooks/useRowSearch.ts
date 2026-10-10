// The list page's search, for the table rules (docs/layout-cascade.md
// "Tables"): the field sits in ONE row with the line stat strip and the
// filters, so it cannot be DataTable's own `searchable` input, which the
// library draws on a row of its own above the table. The page owns the query
// and hands DataTable the filtered rows.
import { useMemo, useState } from 'react';

/** Rows whose `text(row)` contains every whitespace-separated term of the
 *  query, case-insensitively. An empty query returns `rows` unchanged. */
export function filterRows<R>(rows: readonly R[], query: string, text: (row: R) => string): R[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...rows];
  return rows.filter((row) => {
    const hay = text(row).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export function useRowSearch<R>(rows: readonly R[], text: (row: R) => string) {
  const [query, setQuery] = useState('');
  // `text` is usually an inline arrow; the rows and the query are what change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filtered = useMemo(() => filterRows(rows, query, text), [rows, query]);
  return { query, setQuery, rows: filtered };
}
