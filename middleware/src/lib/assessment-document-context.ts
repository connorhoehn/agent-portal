// Canonical document call identity is the original source ID, never a reversed
// hash or a mapped canvas UUID. Keep the hash identical to knowledgeFormat.ts.

export const isDocumentSourceId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);

export function assessmentDocumentLobby(sourceId: string): string {
  const plain = `assessment:doc:${sourceId}`;
  if (plain.length <= 50 && /^[A-Za-z0-9:_-]+$/.test(plain)) return plain;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < sourceId.length; i += 1) {
    const ch = sourceId.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `assessment:doc:h:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/** An untrusted navigation hint until compared with the accepted call's own
 * immutable channel and a fresh source read. No arbitrary host or URL path. */
export function assessmentSourceFromCallChannel(channel: unknown): string | null {
  if (typeof channel !== 'string' || !channel.startsWith('assessment-document:')) return null;
  const href = channel.slice('assessment-document:'.length);
  if (!/^\/assessment\/(workspace|enterprise|rules|prompts)\?/.test(href) || /[\s\u0000-\u001f\u007f]/.test(href)) return null;
  try {
    const url = new URL(href, 'https://document.invalid');
    if (url.origin !== 'https://document.invalid' || url.hash || url.searchParams.getAll('doc').length !== 1
      || [...url.searchParams.keys()].some(key => key !== 'doc')) return null;
    const sourceId = url.searchParams.get('doc');
    return isDocumentSourceId(sourceId) ? sourceId : null;
  } catch { return null; }
}

export async function readAssessmentDocument(sourceId: string, lobbyName: string): Promise<{ title: string } | null> {
  if (!isDocumentSourceId(sourceId) || assessmentDocumentLobby(sourceId) !== lobbyName) return null;
  const { getKnowledgeDoc } = await import('../providers/assessment.js');
  const doc = await getKnowledgeDoc(sourceId);
  return doc?.id === sourceId ? { title: doc.title } : null;
}

/** Navigation is derived from the current source tree. A hidden, deleted,
 * unsupported or ambiguously placed source has no recording destination. */
export async function assessmentDocumentRecordingHost(sourceId: string, lobbyName: string): Promise<{ title: string; href: string } | null> {
  const doc = await readAssessmentDocument(sourceId, lobbyName);
  if (!doc) return null;
  const { getKnowledgeTree } = await import('../providers/assessment.js');
  const { sections } = await getKnowledgeTree();
  const owners = sections.filter(section => section.nodes.some(node => node.id === sourceId && !node.is_dir && node.viewable !== false));
  if (owners.length !== 1) return null;
  const section = owners[0]!;
  const mode = section.kind === 'synced' || section.key === 'workspace_drafts' ? 'workspace'
    : ({ enterprise_context: 'enterprise', rules: 'rules', prompts: 'prompts' } as Record<string, string>)[section.key];
  return mode ? { title: doc.title, href: `/assessment/${mode}?doc=${encodeURIComponent(sourceId)}` } : null;
}
