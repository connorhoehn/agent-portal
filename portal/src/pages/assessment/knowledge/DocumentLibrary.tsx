// All documents — the list page, composed as realtime-examples' DocumentListPage
// composes it: PageHeader with the total, Upload and New ▾; one search field
// with a filter popover; the result count with the sort; DocumentResultList
// rows. The rows come from the tree the explorer already loaded
// (GET /api/assessment/knowledge/tree), so search is over names and
// locations — the tree carries no body text to search.

import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
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
import { FileCards, type FileView } from '../../../components/files/FileCards';
import { FileToolbar } from '../../../components/files/FileToolbar';
import { libraryRows, type LibraryFile } from './documentLibraryModel';
import type { KnowledgeSection } from './types';

type Sort = 'updated' | 'name';
const SORT_LABEL: Record<Sort, string> = { updated: 'Last changed', name: 'Name' };

export interface DocumentLibraryProps {
  sections: KnowledgeSection[];
  files?: readonly LibraryFile[];
  title?: string;
  /** Use h2 when this library is a tab inside a record page. */
  headingAs?: 'h1' | 'h2';
  description?: ReactNode;
  notices?: ReactNode;
  initialType?: string;
  documentHref?: (id: string) => string;
  onOpenFile?: (href: string) => void;
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
  onRefresh?: () => void;
  refreshing?: boolean;
  onOpenWorkspace?: () => void;
}

export function DocumentLibrary({ sections, files = [], title = 'All documents', headingAs = 'h1', description, notices, initialType, documentHref, onOpenFile, onSelect, onNewPage, onUpload, uploading, uploadError, onDismissUploadError, draftSectionTitle, onRefresh, refreshing, onOpenWorkspace }: DocumentLibraryProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<FileView>('list');
  const [sources, setSources] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>(initialType ? [initialType] : []);
  const [sort, setSort] = useState<Sort>('updated');
  const [currentId, setCurrentId] = useState<string | null>(null);

  const rows = useMemo(() => libraryRows(sections, files), [sections, files]);
  const sourceOptions = useMemo(() => [...new Map([
    ...sections.map(section => [section.key, section.title] as const),
    ...files.map(file => [file.sourceKey, file.sourceLabel] as const),
  ]).entries()], [sections, files]);
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
    { label: 'Open', onSelect: () => openItem(item) },
    { label: 'Copy link', onSelect: () => {
      const row = rows.find(row => row.id === item.id);
      const url = new URL(row?.href ?? documentHref?.(item.id) ?? window.location.href, window.location.origin);
      if (!row?.href && !documentHref) { url.searchParams.set('doc', item.id); url.searchParams.delete('view'); }
      void navigator.clipboard?.writeText(url.toString());
    } },
  ] }];
  const openItem = (item: DocumentResultItem) => {
    const row = rows.find(row => row.id === item.id);
    if (row?.href) { if (onOpenFile) onOpenFile(row.href); else void navigate(row.href); }
    else onSelect(item.id);
  };

  return <Stack gap="none" className="h-full min-h-0 min-w-0" data-testid="document-list-page">
    <Stack gap="md" className="px-6 pb-2 pt-3">
      <PageHeader as={headingAs} title={title} badge={<Chip size="md" data-testid="document-list-total">{rows.length}</Chip>}
        actions={<>
          {onUpload && <FilePickerButton accept=".md,.markdown,.txt,text/markdown,text/plain" multiple icon={<UploadIcon size={18} />}
            size="sm" disabled={uploading} onFiles={files => void onUpload(files)} data-testid="document-upload">
            {uploading ? 'Uploading…' : 'Upload'}
          </FilePickerButton>}
          {onNewPage && <DropdownMenu triggerVariant="primary" align="end" sections={newMenu}
            trigger={<><PlusIcon size={18} /><span>New</span><ChevronIcon size={14} dir="down" /></>}
            triggerLabel="New document" triggerTestId="new-document-btn" data-testid="new-document-menu" />}
        </>} />
      {description}
      {notices}
      {uploadError && <Banner variant="error" onDismiss={onDismissUploadError} data-testid="document-upload-error">{uploadError}</Banner>}
      <FileToolbar view={view} onViewChange={setView} onRefresh={onRefresh} refreshing={refreshing} onOpenWorkspace={onOpenWorkspace}
        label="Document file controls" testId="document-list-controls">
        <SearchInput size="sm" value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search documents and files"
          aria-label="Search documents" className="min-w-0 flex-1" data-testid="document-search-input" />
        <FilterPopover trigger="icon" size="sm" icon={<SlidersIcon />} label="Filter documents" activeCount={activeFilters}
          onClear={clearFilters} placement="bottom-end" data-testid="document-filters">
          <Stack gap="md">
            <Stack gap="xs">
              <SectionLabel>Source</SectionLabel>
              <Inline gap="xs" wrap>
                {sourceOptions.map(([key, label]) => <FilterChip key={key} active={sources.includes(key)}
                  onClick={() => setSources(value => toggleIn(value, key))}>{label}</FilterChip>)}
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
      </FileToolbar>
      <Inline gap="xs" align="center" className="text-sm text-text-secondary" data-testid="document-list-count">
        <T aria-live="polite" data-testid="document-result-count">{`${visible.length} result${visible.length === 1 ? '' : 's'}`}</T>
        <T aria-hidden="true">·</T>
        <DropdownMenu triggerVariant="link" trigger={<><span>{SORT_LABEL[sort]}</span><ChevronIcon size={14} dir="down" /></>}
          triggerLabel={`Sort by ${SORT_LABEL[sort]}`} triggerTestId="document-sort" data-testid="document-sort-menu"
          sections={[{ items: (['updated', 'name'] as Sort[]).map(key => ({ label: SORT_LABEL[key], checked: sort === key, onSelect: () => setSort(key) })) }]} />
      </Inline>
    </Stack>
    <Stack gap="none" className="min-h-0 flex-1 overflow-auto px-6 pb-3">
      {view === 'cards' && visible.length > 0 ? <FileCards
        items={visible.map(row => ({ id: row.id, title: row.title, kindLabel: row.type, detail: row.summary || row.folder }))}
        onOpen={id => { const item = visible.find(row => row.id === id); if (item) openItem(item); }}
        testId="document-result-cards" itemTestId="document-file-card" /> : <DocumentResultList items={visible} currentId={currentId ?? visible[0]?.id ?? null} onCurrentChange={setCurrentId}
        onOpen={openItem} draggable={false} rowMenu={rowMenu} aria-label="Documents" data-testid="document-result-list"
        emptyState={<EmptyState title={rows.length === 0 ? 'No documents yet' : needle ? `Nothing matches “${query.trim()}”` : 'No documents match these filters'}
          description={rows.length === 0 ? 'Pull a source, or create a page to get started.' : 'Try other words, or clear the filters.'}
          action={rows.length === 0
            ? (onNewPage ? <Button variant="primary" onClick={onNewPage}>New page</Button> : undefined)
            : <Button variant="secondary" onClick={() => { setQuery(''); clearFilters(); }}>Clear search</Button>} />} />}
    </Stack>
  </Stack>;
}

export default DocumentLibrary;
