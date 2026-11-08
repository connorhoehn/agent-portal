import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Banner, Button, LoadingState, Stack, T } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { deckPaths, type DeckSummary } from '../decks/decksApi';
import { DocumentLibrary } from '../knowledge/DocumentLibrary';
import { presentationFiles, workspaceDocumentHref } from '../knowledge/documentLibraryModel';
import { sectionsForMode } from '../knowledge/knowledgeFormat';
import type { KnowledgeTreeResponse } from '../knowledge/types';
import { PageRecordings } from '../../../components/recordings/PageRecordings';

/** Native team-scoped presentations plus explicitly shared Workspace documents. */
export function TeamFiles({ teamId, teamName }: { teamId: string; teamName: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const decks = useFetch<DeckSummary[]>(deckPaths.list(teamId));
  const tree = useFetch<KnowledgeTreeResponse>('/api/assessment/knowledge/tree');
  const files = useMemo(() => presentationFiles(decks.data ?? [], { id: teamId, name: teamName }), [decks.data, teamId, teamName]);
  const sections = useMemo(() => sectionsForMode(tree.data?.sections ?? [], 'workspace'), [tree.data]);
  const notices = <>
    {(decks.isLoading || tree.isLoading) && <LoadingState label="Loading documents and files…" />}
    {decks.error && <Banner variant="error">Presentations are unavailable: {decks.error} <Button size="sm" variant="link" onClick={decks.refresh}>Retry presentations</Button></Banner>}
    {tree.error && <Banner variant="error">Workspace documents are unavailable: {tree.error} <Button size="sm" variant="link" onClick={tree.refresh}>Retry documents</Button></Banner>}
  </>;
  const recordings = <PageRecordings lobby={`assessment:team:${teamId}`} subjectName={teamName} onOpen={id => {
    const next = new URLSearchParams(params); next.set('tab', 'documents'); if (id) next.set('recording', id); else next.delete('recording'); setParams(next);
  }} />;
  if (Boolean(params.get('recording'))) return <Stack gap="sm" className="min-h-0 overflow-y-auto p-4">{recordings}</Stack>;
  return <Stack gap="md" className="min-h-0 overflow-y-auto"><DocumentLibrary headingAs="h2" sections={sections} files={files} title="Documents & files"
    description={<T size="sm" tone="secondary">Presentations for {teamName} and shared Workspace documents.</T>}
    onRefresh={() => { decks.refresh(); tree.refresh(); }} refreshing={decks.isLoading || tree.isLoading}
    onOpenWorkspace={() => void navigate('/assessment/workspace?view=library')}
    notices={notices} documentHref={workspaceDocumentHref} onSelect={id => void navigate(workspaceDocumentHref(id))} />
    <Stack gap="none" className="px-4 pb-4">{recordings}</Stack></Stack>;
}
