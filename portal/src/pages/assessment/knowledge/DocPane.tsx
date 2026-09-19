import { DocumentReader } from './DocumentReader';
import { nextPresenceSequence } from './presenceSequence';
// The document viewer/editor pane — one document's realtime surface. Owns
// its channel (assessment:doc:<id>: chat + presence + reactions) and the
// CRDT-backed markdown editor. The per-page Activity aside is a sibling
// component (./ActivityBar.tsx), not rendered here — see KnowledgeExplorer.
//
// Ported behavior from agentic-assessment-accelerator's DocView, extended
// per docs/assessment-tenant.md's Workspace realtime plan: presence (who has
// this open), a per-doc comments drawer riding the channel's chat (this is
// the "All comments" row's real backing), a reactions bar, and collaborative
// editing via useCRDT instead of last-write-wins Save.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  DataTable,
  DetailHeader,
  Divider,
  Drawer,
  DropdownMenu,
  ErrorState,
  Inline,
  InlineAlert,
  InlinePlaceholder,
  LoadingState,
  MarkdownView,
  MetaLine,
  PresenceAvatars,
  Stack,
  TabPanel,
  Tabs,
  T,
  Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { ChatPanel, ReactionsBar } from '@connorhoehnslalom/ui-components/social';
import { useChannel, useCRDT, useGateway } from '@connorhoehnslalom/realtime-modules/client';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { useSession } from '../../../lib/auth';
import { sendJson } from '../../../lib/writeJson';
import { toastError, toastSuccess } from '../../../lib/toastStore';
import { relativeTime } from '../../../lib/relativeTime';
import {
  CLASSIFICATION_LABEL,
  channelForDoc,
  commentsForDoc,
  decideDocSaveGate,
  docSavedNoticeText,
  docSyncStatus,
  externalDocSave,
  isGatewayReady,
  mergeComments,
  mergePresenceForDisplay,
  latestPresenceForDoc,
  defuseJsonFences,
  stripFrontmatter,
  withStoredComments,
  stripTitleHeading,
  summarizeReactions,
  summarizeStoredReactions,
  type StoredReaction,
  type KnowledgeCommentItem,
} from './knowledgeFormat';
import type {
  AssessmentSSEEvent,
  KnowledgeDoc,
  KnowledgeDocPutResponse,
  KnowledgeDocVersionSummary,
  KnowledgeDocVersionsResponse,
  KnowledgeMode,
  KnowledgeNode,
} from './types';

// Stable per-tab identity for presence — distinguishes two tabs of the SAME
// signed-in user (docs/assessment-journeys/stretch/realtime.md's exact
// two-tab proof), which a session cookie alone cannot. sessionStorage (not a
// module-level variable) so it survives a reload of this same tab — a
// reload is still the same viewer, not a new one — but a new tab gets its
// own id. Falls back to a random string if storage/crypto throws (private
// browsing, older browsers).
function getTabId(): string {
  try {
    const existing = sessionStorage.getItem('assessment.knowledge.tabId');
    if (existing) return existing;
    const fresh = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `tab-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('assessment.knowledge.tabId', fresh);
    return fresh;
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}`;
  }
}

// Own-save timestamps this tab has confirmed (see knowledgeFormat.OwnSaveState),
// persisted the same way getTabId is: sessionStorage, not a plain in-memory
// ref, so a genuine full reload of this tab (not just reselecting the doc
// within the SPA) doesn't forget them either — exactly the repro filed in
// DEFECTS.md ("it survives a full reload of that tab ... still saying 'just
// now'"): the GET /api/assessment/events backlog a fresh mount re-fetches can
// still carry this tab's own save from minutes ago, and without this it reads
// as a brand-new external change every time the tab reloads. Capped to the
// newest 50 — externalDocSave only ever needs to recognize a ts still sitting
// in that same backlog, which is itself bounded.
const OWN_SAVE_TS_STORAGE_KEY = 'assessment.knowledge.ownSaveTimestamps';

function loadOwnSaveTimestamps(): Set<string> {
  try {
    const raw = sessionStorage.getItem(OWN_SAVE_TS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistOwnSaveTimestamps(timestamps: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(OWN_SAVE_TS_STORAGE_KEY, JSON.stringify([...timestamps].slice(-50)));
  } catch {
    // Private browsing / storage disabled — own-save tracking still works for
    // the life of this page load via the in-memory ref, just doesn't survive
    // an actual reload.
  }
}

function sendPresence(docId: string, tabId: string, action: 'enter' | 'heartbeat' | 'leave'): void {
  const body = JSON.stringify({ doc_id: docId, tab_id: tabId, action, sequence: nextPresenceSequence() });
  if (action === 'leave' && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    // The page may already be tearing down (close/navigate-away) — a plain
    // fetch can get cancelled mid-flight there; sendBeacon is guaranteed to
    // be delivered.
    navigator.sendBeacon('/api/assessment/knowledge/presence', new Blob([body], { type: 'application/json' }));
    return;
  }
  void fetch('/api/assessment/knowledge/presence', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body,
  }).catch(() => {});
}

function putJson<T>(url: string, body: unknown): Promise<T> {
  return sendJson<T>(url, 'PUT', body);
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return sendJson<T>(url, 'POST', body);
}

// ChatPanel (ui-components/social) renders its built-in composer as a plain
// `<Input placeholder="Type a message...">` with no `aria-label`/`label`
// prop reaching that field (see docs/assessment-journeys/stretch/
// accessibility.md and docs/ui-components-queue.md) — a placeholder is a
// hint, not an accessible name. This repo cannot edit the library (CLAUDE.md),
// so — same technique `DimensionMasterDetail.tsx`'s
// useDimensionListboxSemantics uses for `MasterDetail` — this patches the
// rendered DOM directly via a `data-testid` wrapper this component owns,
// scoped narrowly enough (one plain text field, since DocPane never passes
// `onSendFiles`, so no hidden file-picker element is ever rendered alongside
// it) that no library internals need to be assumed beyond "there is exactly
// one non-file text field in here". A MutationObserver re-applies it because
// ChatPanel re-renders the composer (new placeholder text) whenever
// `disabled` flips.
const COMMENT_COMPOSER_TEST_ID = 'doc-pane-comment-composer';

function useCommentComposerLabel(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.querySelector<HTMLElement>(`[data-testid="${COMMENT_COMPOSER_TEST_ID}"]`);
    if (!root) return;
    const label = () => {
      const input = root.querySelector<HTMLInputElement>('input:not([type="file"])');
      if (input && input.getAttribute('aria-label') !== 'Add a comment') input.setAttribute('aria-label', 'Add a comment');
    };
    const observer = new MutationObserver(() => {
      observer.disconnect();
      label();
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'placeholder'] });
    });
    label();
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'placeholder'] });
    return () => observer.disconnect();
  }, [active]);
}

