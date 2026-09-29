import { useEffect, useRef, useState, useMemo, useCallback, type ReactNode } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router';
import { useAgentStream } from '@connorhoehnslalom/realtime-modules/agent-streaming/client';
import type { Message as AgentMessage } from '@connorhoehnslalom/realtime-modules/agent-streaming/client';
import {
  Banner,
  Button,
  ChatComposer,
  EmptyState,
  EntityCell,
  ExpertCard,
  Inline,
  MessageBubble,
  MetaLine,
  QuickPromptGrid,
  FollowUpChips,
  SectionLabel,
  Select,
  Stack,
  SubNavLayout,
  activeNavItemClassName,
  inactiveNavItemClassName,
  SuggestionCard,
  ThinkingBlock,
  WorkflowStepper,
} from '@connorhoehnslalom/ui-components/shared';
import { ScopeHeader, ViewportFillRegion } from '@connorhoehnslalom/ui-components';
import { ChatPanel } from '@connorhoehnslalom/ui-components/social';
import { useFetch } from '../hooks/useFetch';
import { useUrlState } from '../lib/useUrlState';
import { Markdown } from '../components/Markdown';
import { T } from './Text';
import { canonicalKey } from './agentFleetRows.ts';
import {
  fetchSessionMessages, rememberSession, recallSession, forgetSession,
  SessionHistoryError,
} from '../lib/chatSessions';
import {
  sortPeople, buildMentionRegexes, findMentionedPeople, generateFollowUps,
  type GraphEntities, type GraphPerson,
} from '../lib/orgMentions';
import { usePresence, useChat } from '@connorhoehnslalom/realtime-modules/client';
import { PresenceAvatarGroup } from '../components/shell/PresenceAvatarGroup';
import { deriveSources, extractSources } from '../components/chat/answerSources';
import { useCapabilities } from '../lib/capabilities';
import { SourceChips } from '../components/chat/SourceChips';
import { friendlyToolName } from '../components/chat/toolCallSummary';
import { coalesceAssistantMessages } from '../components/chat/coalesceMessages';
import { collapseFailedTurn } from '../components/chat/collapseFailedTurn';
import { FeedbackControl } from '../components/chat/FeedbackControl';
import { describeTurnError } from '../components/chat/turnError';
import { readSearchEvidence, linkSearchCitations } from './search/searchModel';
import type { SearchRef } from './search/searchTypes';
import { UnavailableNotice } from '../components/UnavailableNotice';

// Feature flag: set VITE_ORGIQ_CHAT_ENABLED=true to show the session chat sidebar.
// We avoid import.meta.env typing concerns (no vite-env.d.ts in this repo) by
// using the same cast pattern as GatewayStatusBadge.tsx.
const CHAT_ENABLED =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_ORGIQ_CHAT_ENABLED === 'true';

// ─── <thinking> block renderer ───────────────────────────────────────────────
//
// Splits assistant content on <thinking>…</thinking> tags and renders each
// segment appropriately: completed thinking blocks as collapsible ThinkingBlock
// components, any open (streaming) block as an active ThinkingBlock, and all
// plain text through the Markdown renderer.

const THINKING_RE = /(<thinking>[\s\S]*?<\/thinking>)/g;
const THINKING_OPEN = '<thinking>';
const THINKING_CLOSE = '</thinking>';

function renderMessageContent(content: string, streaming: boolean): ReactNode {
  // While streaming: detect an unclosed <thinking> tag at the end.
  if (streaming) {
    const lastOpen = content.lastIndexOf(THINKING_OPEN);
    const lastClose = content.lastIndexOf(THINKING_CLOSE);
    if (lastOpen !== -1 && lastOpen > lastClose) {
      const before = content.slice(0, lastOpen);
      const partial = content.slice(lastOpen + THINKING_OPEN.length);
      return (
        <>
          {before.trim() && <Markdown>{before}</Markdown>}
          <ThinkingBlock content={partial} streaming defaultOpen />
        </>
      );
    }
  }

  // Normal path: split completed <thinking> blocks out of the content.
  const parts = content.split(THINKING_RE);
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^<thinking>([\s\S]*?)<\/thinking>$/);
        if (m) {
          return <ThinkingBlock key={i} content={m[1].trim()} />;
        }
        if (part.trim()) {
          return <Markdown key={i}>{part}</Markdown>;
        }
        return null;
      })}
    </>
  );
}

// The AG-UI streaming path (useAgentStream) does not currently thread the
// agent's real observability invocation id (ctx.invocation_id — the id
// observability.invocation_traces rows, and therefore /feedback, key on) onto
// a Message. RUN_STARTED.runId is a different, middleware-minted id the hook
// doesn't even expose. Reading `invocationId` off the message defensively
// here means FeedbackControl lights up for free the moment a future event
// carries the real id — see FeedbackControl.tsx for the full trace.
function answerInvocationId(msg: unknown): string | undefined {
  const id = (msg as { invocationId?: unknown } | null)?.invocationId;
  return typeof id === 'string' && id ? id : undefined;
}

// useAgentStream (realtime-modules) accepts an injectable `fetch` for exactly
// this reason: it's the only hook of ours into the real Response before the
// library collapses a failed POST into a bare `Stream failed: ${status}`
// string with the server's actual body thrown away. This wrapper reads that
// body on a non-ok response and throws a message already built by
// describeTurnError — so `error` downstream carries the real status and the
// real server detail, not a re-derived guess. DEFECTS.md program-owner #5.
//
// AbortError must pass through unchanged: reset()/unmount abort the in-flight
// request on purpose, and the hook specifically skips setting `error` for an
// AbortError — wrapping it into a plain Error would turn a deliberate cancel
// into a spurious "could not reach the agent" banner.
async function agentInvokeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
    throw new Error(describeTurnError(0));
  }
  if (res.ok) return res;
  let bodyText: string | undefined;
  try { bodyText = await res.clone().text(); } catch { /* no body to read — describeTurnError handles undefined */ }
  throw new Error(describeTurnError(res.status, bodyText));
}

interface AgentDef {
  id: string;
  name: string;
  status: string;
  protocol: string;
  model: string;
  tools: string[];
}

interface SessionSummary {
  sessionId: string;
  actorId: string;
  createdAt: string;
  title?: string;
  /**
   * The full transcript for a session started in THIS tab, cached the
   * moment it has real content. `GET /api/sessions/:id/events` returns an
   * empty transcript with no error when the environment has no memory
   * store (dev:mock) — reselecting the session from the rail after "+ New"
   * used to land on a blank starter with no explanation. Restoring from
   * this cache first (see `historyFetch` in InvokePage) means a session
   * this tab actually held always comes back, regardless of the backend;
   * never present on a row that came only from the server.
   */
  messages?: AgentMessage[];
}

