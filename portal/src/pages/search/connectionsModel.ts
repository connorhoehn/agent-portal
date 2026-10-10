// Which graph the Connections tab draws (goal decision 8), and the pure
// narrowing behind each one. No React; unit-tested alone.
//
// A people selection is the ORG graph around those people — the behaviour
// the old /iq/explore?focus=<id> had. The RECORD graph is drawn only when
// recorded edges touch the selection, and it only ever shows the selection
// plus the records an edge connects to it: never unconnected filler.

import type { SearchEdge, SearchRecord, SearchRecordType } from './searchTypes.ts';

export type ConnectionsView = 'org' | 'records' | 'empty';

const PERSON = 'person:';
const keyOf = (record: Pick<SearchRecord, 'type' | 'id'>) => `${record.type}:${record.id}`;

/** The edges whose two ends are both present, restricted to those touching the
 *  selection (any present edge when nothing is selected). */
function focusedEdges(records: SearchRecord[], edges: SearchEdge[], selectedKeys: string[]): SearchEdge[] {
  const present = new Set(records.map(keyOf));
  const focus = new Set(selectedKeys);
  return edges.filter(edge => present.has(edge.source) && present.has(edge.target) && edge.source !== edge.target
    && (!focus.size || focus.has(edge.source) || focus.has(edge.target)));
}

export function connectionsView({ type, selectedKeys, query, edges, records }: {
  type: SearchRecordType | 'all';
  selectedKeys: string[];
  query: string;
  edges: SearchEdge[];
  records: SearchRecord[];
}): ConnectionsView {
  if (type === 'person') return 'org';
  if (selectedKeys.length && !query.trim() && selectedKeys.every(key => key.startsWith(PERSON))) return 'org';
  return focusedEdges(records, edges, selectedKeys).length ? 'records' : 'empty';
}

/** The selection and the records an edge connects to it — nothing else. With
 *  no selection, every record that has at least one edge. Selected records
 *  keep their place first so the canvas centres on them. */
export function focusedRecords(records: SearchRecord[], edges: SearchEdge[], selectedKeys: string[]): SearchRecord[] {
  const keep = new Set(focusedEdges(records, edges, selectedKeys).flatMap(edge => [edge.source, edge.target]));
  const focus = new Set(selectedKeys);
  for (const key of focus) keep.add(key);
  const present = records.filter(record => keep.has(keyOf(record)));
  return [...present.filter(r => focus.has(keyOf(r))), ...present.filter(r => !focus.has(keyOf(r)))];
}

/** The edges drawn with `focusedRecords` — both ends on the canvas. */
export function focusedRecordEdges(records: SearchRecord[], edges: SearchEdge[], selectedKeys: string[]): SearchEdge[] {
  const shown = new Set(focusedRecords(records, edges, selectedKeys).map(keyOf));
  return edges.filter(edge => shown.has(edge.source) && shown.has(edge.target));
}

/** `person:p-014` → `p-014`; non-person keys are dropped. */
export function orgFocusIds(selectedKeys: string[]): string[] {
  return [...new Set(selectedKeys.filter(key => key.startsWith(PERSON)).map(key => key.slice(PERSON.length)).filter(Boolean))];
}

/** The old Explore narrowing: the focused people plus their direct neighbours
 *  over every relationship (strength filters apply afterwards, on the narrowed
 *  set), and only the relationships among them. No focus → unchanged. */
export function focusOrgPeople<P extends { id: string }, E extends { source: string; target: string }>(
  people: P[], relationships: E[], focusIds: Iterable<string>,
): { people: P[]; relationships: E[] } {
  const focus = new Set(focusIds);
  if (!focus.size) return { people, relationships };
  const keep = new Set(focus);
  for (const edge of relationships) {
    if (focus.has(edge.source)) keep.add(edge.target);
    if (focus.has(edge.target)) keep.add(edge.source);
  }
  return {
    people: people.filter(person => keep.has(person.id)),
    relationships: relationships.filter(edge => keep.has(edge.source) && keep.has(edge.target)),
  };
}

/**
 * RecordGraph clamps a node's name to two lines and its subtitle to one
 * 124px line, and titles the node with `description ?? title` — so hovering a
 * long knowledge record showed its summary and never its name (orgiq
 * program-owner #24), and a person's cut-off role was nowhere. The node's
 * tooltip is the one place the page can put them: name, then subtitle, then
 * the summary.
 */
export function withNameTooltips<R extends { title: string; subtitle?: string; description?: string }>(records: R[]): R[] {
  return records.map(record => {
    const head = [record.title, record.subtitle].filter(Boolean).join('\n');
    const tooltip = record.description && record.description !== record.title ? `${head}\n\n${record.description}` : head;
    return tooltip === (record.description ?? record.title) ? record : { ...record, description: tooltip };
  });
}
