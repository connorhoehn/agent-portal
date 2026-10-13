import type { ReactNode } from 'react';
import { CatalogGrid, DocumentIcon, Inline, ListIcon, SegmentedControl, SelectableCard, SplitViewIcon, Stack, T } from '@connorhoehnslalom/ui-components/shared';

export type FileView = 'cards' | 'list';

/** Presentation only: each tenant retains its own readers, filters and destinations. */
export function FileViewToggle({ value, onChange }: { value: FileView; onChange(view: FileView): void }) {
  return <SegmentedControl tone="accent" iconOnly aria-label="File view"
    value={value} onChange={next => onChange(next as FileView)}
    options={[{ value: 'cards', label: 'Cards', icon: <SplitViewIcon /> }, { value: 'list', label: 'List', icon: <ListIcon /> }]} />;
}

export interface FileCardItem {
  id: string;
  title: string;
  kindLabel: string;
  detail?: ReactNode;
}

export function FileCards({ items, onOpen, testId, itemTestId }: {
  items: readonly FileCardItem[];
  onOpen(id: string): void;
  testId?: string;
  itemTestId?: string;
}) {
  // CatalogGrid (dense, 12px gap) owns the grid; `.file-card-grid` keeps the
  // bounded auto-fill tracks (15–20rem) that the fixed column counts lack.
  return <CatalogGrid dense className="file-card-grid" {...(testId ? { 'data-testid': testId } : {})}>
    {items.map(item => <SelectableCard key={item.id} padding="md" aria-pressed={undefined} className="file-card" onSelect={() => onOpen(item.id)} data-testid={itemTestId}>
      <Inline gap="sm" align="start" wrap={false} className="min-w-0 w-full">
        <DocumentIcon size={20} className="shrink-0 text-primary" />
        <Stack gap="xs" className="min-w-0 text-left">
          <T size="xs" tone="secondary" className="uppercase">{item.kindLabel}</T>
          <T size="sm" weight="semibold" wrap className="line-clamp-2 break-words">{item.title}</T>
          {item.detail && <T size="xs" tone="secondary" wrap className="font-normal line-clamp-2 break-words">{item.detail}</T>}
        </Stack>
      </Inline>
    </SelectableCard>)}
  </CatalogGrid>;
}
