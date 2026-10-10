// GroupedList still owns focus, keyboard navigation, disclosure and activation.
import { GroupedList, SegmentedControl, T, type GroupedListRow } from '@connorhoehnslalom/ui-components/shared';
import type { Dimension } from '../types';
import { DimensionRailSubline } from './DimensionRow';
import { dimensionRailGroup, dimensionRailGroups, dimensionRailTitle } from './scorecardHeaderModel';
import './DimensionRail.css';

export function DimensionRailControls({ dimensions, onlyClaims, onChange }: {
  dimensions: Dimension[]; onlyClaims: boolean; onChange: (value: boolean) => void;
}) {
  const claims = dimensions.filter(dimension => dimensionRailGroup(dimension) === 'claims').length;
  return <SegmentedControl size="sm" fullWidth tone="accent" aria-label="Filter dimensions"
    value={onlyClaims ? 'claims' : 'all'} onChange={value => onChange(value === 'claims')}
    options={[{ value: 'all', label: `All ${dimensions.length}` }, { value: 'claims', label: `Open claims ${claims}` }]}
    data-testid="dimension-rail-filter" />;
}

export function DimensionRailList({ dimensions, allDimensions, selectedId, onSelect }: {
  dimensions: Dimension[]; allDimensions: Dimension[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const rows: GroupedListRow[] = dimensions.map(dimension => {
    const index = allDimensions.findIndex(value => value.id === dimension.id);
    return {
      id: dimension.id, groupId: dimensionRailGroup(dimension), title: dimension.title,
      ariaLabel: dimensionRailTitle(index, dimension.title),
      icon: <T as="span" size="xs" tone="secondary" className="dimension-rail-number">{String(index + 1).padStart(2, '0')}</T>,
      subline: <DimensionRailSubline dimension={dimension} />,
    };
  });
  return <GroupedList groups={dimensionRailGroups(dimensions)} rows={rows} currentId={selectedId}
    currentStyle="bar" groupCountAlign="end" groupCountStyle="plain" rowStyle="plain"
    onOpenRow={row => onSelect(row.id)} className="assessment-dimension-list" data-testid="dimension-rail" />;
}