export function FolderPane({ node, children, onSelectChild }: { node: KnowledgeNode; children: KnowledgeNode[]; onSelectChild: (id: string) => void }) {
  return (
    <Card padding="md">
      <Stack gap="sm">
        <DetailHeader
          as="h2"
          title={node.title}
          badge={node.classification && (
            <Chip size="xs" tone="info" uppercase>{CLASSIFICATION_LABEL[node.classification] ?? node.classification}</Chip>
          )}
        />
        {children.length === 0 ? (
          <InlinePlaceholder size="sm">This folder is empty.</InlinePlaceholder>
        ) : (
          <DataTable<KnowledgeNode>
            data={children}
            keyField={(child) => child.id}
            pageSize={20}
            columns={[
              { key: 'title', header: 'Name', sortable: true, render: (child) =>
                <Button variant="ghost" size="sm" className="border-0 px-0 text-left" onClick={() => onSelectChild(child.id)}>{child.title}</Button> },
              { key: 'classification', header: 'Type', render: (child) => child.is_dir ? 'Folder' : (child.classification ? CLASSIFICATION_LABEL[child.classification] ?? child.classification : 'Document') },
              { key: 'updated_at', header: 'Updated', render: (child) => child.updated_at ? relativeTime(child.updated_at) : '—' },
            ]}
          />
        )}
      </Stack>
    </Card>
  );
}

export interface DocPaneProps {
  node: KnowledgeNode;
  mode: KnowledgeMode;
  /** Server-originated events (GET /api/assessment/events) — this doc's
   *  save/comment/presence feed, and (still) what clears the Publish
   *  button's pending state once knowledge.published for this doc arrives. */
  sseEvents: AssessmentSSEEvent[];
  /** The SSE stream's CURRENT open/closed state (useAssessmentEvents'
   *  `connected`) — drives the honest half of the connection pill. */
  sseConnected: boolean;
  /**
   * `useAssessmentEvents`' `gapped` — the server's replay ring could not reach
   * back far enough to cover everything this tab missed, so some events are
   * gone for good rather than merely late.
   *
   * Deliberately NOT folded into the connection pill. The pill describes the
   * SOCKET, and a gapped stream is genuinely open — saying "reconnecting"
   * would be false, and saying "Live" alone is the half-truth the broker
   * started sending `stream.gap` to correct. Coverage is a second fact and
   * gets a second signal.
   */
  sseGapped: boolean;
  /** Refetches the knowledge tree — called once a publish lands, so the
   *  synced section picks up the new page node without a manual reload. */
  onTreeChanged: () => void;
}

/** Shared by <Tabs> and its <TabPanel>s — the library wires aria off this. */
const EDITOR_TABS_ID = 'doc-editor-view';

