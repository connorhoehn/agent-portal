import { currentCallPage, canonicalCallPageHref, readCallChatPageReference, type CallChatPageReference, type CallPageDescriptor } from './callPages.ts';

/** The workspace chooser accepts only canonical OrgIQ resource destinations. */
export function orgiqReferenceReturnHref(value: string | null): string | undefined {
  if (!value || !/^\/iq\/projects\/[^/?#]+(?:[?#]|$)/.test(value) || /[\\\u0000-\u001f]/.test(value)) return undefined;
  const url = new URL(value, 'https://local.invalid');
  const page = currentCallPage(url.pathname, url.search);
  if (!page) return undefined;
  const projectId = decodeURIComponent(url.pathname.slice('/iq/projects/'.length));
  return page ? canonicalCallPageHref(page, projectId) : undefined;
}

export function readDmPageDescriptor(value: unknown): CallPageDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['kind', 'id'].includes(key))
    || !['initiative', 'work-item'].includes(String(row.kind))
    || typeof row.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(row.id)) return null;
  return { kind: row.kind as CallPageDescriptor['kind'], id: row.id };
}
export interface DmReferenceScope { identity: string; channel: string; messageId: string; page: CallPageDescriptor }
export interface DmReferenceState { key: string; reference: CallChatPageReference | null; loading: boolean; error: boolean }
export type DmReferenceReader = (scope: DmReferenceScope, signal: AbortSignal) => Promise<CallChatPageReference>;
export const dmReferenceKey = (scope: DmReferenceScope | null) => scope
  ? JSON.stringify([scope.identity, scope.channel, scope.messageId, scope.page.kind, scope.page.id]) : '';
export function createDmReferenceReader(request: typeof fetch = (...args) => fetch(...args)): DmReferenceReader {
  return async (scope, signal) => {
    const query = new URLSearchParams({ channel: scope.channel, messageId: scope.messageId });
    const response = await request(`/api/social/dms/page-reference?${query}`, { credentials: 'include', cache: 'no-store', signal });
    const value = await response.json().catch(() => null);
    const reference = readCallChatPageReference(value?.pageReference);
    if (!response.ok || value?.channel !== scope.channel || value?.messageId !== scope.messageId
      || reference?.kind !== scope.page.kind || reference.id !== scope.page.id) throw new Error('Page reference unavailable');
    return reference;
  };
}
/** Clear resolved metadata during refresh; late reads cannot restore another identity/message. */
export class DmReferenceSession {
  private scope: DmReferenceScope | null = null;
  private generation = 0;
  private abort = new AbortController();
  private listeners = new Set<() => void>();
  private state: DmReferenceState = { key: '', reference: null, loading: false, error: false };
  private readonly read: DmReferenceReader;
  constructor(read: DmReferenceReader) { this.read = read; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<DmReferenceState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  setScope(scope: DmReferenceScope | null) {
    const key = dmReferenceKey(scope); if (key === this.state.key) return;
    this.abort.abort(); this.abort = new AbortController(); this.generation++; this.scope = scope;
    this.publish({ key, reference: null, loading: false, error: false });
  }
  async refresh(): Promise<CallChatPageReference | null> {
    if (!this.scope) return null;
    this.abort.abort(); this.abort = new AbortController();
    const generation = ++this.generation, scope = this.scope;
    this.publish({ loading: true, reference: null, error: false });
    try {
      const reference = await this.read(scope, this.abort.signal);
      if (generation !== this.generation) return null;
      this.publish({ reference }); return reference;
    } catch {
      if (generation === this.generation) this.publish({ reference: null, error: true });
      return null;
    } finally { if (generation === this.generation) this.publish({ loading: false }); }
  }
}
