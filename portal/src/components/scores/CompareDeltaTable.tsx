import { Inline, Stack, Table, TableBody, TableHead, TableRow, TableTd, TableTh } from '@connorhoehnslalom/ui-components/shared';
import { RadarBatchEntry, RadarAxes } from './OverlayRadar';

const AXIS_ORDER: Array<{ key: keyof RadarAxes; label: string }> = [
  { key: 'influence', label: 'Influence' },
  { key: 'expertise', label: 'Expertise' },
  { key: 'collaborationBreadth', label: 'Breadth' },
  { key: 'decisionImpact', label: 'Decisions' },
  { key: 'crossTeamReach', label: 'Cross-team' },
  { key: 'recency', label: 'Recency' },
];

const FALLBACK_COLORS = ['#6366f1', '#16a34a', '#d97706', '#dc2626'];

interface CompareDeltaTableProps {
  entries: RadarBatchEntry[];
}

export function CompareDeltaTable({ entries }: CompareDeltaTableProps) {
  if (entries.length === 0) return null;

  const colorFor = (index: number): string =>
    FALLBACK_COLORS[index % FALLBACK_COLORS.length] ?? '#6366f1';

  return (
    <Stack gap="none" className="overflow-x-auto">
      <Table>
        <TableHead>
          <TableRow>
            <TableTh align="left" className="min-w-[100px]">Axis</TableTh>
            {entries.map((e, i) => (
              // The per-series colour is data — it identifies which person a
              // column belongs to and matches that series in the radar beside
              // it — so it stays a style. Everything else the table used to
              // paint by hand (padding, borders, weights) is the library's.
              <TableTh key={e.personId} align="right" className="min-w-[80px]">
                <Inline as="span" gap="none" style={{ color: colorFor(i) }}>{e.name}</Inline>
              </TableTh>
            ))}
            <TableTh align="right" className="min-w-[70px]">&#916; (max-min)</TableTh>
          </TableRow>
        </TableHead>
        <TableBody>
          {AXIS_ORDER.map(({ key, label }) => {
            const values = entries.map(e => e.person[key]);
            const maxVal = Math.max(...values);
            const minVal = Math.min(...values);
            const delta = maxVal - minVal;

            return (
              <TableRow key={key}>
                <TableTd>{label}</TableTd>
                {entries.map((e, i) => {
                  const val = e.person[key];
                  const isMax = val === maxVal && delta > 0;
                  const isMin = val === minVal && delta > 0;
                  return (
                    <TableTd
                      key={e.personId}
                      align="right"
                      className={isMax ? 'font-bold' : isMin ? 'text-text-tertiary' : ''}
                    >
                      {/* The leader in a row is tinted with its own series
                          colour, which is the only reason this cell carries a
                          style at all. */}
                      {isMax ? <Inline as="span" gap="none" style={{ color: colorFor(i) }}>{Math.round(val)}</Inline> : Math.round(val)}
                    </TableTd>
                  );
                })}
                <TableTd align="right" className="text-[11px] text-text-tertiary">
                  {Math.round(delta)}
                </TableTd>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Stack>
  );
}