export function DocPane({ node, mode, sseEvents, sseConnected, sseGapped, onTreeChanged }: DocPaneProps) {
  const { can, ready } = useCapabilities();
  const { session } = useSession();
  const gateway = useGateway();
  const channel = channelForDoc(node.id);
  const { chat, presence, reactions } = useChannel(channel, {
    features: { chat: true, presence: true, reactions: true, activity: false },
    reactionsTargetId: node.id,
  });
  const crdt = useCRDT({
    sendMessage: gateway.sendMessage, onMessage: gateway.onMessage, currentChannel: channel, connectionState: gateway.connectionState,
  });

  const gatewayReady = isGatewayReady(gateway.connectionState, gateway.clientId);
  // Coarse transport state for the editor's save gate — see knowledgeFormat's
  // decideDocSaveGate for why 'synced' is the only state crdt.content can be
  // trusted in.
  const syncStatus = docSyncStatus(gateway.connectionState, gateway.clientId);

  // Announce THIS viewer over the real gateway's own presence protocol too
  // (not just the SSE route below) — the audit's root cause for presence
  // failing entirely was that nobody ever called setStatus/updateMetadata,
  // so every roster stayed empty regardless of transport. Stamping `sub`
  // into the channel's metadata is also what lets mergePresenceForDisplay
  // recognize "this channel peer IS the SSE viewer I already have", so a
  // human with a live gateway connection shows once, not twice.
  useEffect(() => {
    if (!gatewayReady || !presence || !session) return;
    presence.setStatus('online');
    presence.updateMetadata({ sub: session.sub, displayName: session.name });
    // presence/session identities are stable per render for our purposes;
    // only re-announce when the gateway actually becomes ready or the doc
    // (channel) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayReady, node.id]);

  const docUrl = `/api/assessment/knowledge/doc?id=${encodeURIComponent(node.id)}`;
  const docFetch = useFetch<KnowledgeDoc>(docUrl);

  const [editing, setEditing] = useState(false);
  // The HTTP-fallback editing buffer — used INSTEAD OF crdt.content whenever
  // the CRDT transport is not synced (docs/assessment-journeys/stretch/
  // realtime.md: useCRDT never wires its Y.Text observer while
  // connectionState isn't 'connected', so crdt.content is frozen at '' and
  // trusting it there is how Save destroyed a 326-character document). Seeded
  // from doc.markdown when edit mode starts off-sync; null otherwise/once
  // consumed, so it never leaks stale content into a later synced session.
  const [fallbackContent, setFallbackContent] = useState<string | null>(null);
  // Which value backs the editor for the CURRENT edit session, fixed at the
  // moment editing starts (see startEditing) and only ever handed off from
  // 'crdt' to 'fallback' — never the reverse mid-session, which would risk
  // silently discarding in-progress fallback edits the instant the gateway
  // reconnects and pushes a snapshot that doesn't include them.
  const [editSource, setEditSource] = useState<'crdt' | 'fallback' | null>(null);
  const [versionLabel, setVersionLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [banner, setBanner] = useState<'saved' | 'restored' | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoringStamp, setRestoringStamp] = useState<string | null>(null);
  const [confirmRestoreStamp, setConfirmRestoreStamp] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const versionsFetch = useFetch<KnowledgeDocVersionsResponse>(
    historyOpen ? `/api/assessment/knowledge/doc/versions?id=${encodeURIComponent(node.id)}` : null,
  );

  // Own-save tracking for externalDocSave (see knowledgeFormat.OwnSaveState).
  // `confirmedTimestamps` is a ref, not state, and — unlike the old single
  // `mySavedTs` — is NEVER reset when `node.id` changes: reselecting a doc
  // this tab already saved earlier must still recognize that old save as
  // its own, not just the most recent one. `ownSaveVersion` exists purely to
  // force the reconciliation effect below to re-run when a ref-only update
  // (a save resolving) needs to retract or confirm a notice with no new SSE
  // event having arrived.
  const confirmedTimestampsRef = useRef<Set<string>>(new Set());
  const saveInFlightRef = useRef(false);
  const [ownSaveVersion, setOwnSaveVersion] = useState(0);
  // The notice stores WHO and WHEN, never the rendered sentence: holding the
  // text froze its age, so a save kept reading "just now" eight minutes later
  // (the effect short-circuits on an unchanged ts, so the text was computed
  // exactly once per save). The wording is derived at render instead, and the
  // 15s presence heartbeat re-renders often enough to keep it honest.
  const [notice, setNotice] = useState<{ by: string; requiresReload: boolean; ts: string } | null>(null);
  const dismissedTsRef = useRef<Set<string>>(new Set());
  const [commentError, setCommentError] = useState<string | null>(null);

  // Rehydrate confirmed own-save timestamps from sessionStorage once, on
  // mount — see loadOwnSaveTimestamps' comment for why this (rather than a
  // plain in-memory ref alone) is what makes the notice suppression survive
  // an actual reload of this tab, not just reselecting the doc within the
  // SPA.
  useEffect(() => {
    for (const ts of loadOwnSaveTimestamps()) confirmedTimestampsRef.current.add(ts);
    setOwnSaveVersion((v) => v + 1);
    // Mount-once: this ref is this tab's own-save memory for its whole
    // lifetime on this page, not something that should re-sync per doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New selection — always start in read mode.
  useEffect(() => {
    setEditing(false);
    setFallbackContent(null);
    setEditSource(null);
    setVersionLabel('');
    setSaveError(null);
    setBanner(null);
    setHistoryOpen(false);
    setConfirmRestoreStamp(null);
    setRestoreError(null);
    setPublishing(false);
    setPublishError(null);
    setNotice(null);
    setCommentError(null);
    // Deliberately NOT resetting confirmedTimestampsRef/dismissedTsRef here —
    // see their declarations. Forgetting them on reselect is the "fires
    // after any reload" half of the doc-saved notice bug (DEFECTS.md): the
    // sseEvents list keeps every event for the life of the connection, so a
    // stale echo of THIS tab's own earlier save on this same doc is still
    // sitting there waiting to be misread as external the moment the ref
    // that would have recognized it as ours got wiped.
  }, [node.id]);

  // Clears the Publish button's pending state once the server's
  // knowledge.published lands for THIS doc — same "POST, then wait for the
  // matching SSE event" pattern as the section Pull control.
  useEffect(() => {
    if (!publishing) return;
    const landed = sseEvents.some((e) => e.type === 'knowledge.published' && e.id === node.id);
    if (landed) {
      setPublishing(false);
      onTreeChanged();
    }
  }, [sseEvents, publishing, node.id, onTreeChanged]);

  // Doc-sync over SSE: when ANOTHER tab/actor saves this doc, refetch it —
  // unless this tab is mid-edit, where an auto-refresh would clobber the
  // in-progress textarea; there, just surface a "Reload" action instead.
  // See knowledgeFormat.externalDocSave/OwnSaveState for how "another actor"
  // is told apart from "the SSE echo of my own save".
  //
  // Re-derives `ext` from scratch on every run rather than latching once a
  // ts has been flagged — that's what lets this RECONCILE a notice already
  // shown: if `ext` was set while a same-tab save was still in flight (its
  // ts unconfirmed), and the response then lands and adds that ts to
  // confirmedTimestampsRef, the next run of this effect (forced by
  // ownSaveVersion bumping even though sseEvents didn't change) sees
  // `externalDocSave` return null for it and retracts the notice — instead
  // of the old code's single ignoreUpToTs comparison, which could only ever
  // be checked once per event.
  useEffect(() => {
    const ext = externalDocSave(sseEvents, node.id, {
      confirmedTimestamps: confirmedTimestampsRef.current,
      saveInFlight: saveInFlightRef.current,
    });
    if (!ext || dismissedTsRef.current.has(ext.ts)) {
      setNotice(null);
      return;
    }
    setNotice((prev) => {
      if (prev?.ts === ext.ts) return prev; // already showing this exact save
      if (!editing) {
        docFetch.refresh();
        versionsFetch.refresh();
      }
      return { by: ext.by, requiresReload: editing, ts: ext.ts };
    });
    // docFetch/versionsFetch identities churn every render (useFetch), and
    // aren't part of the "should this effect re-run" question — only a new
    // doc, a newer/retracted save, or entering/leaving edit mode is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sseEvents, node.id, editing, ownSaveVersion]);

  // Presence lifecycle — announce this tab into the doc's viewer roster on
  // open, keep it alive with a heartbeat, and remove it on unmount/tab
  // close. This is the piece that was entirely missing: DocPane only ever
  // rendered a presence roster, never announced into one (see
  // docs/assessment-journeys/stretch/realtime.md).
  useEffect(() => {
    const tabId = getTabId();
    sendPresence(node.id, tabId, 'enter');
    const interval = setInterval(() => sendPresence(node.id, tabId, 'heartbeat'), 15_000);
    const handlePageHide = () => sendPresence(node.id, tabId, 'leave');
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      clearInterval(interval);
      window.removeEventListener('pagehide', handlePageHide);
      sendPresence(node.id, tabId, 'leave');
    };
  }, [node.id]);

  // Mid-edit handoff: if the session started editing over the live CRDT and
  // the transport then drops out of sync, capture the LAST GOOD
  // `crdt.content` (this render still has it — useCRDT only resets it to ''
  // in its own effect cleanup, which runs after this one, in the same
  // commit) into the fallback buffer and switch the session to fallback for
  // the rest of the edit. Without this, the textarea would go on rendering
  // `crdt.content` straight through the reset to '' — the exact failure
  // mode in docs/assessment-journeys/stretch/realtime.md, just triggered by
  // a disconnect mid-edit instead of one that was already down on open.
  // crdt.content is deliberately not a dependency — this should fire once
  // per drop, not on every keystroke.
  useEffect(() => {
    if (!editing || editSource !== 'crdt' || syncStatus === 'synced') return;
    setFallbackContent(crdt.content);
    setEditSource('fallback');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, editSource, syncStatus]);

  /** `GET /knowledge/doc/comments` — the durable row, as the server sends it. */
interface StoredCommentWire {
  id: string;
  doc_id: string;
  body: string;
  author: string;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
}

// ─── Comments: SSE-authoritative, gateway chat merged in when live ──────
  const sseComments = useMemo(() => commentsForDoc(sseEvents, node.id), [sseEvents, node.id]);
  const channelComments = useMemo<KnowledgeCommentItem[]>(
    () => (chat?.messages ?? []).map((m) => ({
      id: m.id,
      clientId: m.clientId,
      content: m.message,
      timestamp: m.timestamp,
      displayName: typeof m.metadata?.['displayName'] === 'string' ? (m.metadata['displayName'] as string) : undefined,
    })),
    [chat?.messages],
  );
  // The durable thread. Without this the pane only ever showed comments that
  // arrived while this tab was open, so a reload emptied it and the drawer
  // then said "No comments on this document yet" about a comment the reader
  // had just written.
  const storedFetch = useFetch<{ comments: StoredCommentWire[] }>(
    `/api/assessment/knowledge/doc/comments?id=${encodeURIComponent(node.id)}`,
  );
  const storedComments = useMemo<KnowledgeCommentItem[]>(
    () => (storedFetch.data?.comments ?? []).map((c) => ({
      id: c.id, clientId: c.author, userId: c.author, content: c.body,
      timestamp: c.created_at, displayName: c.author,
      ...(c.edited_at ? { editedAt: c.edited_at } : {}),
      ...(c.deleted_at ? { deletedAt: c.deleted_at } : {}),
    })),
    [storedFetch.data],
  );
  const liveComments = useMemo(
    () => mergeComments(sseComments, channelComments), [sseComments, channelComments],
  );
  const mergedComments = useMemo(
    () => withStoredComments(storedComments, liveComments), [storedComments, liveComments],
  );

  // Durable reactions, from the BFF. These hooks live UP HERE, above the
  // `if (docFetch.isLoading) return` below, because a hook after an early
  // return runs on some renders and not others — React counts them and says
  // so ("Rendered more hooks than during the previous render"). The comment
  // fetch beside them is up here for the same reason.
  //
  // The gateway's own reaction feature has no The gateway's own reaction feature has no
  // endpoint and no persistence behind it, so before this a reaction could not
  // survive a reload and — with the gateway down, which is this environment's
  // state — could not be made at all.
  const reactionsFetch = useFetch<{ reactions: StoredReaction[] }>(
    `/api/assessment/knowledge/doc/reactions?id=${encodeURIComponent(node.id)}`,
  );
  const storedReactions = useMemo(
    () => reactionsFetch.data?.reactions ?? [], [reactionsFetch.data],
  );
  const mySub = session?.sub ?? null;
  // Write / Preview while editing. A markdown document is edited as raw text
  // and read as rendered output, and until now the author could only see the
  // second by saving — which this session proved is not a safe assumption:
  // the renderer has quirks of its own (a ```json fence printed broken markup
  // at the reader until it was defused). Seeing it before saving is the point.
  const [editorTab, setEditorTab] = useState<'write' | 'preview'>('write');
  const reactionSummaries = useMemo(
    () => summarizeStoredReactions(storedReactions, node.id, mySub),
    [storedReactions, node.id, mySub],
  );

  async function toggleReaction(targetId: string, emoji: string) {
    try {
      await sendJson('/api/assessment/knowledge/doc/reaction', 'POST',
        { id: node.id, targetId, emoji });
      reactionsFetch.refresh();
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : 'That reaction could not be saved.');
    }
  }

  // ─── Presence: SSE-authoritative, gateway peers folded in by `sub` ──────
  const sseViewers = useMemo(() => latestPresenceForDoc(sseEvents, node.id), [sseEvents, node.id]);
  const channelPeers = useMemo(
    () => (presence?.roster ?? []).map((p) => ({ clientId: p.clientId, metadata: p.metadata })),
    [presence?.roster],
  );
  const presenceUsers = useMemo(() => mergePresenceForDisplay(sseViewers, channelPeers), [sseViewers, channelPeers]);

  useCommentComposerLabel(commentsOpen);

  if (docFetch.isLoading) return <LoadingState label="Loading document…" />;
  if (docFetch.error || !docFetch.data) {
    // `body` and `description` are ALIASES for one slot on ErrorState, so
    // passing both silently drops one — this used to pass both and the id won,
    // leaving a reader with the document's name in red, a warning triangle and
    // no sentence saying what had happened. The title also has to be the
    // failure, not the document: every other error state in the app reads
    // "Could not load the X", and a red document NAME reads as "this document
    // is an error" rather than "we could not fetch it".
    return (
      <ErrorState
        title="Couldn't load this document"
        body={`${node.title} — ${node.id}`}
      />
    );
  }
  const doc = docFetch.data;
  // Prompts render read-only regardless of `doc.editable` — the nine agentic
  // processes are shipped with the accelerator, not authored from this UI
  // (docs/assessment-tenant.md "Prompts mode ... a read-only body").
  const canEdit = ready && doc.editable && can('ManageKnowledge') && mode !== 'prompts';
  // Whether opening the editor right now would actually show real content —
  // either the CRDT is synced, or the HTTP-fetched doc has non-empty
  // markdown to fall back to. See knowledgeFormat.decideDocSaveGate.
  const openGate = decideDocSaveGate({ status: syncStatus, hasSeed: doc.markdown.length > 0 });
  // canEdit says the role/doc COULD be edited; editingUnavailable says the
  // transport leaves nothing safe to edit right now — read-only with a
  // reason, never a blank box that accepts a Save (docs/assessment-journeys/
  // stretch/realtime.md).
  const editingUnavailable = canEdit && !openGate.allowed;

  const startEditing = () => {
    if (syncStatus === 'synced') {
      // Seed the shared CRDT doc from the persisted markdown the first time
      // anyone edits this doc in this process — a fresh channel with no
      // content yet would otherwise hand every subsequent editor a blank
      // textarea even though the doc has saved content.
      if (!crdt.content && doc.markdown) crdt.applyLocalEdit(doc.markdown);
      setEditSource('crdt');
    } else {
      // Only reachable when openGate.allowed, which off-sync means a
      // non-empty doc.markdown exists — edit a local copy of it instead of
      // the CRDT, which is frozen and untrustworthy while not synced.
      setFallbackContent(doc.markdown);
      setEditSource('fallback');
    }
    setVersionLabel('');
    setBanner(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditSource(null);
    setFallbackContent(null);
  };

  // Marks a save/restore in flight BEFORE the request goes out (the
  // frame-before-response half of the fix) and confirms its ts once the
  // response comes back — see knowledgeFormat.OwnSaveState. `setOwnSaveVersion`
  // forces the notice-reconciliation effect to re-run even when this doc's
  // own SSE echo already arrived and so `sseEvents` isn't changing again.
  const beginOwnSave = () => {
    saveInFlightRef.current = true;
    setOwnSaveVersion((v) => v + 1);
  };
  const confirmOwnSave = (ts: string) => {
    saveInFlightRef.current = false;
    confirmedTimestampsRef.current.add(ts);
    persistOwnSaveTimestamps(confirmedTimestampsRef.current);
    setOwnSaveVersion((v) => v + 1);
  };
  const abandonOwnSave = () => {
    saveInFlightRef.current = false;
    setOwnSaveVersion((v) => v + 1);
  };

  const handleSave = async () => {
    // The actual save gate: 'fallback' means the editor holds a value that
    // was genuinely loaded (the HTTP seed, or a mid-edit handoff capture) —
    // always safe. 'crdt' is only safe while still synced; if the transport
    // dropped and the handoff effect hasn't run yet (or something bypassed
    // it), refuse rather than post a possibly-reset crdt.content.
    const gate = editSource === 'fallback'
      ? { allowed: true as const }
      : decideDocSaveGate({ status: syncStatus, hasSeed: fallbackContent !== null });
    if (!gate.allowed) {
      setSaveError(gate.reason ?? 'Save is unavailable — the document was never fully loaded into the editor.');
      return;
    }
    const markdown = editSource === 'fallback' ? (fallbackContent ?? '') : crdt.content;
    setSaving(true);
    setSaveError(null);
    beginOwnSave();
    try {
      const result = await putJson<KnowledgeDocPutResponse>('/api/assessment/knowledge/doc', {
        id: node.id, markdown, label: versionLabel.trim() || null,
      });
      confirmOwnSave(result.updated_at);
      setEditing(false);
      setEditSource(null);
      setFallbackContent(null);
      setVersionLabel('');
      setBanner('saved');
      docFetch.refresh();
    } catch (err) {
      abandonOwnSave();
      setSaveError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (stamp: string) => {
    setRestoringStamp(stamp);
    setRestoreError(null);
    beginOwnSave();
    try {
      const result = await postJson<KnowledgeDocPutResponse>('/api/assessment/knowledge/doc/restore', { id: node.id, stamp });
      confirmOwnSave(result.updated_at);
      setConfirmRestoreStamp(null);
      setEditing(false);
      setEditSource(null);
      setFallbackContent(null);
      setBanner('restored');
      docFetch.refresh();
      versionsFetch.refresh();
    } catch (err) {
      abandonOwnSave();
      setRestoreError(err instanceof Error ? err.message : 'Failed to restore.');
    } finally {
      setRestoringStamp(null);
    }
  };

  // "Publish" pushes this local doc up into the synced section — always
  // explicit, never implied by Save (docs/assessment-tenant.md "Workspace
  // page"). Stays pending until knowledge.published for this doc id arrives
  // over SSE (the effect above), which is also what triggers the tree
  // refetch — a real round trip, not an optimistic flip.
  const canPublish = ready && doc.editable && can('ManageKnowledge') && mode !== 'prompts' && mode !== 'workspace';

  const handlePublish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      await postJson('/api/assessment/knowledge/doc/publish', { id: node.id });
    } catch (err) {
      setPublishing(false);
      setPublishError(err instanceof Error ? err.message : 'Failed to publish.');
    }
  };

  // Sends over BOTH paths: the channel (real-time delivery to peers
  // currently connected to the gateway, when one is live) AND the durable
  // POST, whose SSE echo is what actually renders the message — including
  // back to the sender, and to any tab/dashboard not on the channel at all.
  // mergeComments folds the two back into one list when both land.
  const handleSendComment = (text: string) => {
    setCommentError(null);
    chat?.sendMessage(text);
    void postJson('/api/assessment/knowledge/doc/comment', { id: node.id, body: text }).catch((err) => {
      setCommentError(err instanceof Error ? err.message : 'Failed to send comment.');
    });
  };

  async function handleEditComment(message: { id?: string }, text: string) {
    if (!message.id) return;
    try {
      await sendJson('/api/assessment/knowledge/doc/comment', 'PATCH', { commentId: message.id, body: text });
      storedFetch.refresh();
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : 'That edit could not be saved.');
    }
  }

  async function handleDeleteComment(message: { id?: string }) {
    if (!message.id) return;
    try {
      await sendJson('/api/assessment/knowledge/doc/comment', 'DELETE', { commentId: message.id });
      storedFetch.refresh();
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : 'That comment could not be removed.');
    }
  }

  const displayMarkdown = defuseJsonFences(stripTitleHeading(stripFrontmatter(doc.markdown), doc.title));
  // The preview reads the LIVE buffer, through the same transform the reader
  // gets — otherwise it would be a preview of the last save, which is the one
  // thing an author does not need to see.
  const editorBuffer = editSource === 'fallback' ? (fallbackContent ?? '') : crdt.content;
  const previewMarkdown = defuseJsonFences(stripTitleHeading(stripFrontmatter(editorBuffer), doc.title));

  return (
    <>
      <Card padding="md" className="shadow-sm">
        <Stack gap="md">
          <Inline justify="between" align="start" wrap>
            <Stack gap="xs" className="min-w-0">
              <Inline gap="xs" align="center">
                <Chip
                  size="xs"
                  uppercase
                  className="bg-brand-soft text-brand-ink"
                >
                  {CLASSIFICATION_LABEL[doc.classification] ?? doc.classification}
                </Chip>
              </Inline>
              <DetailHeader
                as="h2"
                title={doc.title}
                meta={
                  /* `updated_at` came down on every doc read and was used only
                     to confirm this tab's own save — never shown. "When did
                     this last change?" is the second question anyone asks of a
                     document, and the answer was already in hand. */
                  <MetaLine
                    items={[
                      doc.path,
                      doc.argument_hint && `Arguments: ${doc.argument_hint}`,
                      doc.updated_at ? `Updated ${relativeTime(doc.updated_at)}` : null,
                    ]}
                    size="xs"
                    tone="tertiary"
                  />
                }
              />
            </Stack>
            <Inline gap="sm" align="start" wrap>
              {presenceUsers.length > 0 && (
                <PresenceAvatars users={presenceUsers.map((u) => ({ id: u.id, name: u.name, online: true, detail: u.detail }))} size={28} />
              )}
              <Inline gap="xs">
                <Button variant="secondary" size="sm" onClick={() => setCommentsOpen(true)}>
                  Comments{mergedComments.length > 0 ? ` (${mergedComments.length})` : ''}
                </Button>
                <DropdownMenu trigger="More" triggerClassName="text-xs px-2.5 py-1" triggerLabel="Document actions" align="end" sections={[{ items: [
                  ...(canEdit ? [{ label: 'Version history', onSelect: () => setHistoryOpen(true) }] : []),
                  { label: 'Copy document link', onSelect: () => {
                    void (navigator.clipboard ? navigator.clipboard.writeText(window.location.href) : Promise.reject(new Error('Clipboard unavailable'))).then(
                      () => toastSuccess(null, 'Document link copied'),
                      () => toastError(null, 'Could not copy link', 'Copy the address from your browser.'),
                    );
                  } },
                  { label: 'Download Markdown', onSelect: () => {
                    const url = URL.createObjectURL(new Blob([doc.markdown], { type: 'text/markdown;charset=utf-8' }));
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = `${doc.title.replace(/[^a-z0-9 ._-]/gi, '_') || 'document'}.md`;
                    anchor.click();
                    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                  } },
                ] }]} />
                {canPublish && (
                  <Button variant="secondary" size="sm" disabled={publishing} onClick={() => void handlePublish()}>
                    {publishing ? 'Publishing…' : 'Publish'}
                  </Button>
                )}
                {canEdit && !editingUnavailable && (
                  editing ? (
                    <>
                      <Button variant="secondary" size="sm" disabled={saving} onClick={cancelEditing}>Cancel</Button>
                      <Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
                        {saving ? 'Saving…' : 'Save'}
                      </Button>
                    </>
                  ) : (
                    <Button variant="primary" size="sm" onClick={startEditing}>Edit document</Button>
                  )
                )}
              </Inline>
            </Inline>
          </Inline>

          {/* A rule under the header block. The reference DocView separates
              "what this is" from "what it says" with one; without it the
              title, the path and the first paragraph ran together as a single
              column of text and the eye had nothing to stop on. */}
          <Divider spacing="none" />

          {editing && (
            <Textarea
              value={versionLabel}
              onChange={(e) => setVersionLabel(e.target.value)}
              rows={1}
              placeholder="Version label (optional) — e.g. v2 — tightened calibration"
              aria-label="Version label (optional)"
              maxLength={60}
              className="font-mono text-xs"
            />
          )}

          {/* What a gap does and does not mean, because the distinction decides
              what we tell the reader to do. The document BODY is a CRDT synced
              over its own channel, so it is not affected. What rides the SSE
              feed is everything ABOUT the document — publishes, comments,
              presence, the Publish button's pending state — so those are what
              can be silently missing, and a reload is the only way back. */}
          {sseGapped && (
            <InlineAlert tone="warning">
              This tab was disconnected for longer than the live feed keeps its
              history, so some activity was missed and cannot be replayed. The
              document text itself is still in sync — it syncs separately — but
              comments, publishes and presence may be incomplete. Reload the page
              to catch up.
            </InlineAlert>
          )}

          {editing && editSource === 'crdt' && crdt.hasConflict && (
            <InlineAlert tone="warning" onDismiss={crdt.dismissConflict}>
              Someone else's edit landed while you were typing — the shared document merged both, but double-check the
              result before saving.
            </InlineAlert>
          )}

          {canEdit && editingUnavailable && !editing && (
            <InlineAlert tone="warning">
              {openGate.reason ?? 'Editing is unavailable right now.'}
            </InlineAlert>
          )}

          {editing && editSource === 'fallback' && (
            <InlineAlert tone="warning">
              Editing an offline copy — the realtime session is {syncStatus}, so this edit won't sync live and other
              viewers won't see it until you save.
            </InlineAlert>
          )}

          {notice && (
            <InlineAlert
              tone="info"
              onDismiss={() => {
                dismissedTsRef.current.add(notice.ts);
                setNotice(null);
              }}
            >
              <Inline gap="sm" align="center" justify="between" wrap>
                {docSavedNoticeText(notice.by, notice.ts)}
                {notice.requiresReload && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      dismissedTsRef.current.add(notice.ts);
                      docFetch.refresh();
                      versionsFetch.refresh();
                      cancelEditing();
                      setNotice(null);
                    }}
                  >
                    Reload
                  </Button>
                )}
              </Inline>
            </InlineAlert>
          )}

          {banner && !editing && (
            <Chip tone="success">{banner === 'saved' ? 'Saved.' : 'Restored.'}</Chip>
          )}
          {saveError && <Chip tone="danger">{saveError}</Chip>}
          {publishError && <Chip tone="danger">{publishError}</Chip>}

          {editing ? (
            <>
              {/* Two views of one document, switched rather than tiled: there
                  is no split-pane primitive in the library, and a hand-rolled
                  flex container is the thing the component gate exists to
                  stop. `Tabs` is what the library ships for "two views of the
                  same thing", and it carries the aria wiring to `TabPanel`
                  with it.

                  Preview renders the SAME transform the reader gets —
                  frontmatter and the title heading stripped, json fences
                  defused — rather than the raw buffer, so what the author
                  checks is what will actually be published. */}
              <Tabs
                items={[{ id: 'write', label: 'Write' }, { id: 'preview', label: 'Preview' }]}
                value={editorTab}
                onValueChange={(id) => setEditorTab(id === 'preview' ? 'preview' : 'write')}
                variant="underline"
                size="sm"
                idPrefix={EDITOR_TABS_ID}
                aria-label="Document editor view"
              />
              <TabPanel id="write" when={editorTab} idPrefix={EDITOR_TABS_ID}>
                <Textarea
                  value={editSource === 'fallback' ? (fallbackContent ?? '') : crdt.content}
                  onChange={(e) => {
                    if (editSource === 'fallback') setFallbackContent(e.target.value);
                    else crdt.applyLocalEdit(e.target.value);
                  }}
                  rows={24}
                  spellCheck={false}
                  aria-label={`${doc.title} — document body`}
                  className="font-mono text-xs"
                />
              </TabPanel>
              <TabPanel id="preview" when={editorTab} idPrefix={EDITOR_TABS_ID}>
                <MarkdownView markdown={previewMarkdown} className="doc-markdown" />
              </TabPanel>
            </>
          ) : (
            <DocumentReader markdown={displayMarkdown} reactions={
              <ReactionsBar reactions={reactionSummaries} onReact={(emoji) => void toggleReaction(node.id, emoji)} />
            } />
          )}
        </Stack>

        <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} title="Version history" width={420}>
          {versionsFetch.isLoading && <LoadingState label="Loading history…" />}
          {versionsFetch.error && <ErrorState title="Couldn't load version history" body={versionsFetch.error} />}
          {versionsFetch.data && versionsFetch.data.versions.length === 0 && (
            <InlinePlaceholder>No earlier versions yet — saved changes will appear here.</InlinePlaceholder>
          )}
          {versionsFetch.data && versionsFetch.data.versions.length > 0 && (
            <DataTable<KnowledgeDocVersionSummary>
              data={versionsFetch.data.versions}
              keyField={(v) => v.stamp}
              // A drawer's version history for one doc — 10 keeps it to the
              // drawer's own height.
              pageSize={10}
              columns={[
                {
                  key: 'revision',
                  header: 'Revision',
                  render: (v) => (
                    <Stack gap="none">
                      {v.label ? <Chip size="xs" tone="info">{v.label}</Chip> : <MetaLine items={['Untitled save']} size="xs" tone="tertiary" />}
                      <MetaLine items={[v.size < 1024 ? `${v.size} B` : `${(v.size / 1024).toFixed(1)} KB`]} size="xs" tone="tertiary" />
                    </Stack>
                  ),
                },
                {
                  key: 'status',
                  header: 'Actions',
                  render: (v) => (confirmRestoreStamp === v.stamp ? (
                    <Inline gap="xs" align="center" wrap>
                      <Chip tone="warning">Restore this version? The current content is snapshotted first.</Chip>
                      <Button size="sm" variant="danger" disabled={restoringStamp === v.stamp} onClick={() => void handleRestore(v.stamp)}>
                        {restoringStamp === v.stamp ? 'Restoring…' : 'Confirm'}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setConfirmRestoreStamp(null)}>Cancel</Button>
                    </Inline>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => setConfirmRestoreStamp(v.stamp)}>Restore</Button>
                  )),
                },
                { key: 'when', header: 'When', render: (v) => new Date(v.saved_at).toLocaleString() },
              ]}
            />
          )}
          {restoreError && <Chip tone="danger">{restoreError}</Chip>}
        </Drawer>

        <Drawer open={commentsOpen} onClose={() => setCommentsOpen(false)} title="Comments" width={420}>
          <Stack gap="sm" data-testid={COMMENT_COMPOSER_TEST_ID}>
            {commentError && (
              <InlineAlert tone="error" onDismiss={() => setCommentError(null)}>{commentError}</InlineAlert>
            )}
            <ChatPanel
              messages={mergedComments.map((c) => ({
                id: c.id, clientId: c.clientId, userId: c.userId, content: c.content,
                timestamp: c.timestamp, displayName: c.displayName,
                ...(c.editedAt ? { editedAt: c.editedAt } : {}),
                ...(c.deletedAt ? { deletedAt: c.deletedAt } : {}),
              }))}
              onSend={handleSendComment}
              /* Edit and delete are ChatPanel's own affordances — it renders
                 the action bar, the inline editor and the tombstone. They
                 needed somewhere to write to, which is what the PATCH and
                 DELETE are. The panel only offers them on the viewer's own
                 messages, and the server checks authorship again from the
                 session rather than trusting that. */
              onEditMessage={handleEditComment}
              onDeleteMessage={handleDeleteComment}
              /* Per-comment reactions, off the same store as the document's
                 own bar. ChatPanel renders the summaries and the picker; the
                 library's note is that `reactionsFor` omitted means no
                 reaction UI at all, and `onToggleReaction` present is what
                 enables the controls.

                 Note the two contracts differ: `ReactionsBar` above takes
                 AGGREGATED {emoji,count,mine} summaries, while ChatPanel wants
                 the RAW per-reactor rows and aggregates them itself — which is
                 how it can name who reacted. Our store is one row per actor,
                 so it feeds both without a second source of truth. */
              reactionsFor={(messageId) => storedReactions
                .filter((r) => r.target_id === messageId)
                .map((r) => ({ emoji: r.emoji, userId: r.actor, displayName: r.actor }))}
              onToggleReaction={(messageId, emoji) => void toggleReaction(messageId, emoji)}
              /* `currentUserId` is the identity prop; `currentActor` is a
                 legacy DISPLAY-NAME fallback, and its own doc comment says so
                 — "a display name is not an identity, and deciding ownership
                 from it gave two participants named Alex a cancel button on
                 each other's uploads". This passed the session `sub` into the
                 display-name slot and nothing into the identity one, so the
                 panel could not answer "is this mine" about any comment. */
              currentUserId={session?.sub ?? gateway.clientId ?? undefined}
              currentActor={session?.name ?? undefined}
              /* ChatPanel's default empty line is the bare "No messages yet",
                 which its own prop doc calls out as the thing `emptyState`
                 exists to replace. On a document, "no messages" is also the
                 wrong noun: this is a comment thread about a specific page,
                 not a chat room. */
              emptyState={
                <Stack gap="xs">
                  <T className="text-[13px] font-medium text-text-primary">No comments on this document yet</T>
                  <T className="text-[12px] text-text-secondary leading-snug">
                    {`Comments are attached to ${doc.title} and everyone with access to it sees them. Ask a question about a specific claim, or leave the reasoning behind a change so the next reader does not have to reconstruct it.`}
                  </T>
                </Stack>
              }
              showHeader={false}
              fill
            />
          </Stack>
        </Drawer>
      </Card>
    </>
  );
}

export default DocPane;
