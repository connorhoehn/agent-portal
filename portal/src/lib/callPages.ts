/** A call's shared page is a server-owned pin, independent of the current route. */
export interface CallPageDescriptor {
  kind: 'initiative' | 'work-item';
  id: string;
}

export interface SharedCallPage extends CallPageDescriptor {
  key?: string;
  title: string;
  href: string;
  project: { id: string; title: string; href: string };
  breadcrumbs: { title: string; href: string }[];
  presenter: { userId: string; displayName: string };
  sharedAt: string;
}

export interface CallPageSnapshot {
  type: 'call-page';
  callId: string;
  revision: number;
  page: SharedCallPage | null;
}

export interface CallPageScope { callId: string; tenant: string; actorId: string; identityKey?: string }

export function callPageScopeKey(scope: CallPageScope | null): string {
  return scope ? JSON.stringify([scope.tenant, scope.actorId, scope.callId, scope.identityKey ?? null]) : '';
}

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,256}$/.test(value);
}

/** Selection/list filters and the work item's inner tab are never part of a pin. */
export function currentCallPage(pathname: string, search = ''): CallPageDescriptor | null {
  const match = /^\/iq\/projects\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let projectId: string;
  try { projectId = decodeURIComponent(match[1]!); } catch { return null; }
  if (!id(projectId)) return null;
  const params = new URLSearchParams(search);
  const itemId = params.get('item');
  const tab = params.get('tab');
  const explicitTab = ['overview', 'work', 'decisions', 'agents', 'contributors'].includes(tab ?? '') ? tab : null;
  if (itemId && (explicitTab === null || explicitTab === 'work')) {
    return id(itemId) ? { kind: 'work-item', id: itemId } : null;
  }
  return { kind: 'initiative', id: projectId };
}

