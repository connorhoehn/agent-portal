import { conversationChannelForDoc } from '../../pages/assessment/knowledge/knowledgeFormat.ts';
import { documentCallLobby, hrefFromCallChannel } from '../../pages/assessment/knowledge/documentCommentsModel.ts';

export interface DocumentRecordingNavigation { documentSourceId: string; href: string }
/** Navigation only. Native participant and current source readers still decide access. */
export function documentRecordingNavigation(lobby: string, channel: string | null | undefined): DocumentRecordingNavigation | null {
  const href = hrefFromCallChannel(channel);
  if (!href || !lobby.startsWith('assessment:doc:')) return null;
  try {
    const url = new URL(href, 'https://local.invalid');
    if (!/^\/assessment\/(workspace|enterprise|rules|prompts)$/.test(url.pathname) || url.hash || url.searchParams.getAll('doc').length !== 1
      || [...url.searchParams.keys()].some(key => key !== 'doc')) return null;
    const sourceId = url.searchParams.get('doc');
    if (!sourceId || sourceId.length > 1024 || /[\x00-\x1f\x7f]/.test(sourceId)) return null;
    if (documentCallLobby('assessment:', conversationChannelForDoc(sourceId)) !== lobby) return null;
    return { documentSourceId: sourceId, href: `${url.pathname}?${new URLSearchParams({ doc: sourceId })}` };
  } catch { return null; }
}
export function documentRecordingHref(lobby: string, navigation: DocumentRecordingNavigation, recordingId?: string): string | null {
  const canonical = documentRecordingNavigation(lobby, `assessment-document:${navigation.href}`);
  if (!canonical || canonical.documentSourceId !== navigation.documentSourceId) return null;
  const url = new URL(canonical.href, 'https://local.invalid');
  url.searchParams.set('tab', 'recordings');
  if (recordingId) url.searchParams.set('recording', recordingId);
  return `${url.pathname}?${url.searchParams}`;
}
