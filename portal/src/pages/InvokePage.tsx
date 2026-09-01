import { useEffect, useRef, useState, useMemo, useCallback, type ReactNode } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router';
import { useAgentStream } from '@connorhoehnslalom/realtime-modules/agent-streaming/client';
import type { Message as AgentMessage } from '@connorhoehnslalom/realtime-modules/agent-streaming/client';
import {
  ChatComposer,
  ExpertCard,
  MessageBubble,
  QuickPromptGrid,
  FollowUpChips,
  SuggestionCard,
  ThinkingBlock,
} from '@connorhoehnslalom/ui-components/shared';
import { ChatPanel } from '@connorhoehnslalom/ui-components/social';
import { useFetch } from '../hooks/useFetch';
import { Markdown } from '../components/Markdown';
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
import { summarizeToolCalls } from '../components/chat/toolCallSummary';
import { coalesceAssistantMessages } from '../components/chat/coalesceMessages';
import { FeedbackControl } from '../components/chat/FeedbackControl';

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
}

// Write/pipeline agents mutate durable state (graph-builder → merge_* Aurora
// upserts, ingestion → sync_knowledge_base, scoring → compute_expertise_scores).
// The backend gates DIRECT invocation of these on the ManageIngest capability
// (routes/agents.ts requireAgentCapability); mirror that here so a caller who
// lacks ManageIngest never sees them as selectable chat targets. Matches the
// several id spellings the runtime cache registers.
const WRITE_AGENT_RE = /(graph[-_]builder|ingestion|scoring)/;
const isWriteAgent = (agentId: string): boolean => WRITE_AGENT_RE.test(agentId.toLowerCase());