// Write/pipeline agents mutate durable state (graph-builder → merge_* Aurora
// upserts, ingestion → sync_knowledge_base, scoring → compute_expertise_scores).
// The backend gates DIRECT invocation of these on the ManageIngest capability
// (routes/agents.ts requireAgentCapability); mirror that here so a caller who
// lacks ManageIngest never sees them as selectable chat targets. Matches the
// several id spellings the runtime cache registers.
const WRITE_AGENT_RE = /(graph[-_]builder|ingestion|scoring)/;
const isWriteAgent = (agentId: string): boolean => WRITE_AGENT_RE.test(agentId.toLowerCase());

export interface SearchConversationAPI {
  transcript: ReactNode;
  messages: AgentMessage[];
  sessions: SessionSummary[];
  sessionsUnavailable: boolean;
  historyUnavailable: boolean;
  isStreaming: boolean;
  streamingText: string;
  sessionId: string | null;
  input: string;
  setInput: (value: string) => void;
  send: (text: string, refs?: SearchRef[], agentId?: string) => void;
  newSession: () => void;
  agents: AgentDef[];
  agentId: string;
  selectAgent: (id: string) => void;
}

function InvokePage({ renderWorkspace, renderAnswerEvidence, contextRefs = [], onSubmitted }: {
  renderWorkspace?: (api: SearchConversationAPI) => ReactNode;
  /** Search: the cited records drawn under an assistant message. */
  renderAnswerEvidence?: (toolCalls?: Array<{ name: string; result?: string }>) => ReactNode;
  contextRefs?: SearchRef[];
  onSubmitted?: (query: string) => void;
} = {}) {
  // Tenant-prefixed: the BFF gateway refuses any channel outside `<tenant>:` (2026-09-29).
  const { roster: peers } = usePresence('orgiq:invoke');
  // `/api/agents` answers `{ agents, degraded?, error? }` — an object, not a
  // bare array, so that a failed ListAgentRuntimes can say so instead of
  // arriving as an empty fleet. Here the fleet only fills a selector; the
  // stream's own error surface covers a broken invoke.
  const { data: agentsResp, error: agentsError, refresh: refreshAgents } =
    useFetch<{ agents: AgentDef[]; degraded?: string }>('/api/agents');
  const agents = agentsResp?.agents;
  /**
   * The roster read failing at all — transport error OR the wire's own
   * `degraded` marker, which `routes/agents.ts` sets from `degradedFields()`
   * when ListAgentRuntimes comes back partial or not at all.
   *
   * The comment above is right that a BROKEN INVOKE surfaces in the stream's
   * own error. It does not cover a roster that arrives EMPTY: the selector is
   * gated on `visibleAgents.length > 1`, so it simply disappears, and
   * `agentsError` was never rendered anywhere on this page — leaving an
   * invitation to "Ask Agent" with nothing to ask and no reason given.
   */
  const rosterFailure = agentsError ?? agentsResp?.degraded ?? null;
  const { can } = useCapabilities();

  // Hide the write agents from the selector unless the caller holds
  // ManageIngest. While capabilities are still loading, can() is false, so the
  // conservative default hides them (better than flashing an option the server
  // will 403). Read agents always stay listed.
  const canIngest = can('ManageIngest');
  const visibleAgents = useMemo(
    () => (canIngest ? agents : agents?.filter((a) => !isWriteAgent(a.id))),
    [agents, canIngest],
  );

  // ?agent=<id> — the chosen agent, distinct from `?agentId=` below (a
  // one-shot arrival param from the Architecture graph / agent detail page
  // that pre-selects and then strips itself). This one keeps reflecting the
  // current selection so a link built from the address bar reopens on the
  // same agent, the way `?session=` reopens the same conversation.
  const [selectedId, setSelectedId] = useUrlState<string>(
    'agent',
    (raw) => raw || 'orgiq-supervisor',
    (v) => (v === 'orgiq-supervisor' ? null : v),
  );
  // A history load that FAILED, kept apart from a conversation that is empty.
  // Auto-resume fires on mount, so an expired cookie or a 500 used to land the
  // user in the "send a message to start" empty state — the app quietly
  // claiming their conversation didn't exist.
  const [historyError, setHistoryError] = useState<
    { sessionId: string; message: string; needsAuth: boolean } | null
  >(null);
  // Set when a *load* (never a fresh session) resolved with zero events —
  // distinct from historyError (a load that failed) and from a genuinely
  // new conversation (which never calls historyFetch at all). Cleared the
  // moment a different load starts, a new session begins, or the cache
  // short-circuit below serves real messages. See the localSessionsRef
  // read inside historyFetch and the render branch near the transcript.
  const [emptyTranscriptSessionId, setEmptyTranscriptSessionId] = useState<string | null>(null);
  // A ref mirror of localSessions (declared below) so historyFetch — a
  // closure handed to the hook once — always reads the LATEST cache rather
  // than whatever was captured at mount.
  const localSessionsRef = useRef<Record<string, SessionSummary>>({});
  const sentAgentRef = useRef<string | null>(null);
  const sentContextRef = useRef<SearchRef[] | null>(null);
  const contextRef = useRef(contextRefs);
  contextRef.current = contextRefs;
  const {
    messages,
    isStreaming,
    streamingText,
    activeToolCalls,
    steps,
    error,
    sessionId,
    sendMessage,
    reset,
    loadHistory,
  } = useAgentStream({
    url: `/api/agents/${selectedId}/invoke`,
    // See agentInvokeFetch above: reads the real response body on failure so
    // a 503/403/etc. reports its actual status and the server's own detail,
    // instead of the library's bare `Stream failed: ${status}`.
    fetch: (input, init) => agentInvokeFetch(sentAgentRef.current ? `/api/agents/${encodeURIComponent(sentAgentRef.current)}/invoke` : input, init),
    buildBody: (message, { sessionId: activeSessionId }) => ({
      message, ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      ...((sentContextRef.current ?? contextRef.current).length ? { selection: { records: sentContextRef.current ?? contextRef.current } } : {}),
    }),
    // Shared canonical fetcher (lib/chatSessions). keepThinking because this
    // page renders <thinking> blocks as collapsible ThinkingBlock sections.
    // On failure we record WHY and re-throw: re-throwing leaves whatever was
    // on screen intact (loadHistory only replaces messages on success) and the
    // banner below explains and offers a retry.
    //
    // A session started in THIS tab is served from the local cache first —
    // never re-fetched — so it restores even when the backend has nothing
    // to say about it (docs/orgiq-journeys/sme/DEFECTS.md #7).
    historyFetch: (sid: string) => {
      const cached = localSessionsRef.current[sid]?.messages;
      if (cached && cached.length > 0) {
        setHistoryError(null);
        setEmptyTranscriptSessionId(null);
        return Promise.resolve(cached);
      }
      return fetchSessionMessages(sid, { keepThinking: true })
        .then((msgs) => {
          setHistoryError(null);
          setEmptyTranscriptSessionId(msgs.length === 0 ? sid : null);
          return msgs;
        })
        .catch((err: unknown) => {
          const e = err instanceof SessionHistoryError ? err : null;
          setEmptyTranscriptSessionId(null);
          setHistoryError({
            sessionId: sid,
            message: e?.message ?? 'Could not load this conversation.',
            needsAuth: Boolean(e?.needsAuth),
          });
          throw err;
        });
    },
  });
  const [input, setInput] = useState('');
  const [suggestionSeed, setSuggestionSeed] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  // The text of the last turn actually sent (not the composer's current
  // value, which is cleared immediately on send) — what Retry resends.
  const lastTurnRef = useRef<string | null>(null);
  // A send failure, distinct from `historyError` (a session LOAD failure,
  // already shown as its own banner above). `error` is also set by a failed
  // loadHistory — the `historyError` guard below skips that case so it is
  // never shown twice. Synced from the hook's `error` rather than set
  // directly, so it clears itself the instant the next send/retry starts
  // (useAgentStream's sendMessage clears `error` before doing anything else)
  // — a failed turn's banner never survives a successful retry, and never
  // becomes a permanent fixture of the transcript. DEFECTS.md program-owner #5.
  const [turnErrorMessage, setTurnErrorMessage] = useState<string | null>(null);
  const {
    data: sessionList,
    error: sessionListError,
    refresh: refreshSessions,
  } = useFetch<{ sessions: SessionSummary[]; memoryUnavailable?: string }>('/api/sessions', 15000);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Session-scoped chat sidebar (feature-flagged via VITE_ORGIQ_CHAT_ENABLED).
  // Channel is `orgiq:session:<sessionId>` when a session is active, otherwise
  // falls back to a generic invoke channel so the hook is never called with an
  // empty string. When CHAT_ENABLED is false the hook still runs (hooks can't
  // be conditional) but the sidebar is not rendered.
  const chatChannel = sessionId ? `orgiq:session:${sessionId}` : 'orgiq:invoke';
  const chat = useChat(chatChannel);

  const selectedAgent = agents?.find(a => a.id === selectedId);

  // Honor deep-links like /invoke?session=<id> from Memory / Sessions pages.
  // Load once on mount (or whenever the param changes), then strip the param
  // so a manual reload doesn't keep re-loading the same session over fresh state.
  useEffect(() => {
    const sid = searchParams.get('session');
    if (!sid || sid === sessionId) return;
    void loadSession(sid);
    if (renderWorkspace) return;
    const next = new URLSearchParams(searchParams);
    next.delete('session');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('session')]);

  // Honor /iq/invoke?agentId=<id> — the "invoke this agent" links from the
  // Architecture graph and the agent detail page. Pre-select that agent for a
  // fresh conversation and strip the param. Without this the links silently
  // opened the default supervisor, so "talk to the search agent" never did.
  //
  // Three id spellings reach this link: the catalog slug (orgiq-supervisor),
  // the underscore runtime name (orgiq_supervisor) and the opaque AgentCore
  // runtime id with its 10-char suffix — but `/api/agents` (and this page's
  // <Select>) only ever spells `a.id` the third way. Setting `selectedId`
  // straight to whatever arrived used to leave the picker matching nothing —
  // `agents?.find(a => a.id === selectedId)` came back undefined and the
  // dropdown showed no selection at all, even though the POST still worked
  // (the server resolves all three spellings). Wait for the fleet list, then
  // resolve through canonicalKey the same way AgentFlowPage does, so the
  // picker actually shows what got selected. If the fleet fetch itself is
  // down, fall back to the raw id rather than hang — asking is still better
  // than never trying.
  useEffect(() => {
    const aid = searchParams.get('agentId');
    if (!aid) return;
    if (!agents && !agentsError) return; // still loading — resolve once the fleet list is in
    const match = agents?.find(
      (a) => a.id === aid || a.name === aid || canonicalKey(a.id) === canonicalKey(aid) || canonicalKey(a.name) === canonicalKey(aid),
    );
    setSelectedId(match?.id ?? aid);
    forgetSession('invoke'); // agent changed — don't resume a different agent's session
    const next = new URLSearchParams(searchParams);
    next.delete('agentId');
    next.set('agent', match?.id ?? aid);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('agentId'), agents, agentsError]);

  // The `?prompt=`(+`?focus=`) deep-link is handled further down, once the
  // org-graph fetch (`graph`) it needs to resolve `focus` ids into names is
  // in scope — see the effect right after that `useFetch` call.

  // Auto-resume: with no deep-link, reload lands back in the last conversation
  // instead of a fresh one (transcript restored from AgentCore Memory). A
  // ?prompt= deep-link is a fresh question, so it wins over resuming too.
  useEffect(() => {
    if (searchParams.get('session') || searchParams.get('prompt') || searchParams.get('agentId') || renderWorkspace) return; // deep-link wins
    const saved = recallSession('invoke');
    if (saved) void loadSession(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active session whenever the hook mints or switches one.
  // The URL is read from `window.location`, not `searchParams`: react-router's
  // functional `setSearchParams` hands back the params of the render that made
  // the callback, and this effect runs in the render where the hook minted the
  // session — before the navigation `onSubmitted` just issued (`q`, `tab=answer`)
  // has landed in `searchParams`. Building from that stale copy replaced the
  // URL with `?session=…` alone, so a question sent from the Results view
  // stayed on Results with its answer hidden.
  useEffect(() => {
    if (sessionId) rememberSession('invoke', sessionId);
    if (renderWorkspace && sessionId) {
      const next = new URLSearchParams(window.location.search);
      if (!next.get('session')) { next.set('session', sessionId); setSearchParams(next, { replace: true }); }
    }
  }, [sessionId]);

  useEffect(() => {
    if (!isStreaming) {
      const t = setTimeout(() => refreshSessions(), 1500);
      return () => clearTimeout(t);
    }
  }, [isStreaming, refreshSessions]);

  // Auto-scroll to bottom whenever new content arrives during streaming
  useEffect(() => {
    if (isStreaming) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [streamingText, activeToolCalls, isStreaming]);

  // True from the moment a failed turn is re-sent until the next fresh turn:
  // the transcript then shows the retried "you" bubble in place of the
  // failed one instead of both (see collapseFailedTurn).
  const [retried, setRetried] = useState(false);

  // Every path that sends a turn goes through this, so `lastTurnRef` is set
  // once rather than at each call site. It was set ONLY in the composer's
  // handler, which made Retry a dead button for a work card, a starter, a
  // `?prompt=` deep link or an "Ask about them" chip — an enabled control
  // that fired no request — and left `collapseFailedTurn` inert on those
  // turns too, since it reads the same ref.
  const send = useCallback((text: string, refs?: SearchRef[], agentId?: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    sentAgentRef.current = agentId ?? (renderWorkspace ? selectedId : null);
    sentContextRef.current = refs ?? contextRef.current;
    onSubmitted?.(trimmed);
    lastTurnRef.current = trimmed;
    setRetried(false);
    void sendMessage(trimmed);
  }, [isStreaming, sendMessage, onSubmitted, renderWorkspace, selectedId]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    setHistoryError(null); // a new turn supersedes a stale load failure
    send(input);
    setInput('');
  };

  // The failed-turn banner's action: re-send the EXACT text that failed, not
  // whatever (if anything) is currently sitting in the composer.
  const handleRetry = useCallback(() => {
    const text = lastTurnRef.current;
    if (!text || isStreaming) return;
    setRetried(true);
    void sendMessage(text);
  }, [isStreaming, sendMessage]);

  // Mirror the hook's `error` into a turn-failure banner, skipping the case
  // already covered by `historyError` above (a session LOAD failure, not a
  // send failure — see the historyFetch option's re-throw). This state (not
  // `error` directly) is what renders, so it goes stale — and clears — the
  // moment the next sendMessage call resets `error` to null, whether that
  // call is a fresh turn or a Retry of this one.
  useEffect(() => {
    if (!error || error === historyError?.message) { setTurnErrorMessage(null); return; }
    setTurnErrorMessage(error);
  }, [error, historyError]);

  // Library hook's loadHistory(sid) handles the fetch via the historyFetch
  // option above (configured at the useAgentStream() call site).
  async function loadSession(sid: string) {
    await loadHistory(sid);
  }

  // The server session list (GET /api/sessions, from AgentCore Memory / the
  // no-Aurora mock) lags real time — sometimes by a poll interval, sometimes
  // forever when the backing memory store isn't configured. Waiting on it
  // meant a brand-new (or just-resumed) conversation showed "No sessions yet"
  // in the rail for the whole session, even with turns on screen — DEFECT 5,
  // docs/orgiq-journeys/member/DEFECTS.md. So the active session is tracked
  // locally the moment the hook mints or resumes it, titled from the first
  // user turn, and merged over the server list — the row (and its
  // `aria-current`) appears immediately regardless of what the backend has
  // caught up to.
  const [localSessions, setLocalSessions] = useState<Record<string, SessionSummary>>({});
  // Keep the ref `historyFetch` reads in sync, without adding it as a
  // useAgentStream dependency the hook may or may not honor after mount.
  useEffect(() => { localSessionsRef.current = localSessions; }, [localSessions]);
  useEffect(() => {
    if (!sessionId) return;
    const firstUser = messages.find((m) => m.role === 'user')?.content;
    setLocalSessions((prev) => {
      const existing = prev[sessionId];
      // No row until the session has a first turn: "+ New" used to mint an
      // "Untitled session" rail row with a timestamp before anything was
      // said, so the rail counted conversations that did not exist yet.
      if (!existing && !firstUser) return prev;
      const title = firstUser ? firstUser.slice(0, 60) : existing?.title;
      // Cache real content once it exists; never overwrite a cached
      // transcript with an empty one (the "not stored here" reload path
      // sets `messages` to `[]` for a session this tab already holds).
      const nextMessages = messages.length > 0 ? messages : existing?.messages;
      if (existing && existing.title === title && existing.messages === nextMessages) return prev;
      return {
        ...prev,
        [sessionId]: {
          sessionId,
          actorId: existing?.actorId ?? 'me',
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          title,
          messages: nextMessages,
        },
      };
    });
  }, [sessionId, messages]);

  // Shared by the sidebar "+ New" button and the "transcript isn't stored
  // here" empty state's action — both mean the same thing: stop resuming,
  // start clean.
  const startNewSession = useCallback(() => {
    forgetSession('invoke');
    setHistoryError(null);
    setEmptyTranscriptSessionId(null);
    reset();
  }, [reset]);

  const sessions = useMemo(() => {
    const server = sessionList?.sessions ?? [];
    const merged = server.map((s) => {
      const local = localSessions[s.sessionId];
      return local?.title && !s.title ? { ...s, title: local.title } : s;
    });
    for (const local of Object.values(localSessions)) {
      if (!merged.some((s) => s.sessionId === local.sessionId)) merged.unshift(local);
    }
    return merged;
  }, [sessionList, localSessions]);
  // GET /api/sessions is session-guarded, so an expired cookie 401s. Rendering
  // that as "No sessions yet" would tell the user their conversations are gone
  // when they are simply signed out. Only claim "none" when the call SUCCEEDED
  // and returned none.
  const sessionsUnavailable = Boolean(sessionListError) && !sessionList;
  const sessionsNeedAuth = /\b401\b|\b403\b/.test(sessionListError ?? '');

  // One supervisor turn can stream as several adjacent assistant messages
  // (the hook flushes at every TEXT_MESSAGE_END) — merge them so the role
  // label renders once per turn instead of once per fragment.
  const displayMessages = useMemo(
    () => coalesceAssistantMessages(collapseFailedTurn(messages, lastTurnRef.current, retried)),
    [messages, retried],
  );

  // Contextual follow-up suggestions derived from conversation + refreshed on demand
  // Org-graph enrichment: which *real* people the answer named. Matched exactly
  // (word-boundary hits against actual graph people), so the "People in this
  // answer" panel and the follow-ups are accurate — unlike guessing at any two
  // capitalized words. Harvested from the retired dedicated search page.
  const { data: graph, error: graphFetchError } = useFetch<GraphEntities>('/api/graph/entities');

  // Honor deep-links like /iq/invoke?prompt=<slug-or-text>[&focus=<id1,id2,…>]
  // — the subnav "Suggested" searches ("Who knows X?", "Decisions about X"…)
  // AND Explore's "Open in Ask →" link (which adds `focus`) both point here.
  // Resolve a known slug to its full prompt, else send the text verbatim; when
  // `focus` ids are present, name the people they refer to and append "About:
  // <names>" so the first turn carries who Explore was showing — the
  // simplest honest hand-off, no new middleware. Names resolve from `graph`
  // (fetched above), so this waits one render for that fetch to settle
  // before firing rather than sending an unfleshed-out prompt; a fetch that
  // fails (`graphFetchError`) is not worth blocking on, so the prompt still
  // sends, just without the names. Runs once, then strips both params so a
  // reload doesn't re-fire it.
  useEffect(() => {
    const p = searchParams.get('prompt');
    if (!p) return;
    const focusParam = searchParams.get('focus');
    const focusIds = focusParam ? focusParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (focusIds.length > 0 && !graph && !graphFetchError) return; // wait for names to resolve
    let resolved = PROMPT_SLUGS[p] ?? p;
    if (focusIds.length > 0 && graph) {
      const names = focusIds
        .map((id) => graph.nodes.find((n) => n.id === id)?.name)
        .filter((n): n is string => Boolean(n));
      if (names.length > 0) resolved = `${resolved}\n\nAbout: ${names.join(', ')}`;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('prompt');
    next.delete('focus');
    if (renderWorkspace) { next.set('q', p); next.set('tab', 'answer'); }
    setSearchParams(next, { replace: true });
    void sendMessage(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('prompt'), searchParams.get('focus'), graph, graphFetchError]);

  // ── The Find-Help merge: Ask IS the org search ────────────────────────────
  //
  // Two data sources fold the retired /iq/help surface into this chat:
  //
  //  - ask-suggestions: the caller's own ranked work, re-voiced as questions
  //    ("who can unblock X?"). They fill the empty state, so starting a
  //    conversation never means facing a blank box disconnected from your
  //    sprint. Supervisor-only — it is the agent that searches the org.
  //
  //  - graph/help: evidence-ranked people for the LAST question asked. The
  //    chat answers in prose; the rail beside it shows the same people as
  //    evidence — matched skills, documents, initiatives — with no scores.
  const { data: askSuggData } = useFetch<{ suggestions: AskSuggestion[] }>(
    selectedId.endsWith('supervisor') ? '/api/work/ask-suggestions' : null,
  );
  const askSuggestions = askSuggData?.suggestions ?? [];
  const lastAsked = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'user')?.content ?? '',
    [messages],
  );
  const { data: helpData } = useFetch<HelpPeopleResponse>(
    lastAsked ? `/api/graph/help?q=${encodeURIComponent(lastAsked)}` : null,
  );
  const helpPeople = (lastAsked ? helpData?.people ?? [] : []).slice(0, 3);
  const sortedPeople = useMemo(() => sortPeople(graph?.nodes), [graph]);
  const mentionRegexes = useMemo(() => buildMentionRegexes(sortedPeople), [sortedPeople]);
  const lastAssistant = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant'),
    [messages],
  );
  const mentionedPeople = useMemo(
    () => findMentionedPeople([lastAssistant?.content ?? '', streamingText].join(' '), sortedPeople, mentionRegexes),
    [lastAssistant, streamingText, sortedPeople, mentionRegexes],
  );

  const suggestions = useMemo(
    () => buildSuggestions(messages, selectedId, suggestionSeed, mentionedPeople),
    [messages, selectedId, suggestionSeed, mentionedPeople],
  );

  // A follow-up chip is the same affordance as the work-suggestion cards
  // above it (onSelect={() => send(sg.prompt)}) — clicking either should
  // send the turn, not just stage it in the composer. `send` already guards
  // `isStreaming`, so a chip clicked mid-stream is a no-op rather than a
  // race with the in-flight turn.
  const handleSuggestion = useCallback((s: string) => {
    send(s);
  }, [send]);

  const transcript = (
        <Stack
          gap="md"
          role="log"
          aria-live="polite"
          aria-atomic="false"
          aria-relevant="additions text"
          className="flex-1 min-h-0 overflow-auto mb-4"
        >
          {/* A transcript we could not load is not an empty conversation. Say
              which one it is, and offer the retry — never the "start a new
              conversation" prompt over the top of someone's history. */}
          {historyError && (
            <Banner variant="warning" title="Couldn’t load this conversation.">
              <Inline align="center" justify="between" gap="md" wrap>
                <T wrap>{historyError.message} Nothing has been deleted — this is a load failure, not an empty conversation.</T>
                <Button size="sm" variant="secondary" onClick={() => { void loadSession(historyError.sessionId); }}>
                  {historyError.needsAuth ? 'Try again' : 'Retry'}
                </Button>
              </Inline>
            </Banner>
          )}
          {/* Selecting a session that this reload's backend has nothing to
              say about is not the same as an empty conversation — reading
              it that way silently hid real transcripts behind the "start
              asking" starter. docs/orgiq-journeys/sme/DEFECTS.md #7. */}
          {sessionId && emptyTranscriptSessionId === sessionId && messages.length === 0 && !isStreaming && !historyError && (
            <EmptyState
              title="This conversation's transcript isn't stored in this environment"
              description="The session exists, but this environment has no memory store to read its turns back from — nothing was deleted."
              actionLabel="Start a new one"
              onAction={startNewSession}
            />
          )}
          {(!sessionId || emptyTranscriptSessionId !== sessionId) && messages.length === 0 && !isStreaming && !historyError && (
            <Stack gap="md" className="p-10 text-text-tertiary items-center text-center">
              {rosterFailure && !selectedAgent ? (
                <UnavailableNotice
                  error={rosterFailure}
                  what="the agent fleet"
                  source="Agents are listed from AgentCore ListAgentRuntimes"
                  onRetry={() => void refreshAgents()}
                />
              ) : (
                <>
                  <T className="text-[18px]">Ask {selectedAgent?.name ?? 'Agent'}</T>
                  <T className="text-[13px]">
                    Ask the org anything — who can help, who knows what, what's been decided.
                  </T>
                </>
              )}
              {/* The caller's own board, re-voiced as questions. Clicking sends
                  immediately — this is chat, and a suggested question you still
                  have to re-submit is a form pretending to be a conversation. */}
              {askSuggestions.length > 0 && (
                <Stack gap="sm" className="w-full items-stretch">
                  <SectionLabel as="div">From your work</SectionLabel>
                  {/* auto-fit, not auto-fill, and a 260px floor: four cards at
                      220px packed into 233px each and left ~350px of the
                      column empty beside them, which is where every reason
                      line lost the initiative's name to an ellipsis. */}
                  {/* items-stretch: `Inline` sets `items-center`, which survives the
                      `grid` override and stops grid items filling their row — a short
                      card measured 115px against its row-mates' 135px and floated. */}
                  <Inline
                    gap="sm"
                    wrap
                    className="grid w-full grid-cols-[repeat(auto-fit,minmax(260px,1fr))] items-stretch"
                  >
                    {askSuggestions.slice(0, 4).map((sg) => (
                      <SuggestionCard
                        key={sg.id}
                        // No `label` pill: it showed the kind ("blocked") beside a
                        // reason line that now says the same word, so the card read
                        // "BLOCKED  Blocked". The reason carries it.
                        reason={sg.reason}
                        // The initiative rides its own field rather than the
                        // tail of the reason line: `context` is the card's
                        // "where it points" slot, and it is not truncated.
                        context={sg.initiativeName}
                        title={sg.title}
                        actionLabel="Ask"
                        onSelect={() => send(sg.prompt)}
                      />
                    ))}
                  </Inline>
                </Stack>
              )}
              <QuickPromptGrid
                prompts={quickPromptsFor(selectedId).map(p => ({ label: p.label, hint: p.prompt }))}
                onSelect={(label) => {
                  const found = quickPromptsFor(selectedId).find(p => p.label === label);
                  if (found) send(found.prompt);
                }}
                title={askSuggestions.length > 0 ? 'Or try:' : 'Try asking:'}
                // Full width, like the work cards above it — the starters
                // used to sit in a 525px block under a 964px card row.
                className="w-full"
              />
            </Stack>
          )}
          {displayMessages.map(msg => {
            // Derive provenance from the turn's tool calls (thinking blocks are
            // kept — renderMessageContent handles those), strip the model's own
            // unverifiable citations out of the prose, and summarize what the
            // turn actually did.
            const { cleaned, sources, provenance } = msg.role === 'assistant'
              ? deriveSources({ content: msg.content, toolCalls: msg.toolCalls })
              : { cleaned: msg.content, sources: [], provenance: undefined };
            return (
              <Stack gap="none" key={msg.id}>
                <MessageBubble
                  role={msg.role}
                  content={cleaned}
                  // One channel for tool-call provenance: the friendly label
                  // (toolCallSummary's FRIENDLY map) IS the pill name, rather
                  // than a raw tool id echoed here AND a second, redundant
                  // plain-text summary line below the bubble.
                  toolCalls={(msg.toolCalls ?? []).map(tc => ({
                    id: tc.id,
                    name: tc.name === 'search_context' ? 'Search context' : friendlyToolName(tc.name),
                    done: Boolean(tc.result),
                  }))}
                  agentName={renderWorkspace ? 'Org Assistant' : selectedAgent?.name ?? 'Agent'}
                  renderMarkdown={(content) => renderMessageContent(renderWorkspace ? linkSearchCitations(content, readSearchEvidence(msg.toolCalls)) : content, false)}
                />
                {renderWorkspace && msg.role === 'assistant' && renderAnswerEvidence?.(msg.toolCalls)}
                {(!renderWorkspace || sources.some(source => source.kind !== 'graph') || !readSearchEvidence(msg.toolCalls).length) && <SourceChips sources={sources} {...(provenance ? { provenance } : {})} />}
                {msg.role === 'assistant' && (
                  <FeedbackControl invocationId={answerInvocationId(msg)} />
                )}
              </Stack>
            );
          })}
          {/* Named run phases (STEP_STARTED/STEP_FINISHED) — transient by
              design: the hook resets `steps` on every RUN_STARTED, so this
              strip is only ever shown while the current turn is in flight
              and simply disappears once the turn finishes rather than
              lingering on the finished bubble. */}
          {isStreaming && steps.length > 0 && (
            <WorkflowStepper
              size="sm"
              steps={steps.map((s, i) => ({
                step: i + 1,
                label: s.name,
                done: s.status === 'done',
                active: s.status === 'running',
              }))}
            />
          )}
          {isStreaming && (
            <MessageBubble
              role="assistant"
              content={extractSources(streamingText).cleaned}
              toolCalls={activeToolCalls.map(tc => ({
                id: tc.id,
                name: tc.name === 'search_context' ? 'Search context' : friendlyToolName(tc.name),
                done: tc.done,
                args: tc.args,
              }))}
              streaming
              agentName={renderWorkspace ? 'Org Assistant' : selectedAgent?.name ?? 'Agent'}
              renderMarkdown={(content) => renderMessageContent(content, true)}
            />
          )}
          {/* A failed SEND (as opposed to a failed session LOAD, covered by
              the historyError banner above): the real status and server
              detail via describeTurnError (agentInvokeFetch), with a Retry
              that resends the exact turn that failed. Never rendered as a
              chat bubble — it lives in this local state, not `messages`, so
              nothing here can linger on as a dead assistant bubble once a
              retry succeeds (DEFECTS.md program-owner #5). */}
          {turnErrorMessage && (
            <Banner variant="error" title="That turn failed.">
              <Inline align="center" justify="between" gap="md" wrap>
                <T wrap>{turnErrorMessage}</T>
                <Button size="sm" variant="secondary" disabled={isStreaming} onClick={handleRetry}>
                  Retry
                </Button>
              </Inline>
            </Banner>
          )}
          <div ref={bottomRef} />
        </Stack>
  );
  if (renderWorkspace) return renderWorkspace({
    transcript, messages: displayMessages, sessions, sessionsUnavailable,
    historyUnavailable: Boolean(sessionList?.memoryUnavailable),
    isStreaming, streamingText, sessionId: sessionId ?? null, input, setInput, send,
    newSession: startNewSession, agents: visibleAgents ?? [], agentId: selectedId,
    selectAgent: id => { setSelectedId(id); startNewSession(); },
  });

  return (
    <ViewportFillRegion bottomGap={0} data-testid="ask-workspace">
      <Stack gap="none" className="h-full min-h-0 bg-surface" data-shell-flush>
        <SubNavLayout
          title="Ask"
          storageKey="ask-sessions"
          railLabel="Ask navigation"
          contentAs="section"
          contentLabel="Conversation"
          items={sessions.map(s => ({
            path: `/iq/invoke?session=${encodeURIComponent(s.sessionId)}`,
            label: s.title || 'Untitled session',
            hint: new Date(s.createdAt).toLocaleString(),
          }))}
          railHeader={
              <Stack gap="sm">
                <Inline justify="between" align="center" gap="sm">
                  <SectionLabel>Conversations</SectionLabel>
                  <PresenceAvatarGroup peers={peers} />
                </Inline>
                <Stack gap="sm">
                  {/* Agent selector — only shown when multiple agents are available */}
                  {visibleAgents && visibleAgents.length > 1 && (
                    <Select
                      value={selectedId}
                      onChange={e => {
                        setSelectedId(e.target.value);
                        // sessions are agent-scoped — don't resume across agents
                        startNewSession();
                      }}
                      aria-label="Select agent"
                      size="sm"
                      className="w-full min-w-0"
                      options={visibleAgents.map(a => ({ value: a.id, label: a.name }))}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={startNewSession}
                    title="New session"
                    className="whitespace-nowrap"
                  >
                    New session
                  </Button>
                </Stack>
                {sessionsUnavailable && (
                  <Stack gap="xs" role="status">
                    <T className="text-xs text-text-secondary">{sessionsNeedAuth
                      ? 'Sign in to see your conversations.'
                      : 'Conversations unavailable.'}</T>
                    <Button size="sm" variant="secondary" onClick={() => refreshSessions()}>Retry</Button>
                  </Stack>
                )}
                {!sessionsUnavailable && sessions.length === 0 && (
                  <T className="text-xs text-text-tertiary">
                    {sessionList?.memoryUnavailable
                      ? 'Session history is unavailable until memory is configured.'
                      : 'No sessions yet.'}
                  </T>
                )}
              </Stack>
          }
          renderNavItem={(item, body) => {
            const selected = new URLSearchParams(item.path.split('?')[1]).get('session') === sessionId;
            return <Link to={item.path} aria-current={selected ? 'page' : undefined}
              className={selected ? activeNavItemClassName : inactiveNavItemClassName}>{body}</Link>;
          }}
        >
          <Stack gap="none" className="h-full min-h-0 min-w-0">
            <ScopeHeader variant="crumbs" breadcrumbs={[
              { label: 'Org' }, { label: 'Ask' },
              { label: sessions.find(s => s.sessionId === sessionId)?.title || (sessionId ? 'Conversation' : 'New session') },
            ]} />
            <Inline gap="none" wrap={false} align="stretch" className="flex-1 min-h-0">
      {/* Chat area */}
      {/* min-h-0 on both: without it the flex column grows to its content
          and the transcript's first turn scrolls up out of the scroll
          container instead of scrolling inside it. */}
      <Stack gap="none" className="flex-1 min-h-0 px-6 pb-6 min-w-0">
        {transcript}

        {/* People in this answer — the org-graph names the response actually
            mentioned, each a jump into the graph, with the context (title ·
            department) an org search should carry rather than a bare name
            pill. Full ExpertCard is a "why them" card (avatar, skill
            evidence, an "ask" footer) built for the 1-3-wide evidence rail
            (see "People with evidence" below) — dropped inline here for up
            to 8 mentions it would tower over the transcript, so this reuses
            the same EntityCell + MetaLine pattern other compact rows in the
            portal use for a name plus its meta line. */}
        {mentionedPeople.length > 0 && (
          <Stack gap="xs" className="mb-2">
            <SectionLabel>People in this answer</SectionLabel>
            <Inline wrap align="stretch" gap="xs">
              {mentionedPeople.slice(0, 8).map((p) => (
                <Link
                  key={p.id}
                  to={`/iq/explore?focus=${encodeURIComponent(p.id)}`}
                  title={`Show ${p.name} in the org graph`}
                  className="no-underline"
                >
                  <Stack
                    gap="none"
                    className="min-w-0 max-w-[200px] rounded-md border border-border px-2.5 py-1.5 hover:border-border-emphasis hover:bg-surface-hover transition-colors"
                  >
                    <EntityCell label={p.name} />
                    <MetaLine items={[p.title, p.department]} size="xs" tone="tertiary" />
                  </Stack>
                </Link>
              ))}
            </Inline>
            {mentionedPeople.length > 1 && (
              <Link
                to={`/iq/explore?focus=${mentionedPeople.map((p) => encodeURIComponent(p.id)).join(',')}`}
                className="text-[12px] font-semibold text-primary no-underline hover:underline self-start"
              >
                Show all {mentionedPeople.length} in Explore →
              </Link>
            )}
          </Stack>
        )}

        {/* Suggested search bubbles — shown when conversation has messages */}
        {messages.length > 0 && !isStreaming && suggestions.length > 0 && (
          <Stack gap="none" className="mb-2">
            <FollowUpChips
              suggestions={suggestions}
              onSelect={handleSuggestion}
              onRefresh={() => setSuggestionSeed(k => k + 1)}
            />
          </Stack>
        )}

        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={handleSend}
          disabled={isStreaming}
          placeholder={`Ask ${selectedAgent?.name ?? 'agent'}...`}
        />
      </Stack>

      {/* People with evidence — the Find-Help view, folded into the chat.
          The answer names people in prose; this rail shows WHY them, from the
          org graph: matched skills, the documents behind them, where they
          spend their time. Score-free by design (ViewOrgChart tier). Only
          rendered when the last question actually matched someone. */}
      {helpPeople.length > 0 && (
        <Stack
          as="aside"
          aria-label="People with evidence"
          gap="sm"
          className="w-[280px] shrink-0 border-l border-border p-3.5 overflow-y-auto"
        >
          <SectionLabel>People with evidence</SectionLabel>
          {helpPeople.map((p) => (
            <ExpertCard
              key={p.id}
              name={p.name}
              title={p.title}
              subtitle={p.department}
              matchedSkills={p.matchedSkills}
              otherSkills={p.otherSkills}
              contexts={p.contexts}
              evidence={p.documents.map((d) => ({
                id: d.id,
                title: d.title,
                source: d.source,
                ...(d.sourceUri ? { href: d.sourceUri } : {}),
              }))}
              askLabel="Ask about them"
              onAsk={() => sendMessage(`Tell me about ${p.name}'s work related to "${lastAsked}" — what they've done, and whether they're the right person to approach.`)}
              onOpen={() => navigate(`/iq/explore?focus=${encodeURIComponent(p.id)}`)}
            />
          ))}
        </Stack>
      )}

      {/* Session chat sidebar — shown when VITE_ORGIQ_CHAT_ENABLED=true and a session is active */}
      {CHAT_ENABLED && sessionId && (
        <Stack as="aside" gap="none" className="w-[300px] shrink-0 border-l border-border">
          <SectionLabel as="div" className="px-3.5 py-2.5 border-b border-border">
            Session Chat
          </SectionLabel>
          <Stack gap="none" className="flex-1 overflow-hidden">
            <ChatPanel
              messages={chat.messages.map(m => ({
                id: m.id,
                clientId: m.clientId,
                content: m.message,
                timestamp: m.timestamp,
                displayName: (m.metadata?.displayName as string | undefined) ?? m.clientId,
              }))}
              onSend={chat.sendMessage}
            />
          </Stack>
        </Stack>
      )}
            </Inline>
          </Stack>
        </SubNavLayout>
      </Stack>
    </ViewportFillRegion>
  );
}

interface QuickPrompt {
  label: string;
  prompt: string;
  badge?: string;
  badgeColor?: string;
}

interface AskSuggestion {
  id: string;
  kind: string;
  reason: string;
  title: string;
  prompt: string;
  initiativeName: string;
}

interface HelpPeopleResponse {
  people: Array<{
    id: string;
    name: string;
    title: string;
    department: string;
    matchedSkills: Array<{ name: string; strength: number }>;
    otherSkills: string[];
    contexts: string[];
    documents: Array<{ id: string; title: string; source: string; sourceUri: string | null }>;
  }>;
}

// Deep-link prompt slugs — the subnav "Suggested" searches link here as
// /iq/invoke?prompt=<slug>. Kept short in the URL and resolved to a full,
// org-graph-aware prompt so a click actually asks a real question. An unknown
// slug falls through to being sent verbatim (so ?prompt=<free text> also works).
const PROMPT_SLUGS: Record<string, string> = {
  'who-knows': 'Who in the organization has the deepest expertise in Kubernetes? Use the search sub-agent to query the graph.',
  'decisions': 'What significant platform decisions have been made recently, and who made them?',
  'who-works-on': 'Who works on the authentication service, and what are their roles?',
  'compare': 'Compare the two people with the strongest platform expertise, side by side.',
};

// Per-agent quick-prompt suggestions. The Browse 🌐 entry on the search agent
// is the discoverable doorway into the fetch_web_page tool we added earlier —
// the agent will pick it up because of the prompt's wording.
function quickPromptsFor(agentId: string): QuickPrompt[] {
  if (agentId.endsWith('search')) {
    return [
      { label: 'Browse a webpage', badge: '🌐', badgeColor: 'var(--color-info)', prompt: 'Use the fetch_web_page tool to load https://example.com and tell me the page title and the first 200 characters of body text.' },
      { label: 'Live news scrape', badge: '🌐', badgeColor: 'var(--color-info)', prompt: 'Browse https://news.ycombinator.com and summarize the top 3 stories with their points and titles.' },
      { label: 'Find Kubernetes experts', prompt: 'Who in the org has the most Kubernetes expertise? Use query_graph to find people with that skill.' },
      { label: 'Team breakdown', prompt: 'List the size of each team using a SQL query on team_memberships.' },
    ];
  }
  if (agentId.endsWith('scoring')) {
    return [
      { label: 'Top 10 by composite', prompt: 'Show the top 10 people by composite score across all teams.' },
      { label: 'Run Python sandbox', badge: '🐍', badgeColor: 'var(--color-success)', prompt: 'Use run_in_sandbox to execute: import statistics; nums=[12,47,23,91,56,34,78,19,65,88]; print(f"mean={statistics.mean(nums):.2f}, stdev={statistics.stdev(nums):.2f}")' },
    ];
  }
  if (agentId.endsWith('advisor')) {
    return [
      { label: 'Pairing recommendations', prompt: 'Recommend two cross-team pairings that would strengthen the org. Explain the rationale.' },
      { label: 'Skill gap analysis', prompt: 'What are the biggest skill gaps in the org? Identify areas where we lack depth.' },
    ];
  }
  if (agentId.endsWith('supervisor')) {
    return [
      { label: 'Find an expert', prompt: 'Who is the best person to talk to about scaling Kubernetes? Use the search sub-agent.' },
      { label: 'Strategic question', prompt: 'What should our hiring priorities be for Q3? Use the advisor sub-agent.' },
      { label: 'Test the guardrail', badge: '🛡', badgeColor: 'var(--color-danger)', prompt: 'What is Raj Mehta\'s exact salary in dollars?' },
    ];
  }
  return [
    { label: 'Capabilities check', prompt: 'What can you help me with?' },
  ];
}

// ─── Contextual suggestion engine ────────────────────────────────────────────
//
// Derives short follow-up bubbles from the last assistant message. On refresh
// the seed rotates through a pool of agent-specific + org-graph queries.
// No LLM call — purely client-side so it's instant and free.

// Minimal shape needed for suggestion building (compatible with realtime-modules Message)
type SuggestionMessage = { role: 'user' | 'assistant'; content: string };

const SUPERVISOR_POOL = [
  'Who are the top Kubernetes experts?',
  'Which teams have the most cross-team collaboration?',
  'What skill gaps exist in Platform Engineering?',
  'Who should I pair with for a security audit?',
  'Show all escalated decisions this week',
  'Who owns the most critical in-progress work items?',
  'Find people with both Rust and distributed-systems skills',
  'Which projects are at risk of missing their deadline?',
  'Summarize what the Data Platform team shipped this month',
  'Who is the best person to review my Kafka PR?',
];

const SEARCH_POOL = [
  'Who has the deepest expertise in Kubernetes?',
  'List all people with Python AND AWS skills',
  'Find the top 5 engineers in the Data Platform team',
  'Which team has the most ML expertise?',
  'Who worked on the last observability incident?',
  'Who are the go-to people for React performance?',
  'Find engineers with both Terraform and Go experience',
  'Who has the highest PageRank in the org graph?',
  'Which department has the most senior engineers?',
];

const SCORING_POOL = [
  'Show top 10 by composite score',
  'Who has risen the most in expertise score this quarter?',
  'List the most influential engineers by PageRank',
  'Which team has the highest average expertise score?',
  'Show engineers with high influence but low formal seniority',
  'Find people with expertise score > 80 in Kubernetes',
];

const ADVISOR_POOL = [
  'Recommend two cross-team pairings that build org resilience',
  'What are the biggest skill gaps in the organization?',
  'Who is at risk of becoming a single-point-of-failure expert?',
  'Which teams should collaborate more based on project overlap?',
  'What hiring priorities would most strengthen the org graph?',
  'Who could mentor junior engineers in distributed systems?',
];

function poolFor(agentId: string): string[] {
  if (agentId.endsWith('search'))   return SEARCH_POOL;
  if (agentId.endsWith('scoring'))  return SCORING_POOL;
  if (agentId.endsWith('advisor'))  return ADVISOR_POOL;
  return SUPERVISOR_POOL;
}

function buildSuggestions(
  messages: SuggestionMessage[], agentId: string, seed: number, mentionedPeople: GraphPerson[] = [],
): string[] {
  const pool = poolFor(agentId);

  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const content = lastAssistant?.content ?? '';

  // Contextual follow-ups from the *real* org-graph people the answer named —
  // an exact word-boundary match against actual people, not a guess at any two
  // capitalized words (which used to surface "Source Organization" as a person).
  const contextual = generateFollowUps(content, mentionedPeople).slice(0, 3);

  // Build final list: contextual first, then rotate through pool
  const offset = seed % Math.max(pool.length - 4, 1);
  const fromPool = [
    ...pool.slice(offset, offset + 4),
    ...pool.slice(0, Math.max(0, 4 - (pool.length - offset))),
  ].slice(0, 4);

  const combined = [...contextual, ...fromPool];
  // Deduplicate and limit to 5
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of combined) {
    if (!seen.has(s) && out.length < 5) { seen.add(s); out.push(s); }
  }
  return out;
}

export default InvokePage;
