import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { usePublishPageOffers } from '../../lib/voice/pageContext';
import { NEW_FILE_DENIED_HINT, holdsSocialRole, newFileChoices, newFileOffers, newFileTrigger, readCanWrite, recordingsMode, recordingsNote, showNewFileHint } from './initiativeFilesModel';
import { Button, ChevronIcon, DocumentIcon, DropdownMenu, Inline, InlineAlert, LoadingState, PlusIcon, SearchInput, Select, Stack, T, type DropdownMenuSection } from '@connorhoehn/ui-components/shared';
import { FileCards, type FileView } from '../../components/files/FileCards';
import { FileToolbar } from '../../components/files/FileToolbar';
import { useSession } from '../../lib/auth';
import { usePageSwitchOffer } from '../../lib/usePageSwitchOffer';
import { createWorkspaceDocument, documentRecordHref, readWorkDocuments, readWorkspaceDocuments } from '../../lib/workDocuments';
import { useCapabilities } from '../../lib/capabilities';
import { toastError } from '../../lib/toastStore';
import { relativeTime } from '../../lib/relativeTime';
import { InitiativeStatusDecks } from './decks/InitiativeStatusDecks';
import { absoluteTime, durationLabel } from '../../lib/relativeTime';
import { documentKind, workspaceDocuments } from './initiativePaneModel';
import { initiativeDeckPaths, type InitiativeDeckSummary } from './decks/initiativeDecksApi';
import { createInitiativeRecordingsClient, readInitiativeRecordings, type RecordingPage } from './initiativeRecordingApi';
import { RECORDING_CHANGED_EVENT } from '../../components/recordings/recordingEvents';
import { useRecordingRead } from '../../components/recordings/useRecordingRead';
import { recordingIsProcessing, recordingProcessingLabel } from '../../components/recordings/recordingState';

type FileRow = { id: string; title: string; kind: 'document' | 'presentation' | 'recording'; detail: string; href?: string; recordingId?: string };
type Read = { files: FileRow[]; recordings: RecordingPage | null; pending: boolean; failures: string[]; canWritePages: boolean };

/** Project files use each native source's existing reader authority. No global
 * workspace search or guessed project association is used to populate this list. */
