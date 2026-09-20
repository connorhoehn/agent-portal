import { useState } from 'react';
import { Button, DataTable, DetailHeader, Input, Select, Stack, T, Toolbar, ToolbarGroup } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../../lib/relativeTime';
import { CLASSIFICATION_LABEL, nodePath } from './knowledgeFormat';
import type { KnowledgeNode, KnowledgeSection } from './types';

interface LibraryRow extends KnowledgeNode {
  source: string;
  sectionKey: string;
  location: string;
  type: string;
}

/** Search is limited to metadata actually loaded from the document library. */
export function DocumentLibrary({ sections, onSelect }: {
  sections: KnowledgeSection[];
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [type, setType] = useState('');
  const rows: LibraryRow[] = sections.flatMap((section) => section.nodes.filter((node) => !node.is_dir).map((node) => ({
    ...node,
    source: section.title,
    sectionKey: section.key,
    location: nodePath(section.nodes, node.id).slice(0, -1).map((ancestor) => ancestor.title).join(' / '),
    type: CLASSIFICATION_LABEL[node.classification ?? ''] ?? node.classification ?? 'Document',
  })));
  const needle = query.trim().toLocaleLowerCase();
  const filtered = rows.filter((row) => (!source || row.sectionKey === source) && (!type || row.type === type)
    && `${row.title} ${row.location} ${row.source} ${row.id}`.toLocaleLowerCase().includes(needle));
  const active = !!(query || source || type);
  return <Stack gap="md">
    <DetailHeader title="Document library" description="Browse documents by name, location, source and type." />
    <Toolbar aria-label="Filter document library" wrap end={active
      ? <Button variant="ghost" size="sm" onClick={() => { setQuery(''); setSource(''); setType(''); }}>Clear filters</Button>
      : undefined}>
      <ToolbarGroup>
        <Input aria-label="Search document metadata" placeholder="Search names and locations…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </ToolbarGroup>
      <ToolbarGroup>
        <Select aria-label="Filter by document source" value={source} onChange={(event) => setSource(event.target.value)}
          options={[{ value: '', label: 'All sources' }, ...sections.map((section) => ({ value: section.key, label: section.title }))]} />
        <Select aria-label="Filter by document type" value={type} onChange={(event) => setType(event.target.value)}
          options={[{ value: '', label: 'All types' }, ...Array.from(new Set(rows.map((row) => row.type))).sort().map((label) => ({ value: label, label }))]} />
      </ToolbarGroup>
    </Toolbar>
    <T role="status" className="text-xs text-text-secondary">{`${filtered.length} of ${rows.length} documents`}</T>
    <DataTable<LibraryRow> data={filtered} keyField={(row) => row.id} pageSize={20}
      emptyMessage={active ? 'No documents match these filters. Clear filters to browse the library.' : 'No documents in this library yet.'}
      columns={[
        { key: 'title', header: 'Name', sortable: true, render: (row) => <Stack gap="xs">
          <Button variant="ghost" size="sm" className="border-0 px-0 justify-start text-left whitespace-normal" onClick={() => onSelect(row.id)}>{row.title}</Button>
          {row.location && <T className="text-xs text-text-tertiary">{row.location}</T>}
        </Stack> },
        { key: 'source', header: 'Source', sortable: true },
        { key: 'type', header: 'Type', sortable: true },
        { key: 'updated_at', header: 'Updated', sortable: true,
          compare: (a, b) => (Date.parse(a.updated_at ?? '') || 0) - (Date.parse(b.updated_at ?? '') || 0),
          render: (row) => row.updated_at ? relativeTime(row.updated_at) : '—' },
      ]} />
  </Stack>;
}
