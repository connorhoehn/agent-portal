// All documents — the list page, composed as realtime-examples' DocumentListPage
// composes it: PageHeader with the total, Upload and New ▾; one search field
// with a filter popover; the result count with the sort; DocumentResultList
// rows. The rows come from the tree the explorer already loaded
// (GET /api/assessment/knowledge/tree), so search is over names and
// locations — the tree carries no body text to search.

import { useMemo, useState } from 'react';
import {
  Banner,
  Button,
  ChevronIcon,
  Chip,
  DocumentResultList,
  DropdownMenu,
  EmptyState,
  FilePickerButton,
  FilterChip,
  FilterPopover,
  Inline,
  PageHeader,
  PlusIcon,
  SearchInput,
  SectionLabel,
  SlidersIcon,
  Stack,
  T,
  UploadIcon,
  type DocumentResultItem,
  type DropdownMenuSection,
} from '@connorhoehnslalom/ui-components/shared';
import { CLASSIFICATION_LABEL, isFolderNode, nodePath } from './knowledgeFormat';
import type { KnowledgeSection } from './types';

type Sort = 'updated' | 'name';
const SORT_LABEL: Record<Sort, string> = { updated: 'Last changed', name: 'Name' };

interface LibraryRow extends DocumentResultItem { sectionKey: string; type: string; search: string }

export interface DocumentLibraryProps {
  sections: KnowledgeSection[];
  onSelect: (id: string) => void;
  /** Absent: this viewer may not create here, so no Upload and no New. */
  onNewPage?: () => void;
  /** Markdown and text files become drafts; resolves when the tree has them. */
  onUpload?: (files: File[]) => Promise<void>;
  uploading?: boolean;
  uploadError?: string | null;
  onDismissUploadError?: () => void;
  /** Where New and Upload put a draft — "Workspace drafts". */
  draftSectionTitle?: string;
}

