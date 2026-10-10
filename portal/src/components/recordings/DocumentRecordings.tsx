import { useSearchParams } from 'react-router';
import { PageRecordings } from './PageRecordings';
import { conversationChannelForDoc } from '../../pages/assessment/knowledge/knowledgeFormat';
import { documentCallLobby } from '../../pages/assessment/knowledge/documentCommentsModel';

/** The source ID stays explicit: a hashed conversation suffix is never decoded. */
export function DocumentRecordings({ sourceId, title }: { sourceId: string; title: string }) {
  const [params, setParams] = useSearchParams();
  const lobby = documentCallLobby('assessment:', conversationChannelForDoc(sourceId));
  return <PageRecordings lobby={lobby} subjectName={title} documentSourceId={sourceId} onOpen={id => {
    const next = new URLSearchParams(params);
    next.set('doc', sourceId); next.set('tab', 'recordings'); next.delete('view'); next.delete('proposal');
    if (id) next.set('recording', id); else next.delete('recording');
    setParams(next);
  }} />;
}
