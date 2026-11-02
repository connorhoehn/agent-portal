import type { ReactNode } from 'react';
import {
  ArrowUpIcon, DropdownMenu, FilterIcon, FolderIcon, Inline, Tooltip,
  type DropdownMenuSection,
} from '@connorhoehnslalom/ui-components/shared';
import { SEARCH_LABELS, SEARCH_TYPES, type SearchRecordType, type SearchSort } from './searchTypes';

export interface SearchControlsProps {
  scope: string;
  scopeName: string | null;
  scopeOptions: readonly { id: string; title: string }[];
  type: SearchRecordType | 'all';
  sort: SearchSort;
  onChange(values: Record<string, string | null>): void;
}

function controls({ scope, scopeName, scopeOptions, type, sort, onChange }: SearchControlsProps): Array<{
  label: string; value: string; icon: ReactNode; testId: string; active: boolean; sections: DropdownMenuSection[];
}> {
  return [
    { label: 'Search scope', value: scopeName ?? 'Entire workspace', icon: <FolderIcon size={16} />, testId: 'search-scope', active: !!scope,
      sections: [{ label: 'Search scope', scroll: true, items: scopeOptions.map(option => ({
        label: option.id ? option.title : 'Search entire workspace', active: option.id === scope,
        onSelect: () => onChange({ scope: option.id || null, offset: null }),
      })) }] },
    { label: 'Record type filter', value: type === 'all' ? 'All types' : SEARCH_LABELS[type], icon: <FilterIcon size={16} />, testId: 'search-type', active: type !== 'all',
      sections: [{ label: 'Record type', items: (['all', ...SEARCH_TYPES] as Array<SearchRecordType | 'all'>).map(kind => ({
        label: kind === 'all' ? 'Any type' : SEARCH_LABELS[kind], active: kind === type,
        onSelect: () => onChange({ type: kind, offset: null }),
      })) }] },
    { label: 'Sort results', value: sort === 'recent' ? 'Recent' : 'Relevance', icon: <ArrowUpIcon size={16} />, testId: 'search-sort', active: sort === 'recent',
      sections: [{ items: [
        { label: 'Relevance', active: sort === 'relevance', onSelect: () => onChange({ sort: null, offset: null }) },
        { label: 'Recent', active: sort === 'recent', onSelect: () => onChange({ sort: 'recent', offset: null }) },
      ] }] },
  ];
}

/** Native menus keep each selected value discoverable on hover and focus. */
export function SearchControls(props: SearchControlsProps) {
  return <Inline gap="xs" align="center" wrap={false} role="group" aria-label="Search controls" data-testid="search-chips"
    className="shrink-0 rounded-lg border border-border bg-surface-panel p-0.5">
    {controls(props).map(control => <Tooltip key={control.testId} content={`${control.label === 'Record type filter' ? 'Record type' : control.label}: ${control.value}`} placement="bottom">
      <DropdownMenu align="end" triggerVariant="default" triggerLabel={control.label} triggerTestId={control.testId}
        triggerClassName={`h-8 w-8 justify-center border-transparent p-0 text-xs ${control.active ? 'bg-primary-soft text-primary' : 'text-text-secondary'}`}
        trigger={control.icon} sections={control.sections} />
    </Tooltip>)}
  </Inline>;
}

/** The same choices move into the native header menu when space is limited. */
export function searchControlsMenu(props: SearchControlsProps): DropdownMenuSection[] {
  return [{ label: 'Search controls', items: controls(props).map(control => ({
    label: control.label, description: control.value, icon: control.icon, submenu: control.sections,
  })) }];
}
