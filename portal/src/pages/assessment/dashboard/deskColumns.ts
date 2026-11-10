// The assessor's desk's column priorities (UX leftovers, 10 November).
//
// The desk has ten columns and needs about 80rem to show them all; the content
// column is 74.5rem at a 1440 window and 64.5rem at 1280. 242429fe made 1440 fit
// by removing information (the open-claims chip, the "Contributors" header and
// two avatars, the year). Instead, columns now give way in priority order as the
// table's own width shrinks (a container query; DataTable `narrow` makes the table
// a size container), lowest first:
//   Step          the record's stepper says it, and Next action says what moves it
//   Motion        the toolbar filters by it
//   Lead          the record's header names them
//   Contributors, Updated, Assessed   only on a narrow tablet-sized table
// Team, Certification with its open claims, Questions and Next action always show.
// Under 40rem the row is a stacked card with every field, so nothing hides there.
// Measured with the mock roster: all ten need 1286px; without Step 1184 (fits
// 1440's 1192); without Motion and Lead too, 921 (fits 1280's 1032).
//
// The library DataTable has no column-priority prop (noted as a library gap);
// these are Tailwind container-query classes on the column, which DataTable puts
// on the header and the cells. Literal strings, so the Tailwind scanner sees them.
// No React: node --test runs it.

export type DeskColumn = 'workflow_step' | 'cohort' | 'lead' | 'contributors' | 'updated_at' | 'dimensions_assessed';

/** Below this table width (rem) the column gives way: only above the 40rem card form. */
export const DESK_COLUMN_MIN_REM: Readonly<Record<DeskColumn, number>> = {
  workflow_step: 81, cohort: 74, lead: 66, contributors: 58, updated_at: 50, dimensions_assessed: 45,
};

const HIDE: Readonly<Record<DeskColumn, string>> = {
  workflow_step: '@min-[40rem]:@max-[81rem]:hidden',
  cohort: '@min-[40rem]:@max-[74rem]:hidden',
  lead: '@min-[40rem]:@max-[66rem]:hidden',
  contributors: '@min-[40rem]:@max-[58rem]:hidden',
  updated_at: '@min-[40rem]:@max-[50rem]:hidden',
  dimensions_assessed: '@min-[40rem]:@max-[45rem]:hidden',
};

/** The column's hiding classes. */
export function deskColumnHide(column: DeskColumn): string {
  return HIDE[column];
}

/** Which priority columns show at a table width in rem: all of them in the card form, else those whose floor it clears. */
export function deskColumnsShown(widthRem: number): DeskColumn[] {
  return (Object.keys(DESK_COLUMN_MIN_REM) as DeskColumn[]).filter((c) => widthRem < 40 || widthRem >= DESK_COLUMN_MIN_REM[c]);
}

/** The class map and the floors agree (a test checks it, so the two cannot drift). */
export function deskHideFloor(column: DeskColumn): number | null {
  const m = /@max-\[(\d+(?:\.\d+)?)rem\]/.exec(HIDE[column]);
  return m ? Number(m[1]) : null;
}
