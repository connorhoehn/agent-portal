import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Banner, Button, Inline, LoadingState, T } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { deckPaths, type DeckSummary } from '../decks/decksApi';
import { DocumentLibrary } from '../knowledge/DocumentLibrary';
import { presentationFiles, workspaceDocumentHref } from '../knowledge/documentLibraryModel';
import { sectionsForMode } from '../knowledge/knowledgeFormat';
import type { KnowledgeTreeResponse } from '../knowledge/types';

/** Native team-scoped presentations plus explicitly shared Workspace documents. */
export function TeamFiles({ teamId, teamName }: { teamId: string; teamName: string }) {
  const navigate = useNavigate();
  const decks = useFetch<DeckSummary[]>(deckPaths.list(teamId));
  const tree = useFetch<KnowledgeTreeResponse>('/api/assessment/knowledge/tree');
  const files = useMemo(() => presentationFiles(decks.data ?? [], { id: teamId, name: teamName }), [decks.data, teamId, teamName]);
  const sections = useMemo(() => sectionsForMode(tree.data?.sections ?? [], 'workspace'), [tree.data]);
  const notices = <>
    {(decks.isLoading || tree.isLoading) && <LoadingState label="Loading documents and files…" />}
    {decks.error && <Banner variant="error">Presentations are unavailable: {decks.error} <Button size="sm" variant="link" onClick={decks.refresh}>Retry presentations</Button></Banner>}
    {tree.error && <Banner variant="error">Workspace documents are unavailable: {tree.error} <Button size="sm" variant="link" onClick={tree.refresh}>Retry documents</Button></Banner>}
  </>;
  return <DocumentLibrary sections={sections} files={files} title="Documents & files"
    description={<Inline gap="sm" align="center" wrap><T size="sm" tone="secondary">Presentations for {teamName} and shared Workspace documents.</T>
      <Button variant="link" size="sm" onClick={() => void navigate('/assessment/workspace?view=library')}>Browse Workspace</Button></Inline>}
    notices={notices} documentHref={workspaceDocumentHref} onSelect={id => void navigate(workspaceDocumentHref(id))} />;
}
