// The assessor's desk's column priorities (UX leftovers, 10 November).
//
// The desk has ten columns and needs about 80rem to show them all; the content
// column is 74.5rem at a 1440 window and 64.5rem at 1280. Rather than remove
// information, columns give way in priority order as the table's own width
// shrinks. Since ui-components 2.516.0 that is DataTable's own
// `responsiveColumns` with `columns[].priority` (the highest number hides
// first, measured against the table's real content, so a column hides only
// when the rest would otherwise scroll sideways); each row's "+N columns"
// popover lists the hidden values. The order, first to hide:
//   Step          the record's stepper says it, and Next action says what moves it
//   Motion        the toolbar filters by it
//   Lead          the record's header names them
//   Contributors, Updated, Assessed   only on a narrow tablet-sized table
// Team, Certification with its open claims, Questions and Next action never
// hide (priority 1). Under 40rem the row is DataTable's stacked card with
// every field. These replace b603dc48's container-query classes.
// No React: node --test runs it.

export type DeskColumn = 'workflow_step' | 'cohort' | 'lead' | 'contributors' | 'updated_at' | 'dimensions_assessed';

/** DataTable `priority` per giving-way column: the highest hides first. Every other column is 1 (never hides). */
export const DESK_COLUMN_PRIORITY: Readonly<Record<DeskColumn, number>> = {
  workflow_step: 7, cohort: 6, lead: 5, contributors: 4, updated_at: 3, dimensions_assessed: 2,
};

/** The column's DataTable priority. */
export function deskColumnPriority(column: DeskColumn): number {
  return DESK_COLUMN_PRIORITY[column];
}

/** The order the columns give way in, first to last. */
export function deskHideOrder(): DeskColumn[] {
  return (Object.entries(DESK_COLUMN_PRIORITY) as Array<[DeskColumn, number]>).sort((a, b) => b[1] - a[1]).map(([c]) => c);
}
