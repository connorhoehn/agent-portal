import type { DocumentResultItem } from '@connorhoehnslalom/ui-components/shared';
import type { DeckSummary } from '../decks/decksApi.ts';
import type { KnowledgeNode, KnowledgeSection } from './types.ts';
import { CLASSIFICATION_LABEL, isFolderNode, nodePath } from './knowledgeFormat.ts';

/** Files keep their native destination; presentations are never knowledge-doc ids. */
export interface LibraryFile extends DocumentResultItem {
  href: string;
  sourceKey: string;
  sourceLabel: string;
  type: string;
}
export interface LibraryRow extends DocumentResultItem {
  sectionKey: string;
  type: string;
  search: string;
  href?: string;
}

export function presentationFiles(decks: readonly DeckSummary[], team?: { id: string; name: string }): LibraryFile[] {
  return decks.filter(deck => !team || deck.teamId === team.id).map(deck => ({
    id: `presentation:${deck.id}`, title: deck.title, kind: 'presentation', type: 'Presentation',
    sourceKey: 'presentations', sourceLabel: 'Presentations',
    folder: `Presentations / ${team?.name ?? deck.teamId}`,
    summary: deck.latestRevision ? `PowerPoint · ${deck.latestRevision.label}` : 'No saved version yet',
    updatedAt: deck.updatedAt,
    href: `/assessment/decks/${encodeURIComponent(deck.id)}`,
  }));
}

export function libraryRows(sections: readonly KnowledgeSection[], files: readonly LibraryFile[] = []): LibraryRow[] {
  const documents: LibraryRow[] = sections.flatMap(section => section.nodes.filter(node => !isFolderNode(node)).map(node => {
    const location = nodePath(section.nodes, node.id).slice(0, -1).map(ancestor => ancestor.title);
    return {
      id: node.id, title: node.title, kind: 'page', sectionKey: section.key,
      type: CLASSIFICATION_LABEL[node.classification ?? ''] ?? node.classification ?? 'Document',
      folder: [section.title, ...location].join(' / '),
      ...(node.updated_at ? { updatedAt: node.updated_at } : {}),
      search: `${node.title} ${location.join(' ')} ${section.title} ${node.id}`.toLocaleLowerCase(),
    };
  }));
  return [...documents, ...files.map(file => ({ ...file, sectionKey: file.sourceKey,
    search: `${file.title} ${file.folder ?? ''} ${file.summary ?? ''} ${file.id}`.toLocaleLowerCase() }))];
}

export function workspaceDocumentHref(id: string): string {
  return `/assessment/workspace?doc=${encodeURIComponent(id)}`;
}

/** Keep the nearest meaningful parent and document; the rail carries the full hierarchy. */
export function compactDocumentPath(nodes: readonly KnowledgeNode[]): KnowledgeNode[] {
  return nodes.slice(-2);
}