export function InitiativeFiles(props: { projectId: string; projectName: string; itemIds: string[] | null; workspaceHref: string; onOpenRecording(id: string | null): void }) {
  const { session } = useSession();
  const identity = JSON.stringify([session?.sub, session?.tenant, session?.role, session?.masquerading]);
  return <Files key={`${identity}:${props.projectId}`} {...props} />;
}
function Files({ projectId, projectName, itemIds, workspaceHref, onOpenRecording }: Parameters<typeof InitiativeFiles>[0]) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // New › Document / Whiteboard / Presentation (the user, 2026-11-02: create a
  // doc here the way a meeting chat does). G56: a page or a whiteboard is the
  // initiative's own people's to write (owner, contributor or an org-wide role;
  // the list read's `canWrite` is the route's answer), a presentation spends
  // (DispatchAgentRun). Each choice shows only to whoever may; the routes refuse
  // regardless (initiativeFilesModel.ts).
  const { can, ready: capabilitiesReady } = useCapabilities();
  const { session, setRole } = useSession();
  const [creating, setCreating] = useState(false);
  const [newDeck, setNewDeck] = useState(false);
  // No title dialog: the page is created as "Untitled page" and opens at once,
  // where its title and body are written (as a meeting chat's /create does).
  const newDocument = async (kind: 'page' | 'whiteboard') => {
    if (creating) return;
    setCreating(true);
    try { const doc = await createWorkspaceDocument(projectId, { title: kind === 'whiteboard' ? 'Untitled whiteboard' : 'Untitled page', kind }); navigate(doc.href); }
    catch (cause) { toastError(null, kind === 'whiteboard' ? 'Could not create the whiteboard' : 'Could not create the document', cause instanceof Error ? cause.message : 'Try again.'); }
    finally { setCreating(false); }
  };
  const [view, setView] = useState<FileView>('cards');
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [read, setRead] = useState<Read>({ files: [], recordings: null, pending: true, failures: [], canWritePages: false });
  const choices = newFileChoices({ capabilitiesReady, canWritePages: read.canWritePages, canDispatch: can('DispatchAgentRun') });
  const mayDeck = choices.includes('presentation');
  // G58: the pages read answered "not yours to write" for the role this session acts as, but it holds a
  // higher grant here (org-leader, admin) it is not acting as: offer the switch rather than a silent lock
  // (once per page for the demo identity, whose every role is switchable: lib/usePageSwitchOffer.ts).
  const switchTo = usePageSwitchOffer(session, 'add files', !read.pending && !read.canWritePages && !read.failures.includes('Pages'));
  const newMenu: DropdownMenuSection[] = [{ items: [
    ...(choices.includes('document') ? [{ label: 'Document', description: 'A page written in this initiative; opens so you can write it', onSelect: () => void newDocument('page') }] : []),
    ...(choices.includes('whiteboard') ? [{ label: 'Whiteboard', description: 'A canvas drawn in this initiative; opens so you can sketch it', onSelect: () => void newDocument('whiteboard') }] : []),
    ...(mayDeck ? [{ label: 'Presentation', description: 'A status deck built from this initiative', onSelect: () => setNewDeck(true) }] : []),
  ] }];
  // G55: the voice is told the choices this persona sees, and the call that makes each, for the initiative in view.
  usePublishPageOffers(choices.length ? { path: pathname, what: 'New file', offers: newFileOffers(choices) } : null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const client = useMemo(() => createInitiativeRecordingsClient(), []);
  const itemKey = itemIds?.join(',') ?? null;
  const lobby = `orgiq:initiative:${projectId}`;
  // Recordings live in the Social workspace: without ViewSocial (here, or through a held Social role) there
  // is no read, only an info line.
  const recordingsState = recordingsMode({ capabilitiesReady, canViewSocial: can('ViewSocial') || holdsSocialRole(session?.grants) });
  const recordingRead = useRecordingRead(recordingsState === 'read' ? `${lobby}:${refresh}` : null, signal => readInitiativeRecordings(client, lobby, signal), page => page.items.some(recordingIsProcessing) ? 5000 : null);
  const recordingRows = (page: RecordingPage): FileRow[] => page.items.map(row => ({ id: `recording:${row.recordingId}`, recordingId: row.recordingId,
    title: `${projectName} huddle`, kind: 'recording', detail: `${recordingProcessingLabel(row)} · ${absoluteTime(row.startedAt)} · ${durationLabel(row.durationMs ?? 0)} · ${row.participantCount ?? row.participants?.length ?? 0} ${(row.participantCount ?? row.participants?.length ?? 0) === 1 ? 'person' : 'people'}` }));
  useEffect(() => {
    const update = (event: Event) => { if ((event as CustomEvent<{ lobby?: string }>).detail?.lobby === lobby) recordingRead.refresh(); };
    window.addEventListener(RECORDING_CHANGED_EVENT, update);
    return () => window.removeEventListener(RECORDING_CHANGED_EVENT, update);
  }, [lobby, recordingRead.refresh]);
  useEffect(() => {
    const abort = new AbortController();
    setRead({ files: [], recordings: null, pending: true, failures: [], canWritePages: false }); setOlderError(null); setOlderBusy(false);
    const get = async (url: string) => { const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: abort.signal }); if (!response.ok) throw new Error('Unavailable'); return response.json(); };
    const docs = async (): Promise<{ files: FileRow[]; partial: boolean }> => {
      if (itemKey === null) throw new Error('Work documents are still unavailable');
      const ids = itemKey ? itemKey.split(',') : [];
      const results = await Promise.allSettled(ids.map(async id => readWorkDocuments(await get(`/api/graph/work-items/${encodeURIComponent(id)}/documents`), id)));
      const lists = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      return { partial: results.some(result => result.status === 'rejected'), files: workspaceDocuments(lists).map(doc => ({ id: `document:${doc.id}`, title: doc.title ?? doc.id, kind: 'document', detail: documentKind(doc).label, href: documentRecordHref(doc.id) })) };
    };
    // Pages written here (New › Document), newest edit first; they open on their own page. The same read
    // answers whether this persona writes pages here (G56 `canWrite`).
    const pages = async (): Promise<{ rows: FileRow[]; canWrite: boolean }> => {
      const body: unknown = await get(`/api/graph/projects/${encodeURIComponent(projectId)}/workspace-documents`);
      return { canWrite: readCanWrite(body), rows: readWorkspaceDocuments(body, projectId)
        .map(doc => ({ id: `document:${doc.id}`, title: doc.title ?? doc.id, kind: 'document', detail: `${doc.kind === 'whiteboard' ? 'Whiteboard' : 'Page'} · edited ${relativeTime(doc.updatedAt)}`, href: doc.href })) };
    };
    const decks = async (): Promise<FileRow[]> => {
      const rows: InitiativeDeckSummary[] = await get(initiativeDeckPaths.list(projectId));
      if (!Array.isArray(rows) || rows.some(row => row.projectId !== projectId || typeof row.id !== 'string' || typeof row.title !== 'string')) throw new Error('Invalid project presentations');
      return rows.map(row => ({ id: `presentation:${row.id}`, title: row.title, kind: 'presentation', detail: `PowerPoint · ${absoluteTime(row.updatedAt)}`, href: initiativeDeckPaths.page(row.id) }));
    };
    void Promise.allSettled([docs(), decks(), pages()]).then(([documents, presentations, written]) => {
      if (abort.signal.aborted) return;
      setRead({ pending: false, files: [...(written.status === 'fulfilled' ? written.value.rows : []), ...(documents.status === 'fulfilled' ? documents.value.files : []), ...(presentations.status === 'fulfilled' ? presentations.value : [])],
        recordings: null, canWritePages: written.status === 'fulfilled' && written.value.canWrite,
        failures: [written.status === 'rejected' ? 'Pages' : '', documents.status === 'rejected' || documents.value.partial ? 'Some documents' : '', presentations.status === 'rejected' ? 'Presentations' : ''].filter(Boolean) });
    });
    return () => abort.abort();
  }, [projectId, projectName, itemKey, refresh, client, lobby]); // eslint-disable-line react-hooks/exhaustive-deps
  const files = recordingRead.error ? read.files.filter(row => row.kind !== 'recording') : [...new Map([...read.files, ...(recordingRead.value ? recordingRows(recordingRead.value) : [])].map(row => [row.id, row])).values()];
  // A failed recordings read says its own reason in the info line (recordingsNote), not in this list.
  const failures = read.failures;
  const recordingsLine = recordingsNote(recordingsState, recordingRead.error);
  const cursor = read.recordings ? read.recordings.cursor : recordingRead.value?.cursor;
  const pending = read.pending || recordingRead.loading;
  const shown = files.filter(row => (kind === 'all' || kind === row.kind) && row.title.toLowerCase().includes(query.trim().toLowerCase()));
  const open = (row: FileRow) => row.recordingId ? onOpenRecording(row.recordingId) : row.href && navigate(row.href);
  // This request is also retired on refresh, scope change or unmount.
  const [olderRequest, setOlderRequest] = useState<AbortController | null>(null);
  useEffect(() => () => olderRequest?.abort(), [olderRequest, refresh, itemKey, projectName]);
  async function older() {
    if (!cursor || olderBusy || recordingRead.error) return;
    const abort = new AbortController(); setOlderRequest(abort); setOlderBusy(true); setOlderError(null);
    try { const result = await readInitiativeRecordings(client, lobby, abort.signal, cursor); if (abort.signal.aborted) return;
      setRead(current => ({ ...current, files: [...new Map([...current.files, ...recordingRows(result)].map(row => [row.id, row])).values()], recordings: result }));
    } catch { if (!abort.signal.aborted) setOlderError('Older recordings could not be read. Try again.'); }
    finally { if (!abort.signal.aborted) setOlderBusy(false); }
  }
  return <Stack gap="md" data-testid="initiative-files">
    <FileToolbar view={view} onViewChange={setView} refreshing={pending}
      onRefresh={() => { setOlderBusy(false); setRefresh(n => n + 1); }} onOpenWorkspace={() => navigate(workspaceHref)}
      label="Project file controls" testId="initiative-files-toolbar">
      {/* Keeps a working width: the row wraps (New and the switch go under it) before the box shrinks to a stub. */}
      <SearchInput size="sm" value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="Search project files" aria-label="Search project files" className="min-w-48 flex-1" />
      <Select size="sm" className="!w-36" aria-label="File type" value={kind} onChange={event => setKind(event.target.value)} options={[{ value: 'all', label: 'All files' }, { value: 'document', label: 'Documents' }, { value: 'presentation', label: 'Presentations' }, { value: 'recording', label: 'Recordings' }]} />
      <DropdownMenu triggerVariant="primary" align="end" sections={newMenu} disabled={newFileTrigger(choices).disabled}
        trigger={<><PlusIcon size={16} /><span>New</span><ChevronIcon size={14} dir="down" /></>}
        triggerLabel="New file" triggerTestId="initiative-files-new" data-testid="initiative-files-new-menu" />
      {switchTo && <Button size="sm" variant="secondary" data-testid="initiative-files-switch-role"
        onClick={() => { void setRole(switchTo.role).catch((err: unknown) => toastError(null, 'Could not switch role', err instanceof Error ? err.message : 'Try again.')); }}>{switchTo.label}</Button>}
    </FileToolbar>
    {/* Why New is disabled: a line under the toolbar, not a cell squeezing the search box. */}
    {showNewFileHint({ capabilitiesReady, pending, choices }) && <T size="xs" tone="secondary" wrap data-testid="initiative-files-new-hint">{NEW_FILE_DENIED_HINT}</T>}
    {mayDeck && <InitiativeStatusDecks projectId={projectId} projectName={projectName} open={newDeck} onOpenChange={setNewDeck} hideTrigger />}
    {failures.length > 0 && <InlineAlert tone="warning">{failures.join(', ')} could not be read. Other available files are shown. Use Refresh to retry.</InlineAlert>}
    {recordingsLine && <InlineAlert tone="info" data-testid="initiative-files-recordings-note">{recordingsLine}</InlineAlert>}
    {pending ? <LoadingState label="Loading project files…" /> : <>
      <T size="xs" tone="secondary">{shown.length} {shown.length === 1 ? 'file' : 'files'}{query || kind !== 'all' ? ' matching this view' : ' in this initiative'}</T>
      {shown.length === 0 ? <Stack gap="xs" className="rounded-lg border border-dashed border-border p-6"><T size="sm" weight="semibold">{files.length ? 'No matching files' : 'No project files yet'}</T><T size="sm" tone="secondary" wrap>{files.length ? 'Try another search or file type.' : 'Linked work documents, saved project presentations, and recordings you participated in appear here.'}</T></Stack>
        : view === 'cards' ? <FileCards items={shown.map(row => ({ ...row, kindLabel: row.kind }))} onOpen={id => { const row = shown.find(file => file.id === id); if (row) open(row); }} testId="initiative-files-cards" itemTestId="initiative-file" />
        : <Stack gap="none" className="divide-y divide-border rounded-lg border border-border" data-testid="initiative-files-list">
          {shown.map(row => <Button key={row.id} variant="ghost" className="!h-auto !w-full !justify-start !rounded-none !px-3 !py-3 text-left" onClick={() => open(row)} data-testid="initiative-file">
            <Inline gap="sm" align="start" wrap={false} className="min-w-0 w-full"><DocumentIcon size={20} className="shrink-0 text-primary" /><Stack gap="xs" className="min-w-0 text-left">
              <T size="xs" tone="secondary">{row.kind === 'presentation' ? 'PRESENTATION' : row.kind === 'recording' ? 'RECORDING' : 'DOCUMENT'}</T>
              <T size="sm" weight="semibold" wrap className="line-clamp-2 break-words">{row.title}</T><T size="xs" tone="secondary" wrap className="font-normal">{row.detail}</T>
            </Stack></Inline>
          </Button>)}
        </Stack>}
      {recordingRead.timedOut && <T size="xs" tone="secondary" role="status">Recording processing is taking longer than expected. Refresh to check again.</T>}
      {olderError && <T size="xs" tone="secondary" role="status">{olderError}</T>}
      {cursor && !recordingRead.error && <Inline><Button variant="secondary" size="sm" disabled={olderBusy} onClick={() => void older()}>Load older recordings</Button></Inline>}
    </>}
  </Stack>;
}