export function DocumentLibrary({ sections, onSelect, onNewPage, onUpload, uploading, uploadError, onDismissUploadError, draftSectionTitle }: DocumentLibraryProps) {
  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>('updated');
  const [currentId, setCurrentId] = useState<string | null>(null);

  const rows: LibraryRow[] = useMemo(() => sections.flatMap(section => section.nodes.filter(node => !isFolderNode(node)).map(node => {
    const location = nodePath(section.nodes, node.id).slice(0, -1).map(ancestor => ancestor.title);
    const type = CLASSIFICATION_LABEL[node.classification ?? ''] ?? node.classification ?? 'Document';
    return {
      id: node.id, title: node.title, kind: 'page' as const, sectionKey: section.key, type,
      folder: [section.title, ...location].join(' / '),
      ...(node.updated_at ? { updatedAt: node.updated_at } : {}),
      search: `${node.title} ${location.join(' ')} ${section.title} ${node.id}`.toLocaleLowerCase(),
    };
  })), [sections]);
  const typeOptions = useMemo(() => [...new Set(rows.map(row => row.type))].sort(), [rows]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = rows
    .filter(row => (sources.length === 0 || sources.includes(row.sectionKey)) && (types.length === 0 || types.includes(row.type)) && row.search.includes(needle))
    .sort(sort === 'name'
      ? (a, b) => a.title.localeCompare(b.title)
      : (a, b) => (Date.parse(String(b.updatedAt ?? '')) || 0) - (Date.parse(String(a.updatedAt ?? '')) || 0));
  const activeFilters = sources.length + types.length;
  const clearFilters = () => { setSources([]); setTypes([]); };
  const toggleIn = (list: string[], value: string) => list.includes(value) ? list.filter(item => item !== value) : [...list, value];

  const newMenu: DropdownMenuSection[] = onNewPage ? [{ items: [
    { label: 'Page', description: draftSectionTitle ? `A blank draft in ${draftSectionTitle}` : 'A blank draft', onSelect: onNewPage },
  ] }] : [];
  const rowMenu = (item: DocumentResultItem): DropdownMenuSection[] => [{ items: [
    { label: 'Open', onSelect: () => onSelect(item.id) },
    { label: 'Copy link', onSelect: () => {
      const url = new URL(window.location.href); url.searchParams.set('doc', item.id); url.searchParams.delete('view');
      void navigator.clipboard?.writeText(url.toString());
    } },
  ] }];

  return <Stack gap="none" className="h-full min-h-0 min-w-0" data-testid="document-list-page">
    <Stack gap="md" className="px-6 pb-2 pt-3">
      <PageHeader title="All documents" badge={<Chip size="md" data-testid="document-list-total">{rows.length}</Chip>}
        actions={<>
          {onUpload && <FilePickerButton accept=".md,.markdown,.txt,text/markdown,text/plain" multiple icon={<UploadIcon size={18} />}
            disabled={uploading} onFiles={files => void onUpload(files)} data-testid="document-upload">
            {uploading ? 'Uploading…' : 'Upload'}
          </FilePickerButton>}
          {onNewPage && <DropdownMenu triggerVariant="primary" align="end" sections={newMenu}
            trigger={<><PlusIcon size={18} /><span>New</span><ChevronIcon size={14} dir="down" /></>}
            triggerLabel="New document" triggerTestId="new-document-btn" data-testid="new-document-menu" />}
        </>} />
      {uploadError && <Banner variant="error" onDismiss={onDismissUploadError} data-testid="document-upload-error">{uploadError}</Banner>}
      <Inline gap="sm" align="center" data-testid="document-list-controls">
        <SearchInput size="md" value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search documents"
          aria-label="Search documents" className="min-w-0 flex-1" data-testid="document-search-input" />
        <FilterPopover trigger="icon" size="md" icon={<SlidersIcon />} label="Filter documents" activeCount={activeFilters}
          onClear={clearFilters} placement="bottom-end" data-testid="document-filters">
          <Stack gap="md">
            <Stack gap="xs">
              <SectionLabel>Source</SectionLabel>
              <Inline gap="xs" wrap>
                {sections.map(section => <FilterChip key={section.key} active={sources.includes(section.key)}
                  onClick={() => setSources(value => toggleIn(value, section.key))}>{section.title}</FilterChip>)}
              </Inline>
            </Stack>
            <Stack gap="xs">
              <SectionLabel>Type</SectionLabel>
              <Inline gap="xs" wrap>
                {typeOptions.map(type => <FilterChip key={type} active={types.includes(type)}
                  onClick={() => setTypes(value => toggleIn(value, type))}>{type}</FilterChip>)}
              </Inline>
            </Stack>
          </Stack>
        </FilterPopover>
      </Inline>
      <Inline gap="xs" align="center" className="text-sm text-text-secondary" data-testid="document-list-count">
        <T aria-live="polite" data-testid="document-result-count">{`${visible.length} result${visible.length === 1 ? '' : 's'}`}</T>
        <T aria-hidden="true">·</T>
        <DropdownMenu triggerVariant="link" trigger={<><span>{SORT_LABEL[sort]}</span><ChevronIcon size={14} dir="down" /></>}
          triggerLabel={`Sort by ${SORT_LABEL[sort]}`} triggerTestId="document-sort" data-testid="document-sort-menu"
          sections={[{ items: (['updated', 'name'] as Sort[]).map(key => ({ label: SORT_LABEL[key], checked: sort === key, onSelect: () => setSort(key) })) }]} />
      </Inline>
    </Stack>
    <Stack gap="none" className="min-h-0 flex-1 overflow-auto px-6 pb-3">
      <DocumentResultList items={visible} currentId={currentId ?? visible[0]?.id ?? null} onCurrentChange={setCurrentId}
        onOpen={item => onSelect(item.id)} draggable={false} rowMenu={rowMenu} aria-label="Documents" data-testid="document-result-list"
        emptyState={<EmptyState title={rows.length === 0 ? 'No documents yet' : needle ? `Nothing matches “${query.trim()}”` : 'No documents match these filters'}
          description={rows.length === 0 ? 'Pull a source, or create a page to get started.' : 'Try other words, or clear the filters.'}
          action={rows.length === 0
            ? (onNewPage ? <Button variant="primary" onClick={onNewPage}>New page</Button> : undefined)
            : <Button variant="secondary" onClick={() => { setQuery(''); clearFilters(); }}>Clear search</Button>} />} />
    </Stack>
  </Stack>;
}

export default DocumentLibrary;