export function canonicalCallPageHref(page: CallPageDescriptor, projectId: string): string {
  const project = `/iq/projects/${encodeURIComponent(projectId)}`;
  return page.kind === 'initiative' ? project : `${project}?tab=work&item=${encodeURIComponent(page.id)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A page reference in a chat message, resolved by the BFF for this reader (huddle chat, Social DMs). */
export type CallChatPageReference =
  | (CallPageDescriptor & { status: 'available'; title: string; href: string;
      key?: string;
      project: { id: string; title: string; href: string }; breadcrumbs: { title: string; href: string }[] })
  | (CallPageDescriptor & { status: 'unavailable' });

/** References arrive resolved by the BFF; never derive a title or accept a client URL. */
export function readCallChatPageReference(value: unknown): CallChatPageReference | null {
  if (!record(value) || (value.kind !== 'initiative' && value.kind !== 'work-item') || !id(value.id)) return null;
  const descriptor: CallPageDescriptor = { kind: value.kind, id: value.id };
  if (value.status === 'unavailable') return { ...descriptor, status: 'unavailable' };
  if (value.status !== 'available' || !text(value.title) || !record(value.project)
    || !id(value.project.id) || !text(value.project.title) || !Array.isArray(value.breadcrumbs)) return null;
  if (value.kind === 'initiative' && value.id !== value.project.id) return null;
  const href = canonicalCallPageHref(descriptor, value.project.id);
  const projectHref = canonicalCallPageHref({ kind: 'initiative', id: value.project.id }, value.project.id);
  if (value.href !== href || value.project.href !== projectHref
    || !value.breadcrumbs.every(crumb => record(crumb) && text(crumb.title)
      && [href, projectHref, '/iq/projects'].includes(String(crumb.href)))) return null;
  return { ...descriptor, status: 'available', title: value.title, href,
    ...(typeof value.key === 'string' && value.key.length <= 128 && /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-[1-9]\d*$/.test(value.key) ? { key: value.key } : {}),
    project: { id: value.project.id, title: value.project.title, href: projectHref },
    breadcrumbs: value.breadcrumbs.map(crumb => ({ title: String(crumb.title), href: String(crumb.href) })) };
}

function internalHref(value: unknown): value is string {
  return typeof value === 'string' && /^\/iq\/projects(?:$|[/?])/.test(value) && !/[\\\u0000-\u001f]/.test(value);
}

/** Treat socket and HTTP payloads alike; only canonical in-app links reach Open. */
export function readCallPageSnapshot(value: unknown): CallPageSnapshot | null {
  if (!record(value) || value.type !== 'call-page' || !text(value.callId)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return null;
  if (value.page === null) return value as unknown as CallPageSnapshot;
  const page = value.page;
  if (!record(page) || (page.kind !== 'initiative' && page.kind !== 'work-item') || !id(page.id)
    || !text(page.title) || !record(page.project) || !id(page.project.id) || !text(page.project.title)
    || !record(page.presenter) || !text(page.presenter.userId) || !text(page.presenter.displayName)
    || !text(page.sharedAt) || !Number.isFinite(Date.parse(page.sharedAt)) || !Array.isArray(page.breadcrumbs)
    || !page.breadcrumbs.every(crumb => record(crumb) && text(crumb.title) && internalHref(crumb.href))) return null;
  if (page.kind === 'initiative' && page.id !== page.project.id) return null;
  const descriptor: CallPageDescriptor = { kind: page.kind, id: page.id };
  if (page.href !== canonicalCallPageHref(descriptor, page.project.id)
    || page.project.href !== canonicalCallPageHref({ kind: 'initiative', id: page.project.id }, page.project.id)) return null;
  return value as unknown as CallPageSnapshot;
}

/** A clear carries a higher revision and a null page; an old GET cannot restore it. */
export function reconcileCallPage(current: CallPageSnapshot | null, incoming: unknown, callId: string): CallPageSnapshot | null {
  const next = readCallPageSnapshot(incoming);
  if (!next || next.callId !== callId || (current?.callId === callId && next.revision <= current.revision)) return current;
  return next;
}

export function canStopSharingCallPage(page: SharedCallPage | null, userId: string | null, callerId: string | null): boolean {
  return !!page && !!userId && (page.presenter.userId === userId || callerId === userId);
}

export class CallPageRequestError extends Error {
  readonly status: number;
  readonly snapshot: CallPageSnapshot | null;
  constructor(status: number, message: string, snapshot: CallPageSnapshot | null = null) {
    super(message);
    this.name = 'CallPageRequestError';
    this.status = status;
    this.snapshot = snapshot;
  }
}

export interface CallPageClient {
  read(callId: string, signal?: AbortSignal): Promise<CallPageSnapshot>;
  write(callId: string, expectedRevision: number, page: CallPageDescriptor | null, signal?: AbortSignal): Promise<CallPageSnapshot>;
}

export function createCallPageClient(request: typeof fetch = fetch): CallPageClient {
  async function send(callId: string, method: 'GET' | 'PUT' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<CallPageSnapshot> {
    const response = await request(`/api/calls/${encodeURIComponent(callId)}/page`, {
      method, credentials: 'include', signal,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = record(json) && text(json.error) ? json.error : `Shared page request failed (${response.status})`;
      throw new CallPageRequestError(response.status, message, record(json) ? readCallPageSnapshot(json.snapshot) : null);
    }
    const snapshot = readCallPageSnapshot(json);
    if (!snapshot || snapshot.callId !== callId) throw new CallPageRequestError(502, 'The shared page response was invalid');
    return snapshot;
  }
  return {
    read: (callId, signal) => send(callId, 'GET', undefined, signal),
    write: (callId, expectedRevision, page, signal) => send(callId, page ? 'PUT' : 'DELETE', {
      expectedRevision, ...(page ? { page: { kind: page.kind, id: page.id } } : {}),
    }, signal),
  };
}

export interface CallPageState {
  scopeKey: string;
  snapshot: CallPageSnapshot | null;
  loaded: boolean;
  refreshing: boolean;
  pending: boolean;
  error: string | null;
}

const emptyState = (scopeKey = ''): CallPageState => ({ scopeKey, snapshot: null, loaded: false, refreshing: false, pending: false, error: null });

/** Async reads/writes are fenced by identity + call, and reconcile by server revision. */
export class CallPageSession {
  private scope: CallPageScope | null = null;
  private state = emptyState();
  private generation = 0;
  private readGeneration = 0;
  private dataGeneration = 0;
  private writeGeneration = 0;
  private abort = new AbortController();
  private listeners = new Set<() => void>();
  private readonly client: CallPageClient;
  private readonly registrationRetryDelays: readonly number[];
  constructor(client: CallPageClient, registrationRetryDelays: readonly number[] = [250, 750]) {
    this.client = client;
    this.registrationRetryDelays = registrationRetryDelays;
  }
  getSnapshot = (): CallPageState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<CallPageState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  setScope(scope: CallPageScope | null): void {
    const scopeKey = callPageScopeKey(scope);
    if (scopeKey === this.state.scopeKey) return;
    this.abort.abort();
    this.abort = new AbortController();
    this.generation++;
    this.readGeneration++;
    this.dataGeneration++;
    this.scope = scope;
    this.state = emptyState(scopeKey);
    this.listeners.forEach(listener => listener());
  }
  receive = (incoming: unknown): void => {
    if (!this.scope) return;
    const snapshot = reconcileCallPage(this.state.snapshot, incoming, this.scope.callId);
    if (snapshot === this.state.snapshot) return;
    this.dataGeneration++;
    this.update({ snapshot, loaded: true });
  };
  async refresh({ retryRegistration = false }: { retryRegistration?: boolean } = {}): Promise<void> {
    if (!this.scope) return;
    const { callId } = this.scope;
    const generation = this.generation;
    const read = ++this.readGeneration;
    const data = this.dataGeneration;
    const write = this.writeGeneration;
    const signal = this.abort.signal;
    this.update({ refreshing: true });
    try {
      let snapshot: CallPageSnapshot;
      for (let attempt = 0; ; attempt++) {
        try { snapshot = await this.client.read(callId, signal); break; }
        catch (error) {
          const delay = this.registrationRetryDelays[attempt];
          if (!retryRegistration || this.state.loaded || delay === undefined || !(error instanceof CallPageRequestError)
            || (error.status !== 403 && error.status !== 404)) throw error;
          if (generation !== this.generation || read !== this.readGeneration) return;
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, delay);
            signal.addEventListener('abort', finish, { once: true });
          });
          if (generation !== this.generation || read !== this.readGeneration) return;
        }
      }
      if (generation !== this.generation || read !== this.readGeneration) return;
      const unchanged = data === this.dataGeneration;
      this.receive(snapshot);
      this.update({ loaded: true, ...(unchanged && write === this.writeGeneration ? { error: null } : {}) });
    } catch (error) {
      if (generation !== this.generation || read !== this.readGeneration || data !== this.dataGeneration || write !== this.writeGeneration) return;
      this.update({ error: error instanceof Error ? error.message : 'Could not load the shared page' });
    } finally {
      if (generation === this.generation && read === this.readGeneration) this.update({ refreshing: false });
    }
  }
  async share(page: CallPageDescriptor | null): Promise<void> {
    if (!this.scope || this.state.pending || !this.state.loaded) return;
    const { callId } = this.scope;
    const generation = this.generation;
    const revision = this.state.snapshot?.revision ?? 0;
    this.writeGeneration++;
    this.update({ pending: true, error: null });
    try {
      const snapshot = await this.client.write(callId, revision, page, this.abort.signal);
      if (generation !== this.generation) return;
      this.receive(snapshot);
      this.update({ error: null });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof CallPageRequestError && error.status === 409 && error.snapshot) this.receive(error.snapshot);
      this.update({ error: error instanceof Error ? error.message : 'Could not save the shared page' });
    } finally {
      if (generation === this.generation) this.update({ pending: false });
    }
  }
}

/**
 * The reference names the page the call itself is about (an initiative's huddle carrying that
 * initiative): the conversation already says so, so its card is not drawn on every message.
 */
export function isCallContextReference(reference: CallPageDescriptor | null | undefined, lobbyName: string | null | undefined): boolean {
  return !!reference && !!lobbyName && reference.kind === 'initiative' && lobbyName === `orgiq:initiative:${reference.id}`;
}