function InvokePage() {
  const { roster: peers } = usePresence('invoke');
  const { data: agents } = useFetch<AgentDef[]>('/api/agents');
  const { can } = useCapabilities();

  // Hide the write agents from the selector unless the caller holds
  // ManageIngest. While capabilities are still loading, can() is false, so the
  // conservative default hides them (better than flashing an option the server
  // will 403). Read + newsroom agents always stay listed.
  const canIngest = can('ManageIngest');
  const visibleAgents = useMemo(
    () => (canIngest ? agents : agents?.filter((a) => !isWriteAgent(a.id))),
    [agents, canIngest],
  );

  const [selectedId, setSelectedId] = useState('orgiq-supervisor');
  // A history load that FAILED, kept apart from a conversation that is empty.
  // Auto-resume fires on mount, so an expired cookie or a 500 used to land the
  // user in the "send a message to start" empty state — the app quietly
  // claiming their conversation didn't exist.
  const [historyError, setHistoryError] = useState<
    { sessionId: string; message: string; needsAuth: boolean } | null
  >(null);
  const {
    messages,
    isStreaming,
    streamingText,
    activeToolCalls,
    error,
    sessionId,
    sendMessage,
    reset,
    loadHistory,
  } = useAgentStream({
    url: `/api/agents/${selectedId}/invoke`,
    // Shared canonical fetcher (lib/chatSessions). keepThinking because this
    // page renders <thinking> blocks as collapsible ThinkingBlock sections.
    // On failure we record WHY and re-throw: re-throwing leaves whatever was
    // on screen intact (loadHistory only replaces messages on success) and the
    // banner below explains and offers a retry.
    historyFetch: (sid: string) =>
      fetchSessionMessages(sid, { keepThinking: true })
        .then((msgs) => { setHistoryError(null); return msgs; })
        .catch((err: unknown) => {
          const e = err instanceof SessionHistoryError ? err : null;
          setHistoryError({
            sessionId: sid,
            message: e?.message ?? 'Could not load this conversation.',
            needsAuth: Boolean(e?.needsAuth),
          });
          throw err;
        }),
  });
  const [input, setInput] = useState('');
  const [suggestionSeed, setSuggestionSeed] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const {
    data: sessionList,
    error: sessionListError,
    refresh: refreshSessions,
  } = useFetch<{ sessions: SessionSummary[] }>('/api/sessions', 15000);
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
    if (!sid) return;
    void loadSession(sid);
    const next = new URLSearchParams(searchParams);
    next.delete('session');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('session')]);

  // Honor /iq/invoke?agentId=<id> — the "invoke this agent" links from the
  // Architecture graph and the agent detail page. Pre-select that agent for a
  // fresh conversation and strip the param. Without this the links silently
  // opened the default supervisor, so "talk to the search agent" never did.
  useEffect(() => {
    const aid = searchParams.get('agentId');
    if (!aid) return;
    setSelectedId(aid);
    forgetSession('invoke'); // agent changed — don't resume a different agent's session
    const next = new URLSearchParams(searchParams);
    next.delete('agentId');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('agentId')]);

  // Honor deep-links like /iq/invoke?prompt=<slug-or-text> — the subnav
  // "Suggested" searches ("Who knows X?", "Decisions about X"…) point here.
  // Resolve a known slug to its full prompt, else send the text verbatim, run
  // it once, and strip the param so a reload doesn't re-fire it. Previously
  // these links redirected to /invoke and the param was dropped, so every
  // suggested search did nothing.
  useEffect(() => {
    const p = searchParams.get('prompt');
    if (!p) return;
    const resolved = PROMPT_SLUGS[p] ?? p;
    const next = new URLSearchParams(searchParams);
    next.delete('prompt');
    setSearchParams(next, { replace: true });
    void sendMessage(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('prompt')]);

  // Auto-resume: with no deep-link, reload lands back in the last conversation
  // instead of a fresh one (transcript restored from AgentCore Memory). A
  // ?prompt= deep-link is a fresh question, so it wins over resuming too.
  useEffect(() => {
    if (searchParams.get('session') || searchParams.get('prompt') || searchParams.get('agentId')) return; // deep-link wins
    const saved = recallSession('invoke');
    if (saved) void loadSession(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active session whenever the hook mints or switches one.
  useEffect(() => {
    if (sessionId) rememberSession('invoke', sessionId);
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

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    setHistoryError(null); // a new turn supersedes a stale load failure
    void sendMessage(input.trim());
    setInput('');
  };

  // Library hook's loadHistory(sid) handles the fetch via the historyFetch
  // option above (configured at the useAgentStream() call site).
  async function loadSession(sid: string) {
    await loadHistory(sid);
  }

  const sessions = sessionList?.sessions ?? [];
  // GET /api/sessions is session-guarded, so an expired cookie 401s. Rendering
  // that as "No sessions yet" would tell the user their conversations are gone
  // when they are simply signed out. Only claim "none" when the call SUCCEEDED
  // and returned none.
  const sessionsUnavailable = Boolean(sessionListError) && !sessionList;
  const sessionsNeedAuth = /\b401\b|\b403\b/.test(sessionListError ?? '');

  // One supervisor turn can stream as several adjacent assistant messages
  // (the hook flushes at every TEXT_MESSAGE_END) — merge them so the role
  // label renders once per turn instead of once per fragment.
  const displayMessages = useMemo(() => coalesceAssistantMessages(messages), [messages]);

  // Contextual follow-up suggestions derived from conversation + refreshed on demand
  // Org-graph enrichment: which *real* people the answer named. Matched exactly
  // (word-boundary hits against actual graph people), so the "People in this
  // answer" panel and the follow-ups are accurate — unlike guessing at any two
  // capitalized words. Harvested from the retired dedicated search page.
  const { data: graph } = useFetch<GraphEntities>('/api/graph/entities');

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

  const handleSuggestion = useCallback((s: string) => {
    setInput(s);
  }, []);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Session sidebar */}
      <div style={{ width: 220, borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sessions</span>
            <PresenceAvatarGroup peers={peers} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Agent selector — only shown when multiple agents are available */}
            {visibleAgents && visibleAgents.length > 1 && (
              <select
                value={selectedId}
                onChange={e => {
                  setSelectedId(e.target.value);
                  forgetSession('invoke'); // sessions are agent-scoped — don't resume across agents
                  setHistoryError(null);
                  reset();
                }}
                aria-label="Select agent"
                style={{
                  fontSize: 11,
                  border: '1px solid var(--color-border)',
                  borderRadius: 4,
                  background: 'var(--color-surface)',
                  color: 'var(--color-text-primary)',
                  padding: '2px 6px',
                  cursor: 'pointer',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {visibleAgents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            )}
            <button
              onClick={() => { forgetSession('invoke'); setHistoryError(null); reset(); }}
              title="New session"
              style={{ fontSize: 11, padding: '4px 10px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              + New
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {sessionsUnavailable && (
            <div role="status" style={{ padding: '12px 16px', fontSize: 11, color: 'var(--color-text-secondary)' }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Conversations unavailable</div>
              <div style={{ color: 'var(--color-text-tertiary)' }}>
                {sessionsNeedAuth
                  ? 'Your session expired — sign in to see your conversations.'
                  : `Couldn’t load the session list (${sessionListError}).`}
              </div>
              <button
                type="button"
                onClick={() => refreshSessions()}
                style={{
                  marginTop: 6, fontSize: 11, padding: '2px 8px', borderRadius: 4,
                  border: '1px solid var(--color-border)', background: 'var(--color-surface)',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                Retry
              </button>
            </div>
          )}
          {!sessionsUnavailable && sessions.length === 0 && (
            <div style={{ padding: '12px 16px', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              No sessions yet — send a message to start one.
            </div>
          )}
          {sessions.map(s => {
            const selected = s.sessionId === sessionId;
            return (
              <button
                type="button"
                key={s.sessionId}
                onClick={() => loadSession(s.sessionId)}
                aria-current={selected ? 'page' : undefined}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 14px',
                  border: 'none',
                  background: selected ? 'var(--color-surface-hover)' : 'transparent',
                  borderLeft: selected ? '3px solid var(--color-primary)' : '3px solid transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title || <span style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>Untitled session</span>}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                  {new Date(s.createdAt).toLocaleString()}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 24 }}>
        <div
          role="log"
          aria-live="polite"
          aria-atomic="false"
          aria-relevant="additions text"
          style={{ flex: 1, overflow: 'auto', marginBottom: 16 }}
        >
          {/* A transcript we could not load is not an empty conversation. Say
              which one it is, and offer the retry — never the "start a new
              conversation" prompt over the top of someone's history. */}
          {historyError && (
            <div
              role="alert"
              style={{
                border: '1px solid var(--color-border)',
                borderLeft: '3px solid var(--color-warning, #d97706)',
                borderRadius: 4,
                padding: '10px 14px',
                marginBottom: 12,
                fontSize: 13,
                color: 'var(--color-text-secondary)',
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              }}
            >
              <span>
                <strong style={{ color: 'var(--color-text-primary)' }}>
                  Couldn’t load this conversation.
                </strong>{' '}
                {historyError.message} Nothing has been deleted — this is a load failure, not an empty conversation.
              </span>
              <button
                type="button"
                onClick={() => { void loadSession(historyError.sessionId); }}
                style={{
                  fontSize: 12, padding: '3px 10px', borderRadius: 4,
                  border: '1px solid var(--color-border)', background: 'var(--color-surface)',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {historyError.needsAuth ? 'Try again' : 'Retry'}
              </button>
            </div>
          )}
          {messages.length === 0 && !isStreaming && !historyError && (
            <div style={{ padding: 40, color: 'var(--color-text-tertiary)' }}>
              <div style={{ fontSize: 18, marginBottom: 4, textAlign: 'center' }}>Ask {selectedAgent?.name ?? 'Agent'}</div>
              <div style={{ fontSize: 13, marginBottom: 24, textAlign: 'center' }}>
                Ask the org anything — who can help, who knows what, what's been decided.
              </div>
              {/* The caller's own board, re-voiced as questions. Clicking sends
                  immediately — this is chat, and a suggested question you still
                  have to re-submit is a form pretending to be a conversation. */}
              {askSuggestions.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 8 }}>
                    From your work
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                    {askSuggestions.slice(0, 4).map((sg) => (
                      <SuggestionCard
                        key={sg.id}
                        reason={sg.reason}
                        title={sg.title}
                        label={sg.kind}
                        tone={sg.kind === 'blocked' ? 'danger' : sg.kind === 'in-review' ? 'warning' : 'neutral'}
                        actionLabel="Ask"
                        onSelect={() => sendMessage(sg.prompt)}
                      />
                    ))}
                  </div>
                </div>
              )}
              <QuickPromptGrid
                prompts={quickPromptsFor(selectedId).map(p => ({ label: p.label, hint: p.prompt }))}
                onSelect={(label) => {
                  const found = quickPromptsFor(selectedId).find(p => p.label === label);
                  if (found) sendMessage(found.prompt);
                }}
                title={askSuggestions.length > 0 ? 'Or try:' : 'Try asking:'}
              />
            </div>
          )}
          {displayMessages.map(msg => {
            // Derive provenance from the turn's tool calls (thinking blocks are
            // kept — renderMessageContent handles those), strip the model's own
            // unverifiable citations out of the prose, and summarize what the
            // turn actually did.
            const { cleaned, sources, provenance } = msg.role === 'assistant'
              ? deriveSources({ content: msg.content, toolCalls: msg.toolCalls })
              : { cleaned: msg.content, sources: [], provenance: undefined };
            const toolSummary = msg.role === 'assistant' ? summarizeToolCalls(msg.toolCalls) : null;
            return (
              <div key={msg.id}>
                <MessageBubble
                  role={msg.role}
                  content={cleaned}
                  toolCalls={(msg.toolCalls ?? []).map(tc => ({
                    id: tc.id,
                    name: tc.name,
                    done: Boolean(tc.result),
                  }))}
                  agentName={selectedAgent?.name ?? 'Agent'}
                  renderMarkdown={(content) => renderMessageContent(content, false)}
                />
                {toolSummary && (
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                    {toolSummary}
                  </div>
                )}
                <SourceChips sources={sources} {...(provenance ? { provenance } : {})} />
                {msg.role === 'assistant' && (
                  <FeedbackControl invocationId={answerInvocationId(msg)} />
                )}
              </div>
            );
          })}
          {isStreaming && (
            <MessageBubble
              role="assistant"
              content={extractSources(streamingText).cleaned}
              toolCalls={activeToolCalls.map(tc => ({
                id: tc.id,
                name: tc.name,
                done: tc.done,
                args: tc.args,
              }))}
              streaming
              agentName={selectedAgent?.name ?? 'Agent'}
              renderMarkdown={(content) => renderMessageContent(content, true)}
            />
          )}
          {/* The hook mirrors a history-load throw into `error`; the banner
              above already says it (with a retry), so don't print it twice. */}
          {error && error !== historyError?.message && (
            <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>Error: {error}</div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* People in this answer — the org-graph names the response actually
            mentioned, each a jump into the graph. The organizational-intelligence
            payoff: an answer about "who knows X" surfaces the real people. */}
        {mentionedPeople.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
              People in this answer
            </span>
            {mentionedPeople.slice(0, 8).map((p) => (
              <Link
                key={p.id}
                to={`/iq/explore?focus=${encodeURIComponent(p.id)}`}
                title={`Show ${p.name} in the org graph`}
                style={{
                  fontSize: 12, fontWeight: 600, textDecoration: 'none',
                  padding: '2px 10px', borderRadius: 999,
                  border: '1px solid var(--color-primary)',
                  color: 'var(--color-primary)', background: 'transparent',
                }}
              >
                {p.name}
              </Link>
            ))}
          </div>
        )}

        {/* Suggested search bubbles — shown when conversation has messages */}
        {messages.length > 0 && !isStreaming && suggestions.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <FollowUpChips
              suggestions={suggestions}
              onSelect={handleSuggestion}
              onRefresh={() => setSuggestionSeed(k => k + 1)}
            />
          </div>
        )}

        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={handleSend}
          disabled={isStreaming}
          placeholder={`Ask ${selectedAgent?.name ?? 'agent'}...`}
        />
      </div>

      {/* People with evidence — the Find-Help view, folded into the chat.
          The answer names people in prose; this rail shows WHY them, from the
          org graph: matched skills, the documents behind them, where they
          spend their time. Score-free by design (ViewOrgChart tier). Only
          rendered when the last question actually matched someone. */}
      {helpPeople.length > 0 && (
        <aside
          aria-label="People with evidence"
          style={{
            width: 280, flexShrink: 0, borderLeft: '1px solid var(--color-border)',
            padding: '16px 14px', overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            People with evidence
          </div>
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
        </aside>
      )}

      {/* Session chat sidebar — shown when VITE_ORGIQ_CHAT_ENABLED=true and a session is active */}
      {CHAT_ENABLED && sessionId && (
        <aside style={{
          width: 300,
          borderLeft: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}>
          <div style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--color-border)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Session Chat
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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
          </div>
        </aside>
      )}
    </div>
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
      { label: 'Browse a webpage', badge: '🌐', badgeColor: '#0ea5e9', prompt: 'Use the fetch_web_page tool to load https://example.com and tell me the page title and the first 200 characters of body text.' },
      { label: 'Live news scrape', badge: '🌐', badgeColor: '#0ea5e9', prompt: 'Browse https://news.ycombinator.com and summarize the top 3 stories with their points and titles.' },
      { label: 'Find Kubernetes experts', prompt: 'Who in the org has the most Kubernetes expertise? Use query_graph to find people with that skill.' },
      { label: 'Team breakdown', prompt: 'List the size of each team using a SQL query on team_memberships.' },
    ];
  }
  if (agentId.endsWith('scoring')) {
    return [
      { label: 'Top 10 by composite', prompt: 'Show the top 10 people by composite score across all teams.' },
      { label: 'Run Python sandbox', badge: '🐍', badgeColor: '#16a34a', prompt: 'Use run_in_sandbox to execute: import statistics; nums=[12,47,23,91,56,34,78,19,65,88]; print(f"mean={statistics.mean(nums):.2f}, stdev={statistics.stdev(nums):.2f}")' },
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
      { label: 'Test the guardrail', badge: '🛡', badgeColor: '#dc2626', prompt: 'What is Raj Mehta\'s exact salary in dollars?' },
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
