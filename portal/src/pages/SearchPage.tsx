// Focused conversational org-search experience.
//
// Differs from /invoke (multi-agent debug surface) and /explore (graph-first):
// here the chat is centered and a right-side rail surfaces the things you'd
// want when *reading* an answer — source documents the agent retrieved and
// people it mentioned. Pinned to the orgiq-search agent so the KB and graph
// tool surfaces are predictable.
//
// Citations come from query_knowledge_base tool calls (each call returns a
// JSON array of {content, score, source}). Related people come from name-
// matching the latest assistant message against /api/graph/entities (same
// pattern as ExplorePage).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAgentStream } from '@connorhoehn/realtime-modules/client';
import type { ToolCall as LiveToolCall } from '@connorhoehn/realtime-modules/client';
import { useFetch } from '../hooks/useFetch';
import { Markdown } from '../components/Markdown';
import type { GraphPerson } from '../components/org-graph';
import { useSessionPresence } from '../hooks/useSessionPresence';
import { PresenceAvatarGroup } from '../components/shell/PresenceAvatarGroup';

// ── Types ────────────────────────────────────────────────────────────────────

interface GraphEntities {
  nodes: GraphPerson[];
}

interface KbCitation {
  /** Stable id for React keys — derived from source + a slice of content. */
  key: string;
  source: string;
  content: string;
  score: number;
  /** Which tool call surfaced this citation. */
  fromToolCallId: string;
}

// ── Citation extraction ──────────────────────────────────────────────────────

function parseCitations(toolCalls: ReadonlyArray<LiveToolCall>): KbCitation[] {
  const out: KbCitation[] = [];
  for (const tc of toolCalls) {
    if (tc.name !== 'query_knowledge_base' || !tc.result) continue;
    try {
      const parsed = JSON.parse(tc.result);
      if (!Array.isArray(parsed)) continue;
      for (const row of parsed) {
        if (!row || typeof row !== 'object') continue;
        const source = String(row['source'] ?? 'unknown');
        const content = String(row['content'] ?? '');
        if (!content) continue;
        out.push({
          key: `${tc.id}:${source}:${content.slice(0, 40)}`,
          source,
          content,
          score: typeof row['score'] === 'number' ? row['score'] : 0,
          fromToolCallId: tc.id,
        });
      }
    } catch {
      // Result wasn't JSON — agent might have emitted a string. Skip silently.
    }
  }
  // Dedupe by source+content prefix; KB sometimes returns near-identical
  // chunks across queries within one turn.
  const seen = new Set<string>();
  return out.filter(c => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
}

// Friendly label for an S3 URI like
// `s3://orgiq-documents-264.../decisions/auth-rollout.md` → `auth-rollout.md`.
function citationLabel(source: string): string {
  if (source === 'unknown') return 'Unknown source';
  const tail = source.split('/').pop();
  return tail || source;
}

// ── Related-people extraction (lifted pattern from ExplorePage) ──────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMentionedPeople(text: string, people: GraphPerson[]): GraphPerson[] {
  if (!text || people.length === 0) return [];
  // Sort longest-name first so "Sarah Ahmed" wins over "Sarah".
  const sorted = [...people].sort((a, b) => b.name.length - a.name.length);
  const stripped = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  const matched = new Map<string, GraphPerson>();
  for (const p of sorted) {
    const re = new RegExp(`(?<![\\w])${escapeRe(p.name)}(?![\\w])`, 'i');
    if (re.test(stripped)) matched.set(p.id, p);
  }
  return Array.from(matched.values());
}

// ── Quick prompts ────────────────────────────────────────────────────────────

interface QuickPrompt {
  label: string;
  prompt: string;
}

const QUICK_PROMPTS: QuickPrompt[] = [
  { label: 'Who knows X?',          prompt: 'Who in the organization has the deepest expertise in Kubernetes?' },
  { label: 'Decisions about X',     prompt: 'What recent decisions has the platform team made about authentication?' },
  { label: 'Who works on Y',        prompt: 'Which people contributed to the org-graph builder project, and what were their roles?' },
  { label: 'Compare two people',    prompt: 'Compare the expertise profiles of any two senior engineers and suggest who to ask about scaling Postgres.' },
];

// ── Page ─────────────────────────────────────────────────────────────────────

const SEARCH_AGENT_ID = 'orgiq-search';

function SearchPage() {
  const { peers } = useSessionPresence('search');
  const { data: graph } = useFetch<GraphEntities>('/api/graph/entities');
  // Holds the one-shot selection for the next outgoing message. Set inside
  // handleSend just before sendMessage(), read by buildBody when the hook
  // assembles the POST body. Lives in a ref (not the hook deps) so the
  // memoized sendMessage closure always sees the latest value.
  const pendingSelectionRef = useRef<{ peopleIds: string[] } | null>(null);
  const {
    messages,
    isStreaming,
    streamingText,
    activeToolCalls,
    error,
    sendMessage,
    reset,
  } = useAgentStream({
    url: `/api/agents/${SEARCH_AGENT_ID}/invoke`,
    buildBody: (text, { sessionId }) => {
      const sel = pendingSelectionRef.current;
      pendingSelectionRef.current = null;
      return {
        message: text,
        ...(sessionId ? { sessionId } : {}),
        ...(sel ? { selection: sel } : {}),
      };
    },
  });

  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // ?peopleIds=<csv> arrives from /explore "Ask in Search". Hold them as
  // pinned context that's attached to the next outgoing message.
  const [pinnedPeopleIds, setPinnedPeopleIds] = useState<string[]>(() => {
    const csv = new URLSearchParams(window.location.search).get('peopleIds');
    return csv ? csv.split(',').filter(Boolean) : [];
  });

  // Strip the param once we've captured it so a reload doesn't re-pin.
  useEffect(() => {
    if (!searchParams.get('peopleIds')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('peopleIds');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const pinnedPeople = useMemo<GraphPerson[]>(() => {
    if (!graph?.nodes || pinnedPeopleIds.length === 0) return [];
    const byId = new Map(graph.nodes.map(p => [p.id, p]));
    return pinnedPeopleIds.map(id => byId.get(id)).filter((p): p is GraphPerson => Boolean(p));
  }, [graph, pinnedPeopleIds]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamingText]);

  // Build citation + people sets across the whole conversation. We accumulate
  // tool calls from finalized messages plus the live ones. (Each completed
  // message stores its toolCalls.)
  const allToolCalls = useMemo<ReadonlyArray<LiveToolCall>>(() => {
    const fromMessages: LiveToolCall[] = [];
    for (const m of messages) {
      if (!m.toolCalls) continue;
      for (const tc of m.toolCalls) {
        fromMessages.push({ ...tc, done: true });
      }
    }
    return [...fromMessages, ...activeToolCalls];
  }, [messages, activeToolCalls]);

  const citations = useMemo(() => parseCitations(allToolCalls), [allToolCalls]);

  const mentionedPeople = useMemo<GraphPerson[]>(() => {
    if (!graph?.nodes) return [];
    // Combine the last assistant message + the currently-streaming text so
    // people light up as they're typed.
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const combined = [lastAssistant?.content ?? '', streamingText].join(' ');
    return findMentionedPeople(combined, graph.nodes);
  }, [graph, messages, streamingText]);

  function handleSend() {
    if (!input.trim() || isStreaming) return;
    if (pinnedPeopleIds.length > 0) {
      pendingSelectionRef.current = { peopleIds: pinnedPeopleIds };
    }
    void sendMessage(input.trim());
    setInput('');
    // The pin is one-shot context for this turn; clear so subsequent turns
    // don't keep re-applying a stale selection.
    if (pinnedPeopleIds.length > 0) setPinnedPeopleIds([]);
  }

  const hasAnyMessages = messages.length > 0 || isStreaming;

  return (
    <div style={containerStyle}>
      {/* ─── Chat column ─────────────────────────────────────────────────── */}
      <div style={chatColumnStyle}>
        <header style={headerStyle}>
          <div>
            <div style={titleStyle}>Search</div>
            <div style={subtitleStyle}>Ask the org-search agent — it reads the knowledge base and the people graph.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PresenceAvatarGroup peers={peers} />
            {hasAnyMessages && (
              <button onClick={reset} style={resetBtnStyle} title="Start a new search session">
                + New search
              </button>
            )}
          </div>
        </header>

        <div style={chatScrollStyle}>
          {!hasAnyMessages && (
            <div style={emptyStyle}>
              <div style={emptyTitleStyle}>Ask anything about the organization.</div>
              <div style={emptyDetailStyle}>
                The agent has access to ingested documents and the people graph. Try one of these:
              </div>
              <div style={quickPromptsGridStyle}>
                {QUICK_PROMPTS.map(p => (
                  <button
                    key={p.label}
                    onClick={() => sendMessage(p.prompt)}
                    style={quickPromptBtnStyle}
                  >
                    <div style={quickPromptLabelStyle}>{p.label}</div>
                    <div style={quickPromptHintStyle}>{p.prompt}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(msg => (
            <Message key={msg.id} role={msg.role} content={msg.content} toolCalls={msg.toolCalls ?? []} />
          ))}

          {isStreaming && (
            <Message
              role="assistant"
              content={streamingText}
              toolCalls={activeToolCalls}
              streaming
            />
          )}

          {error && <div style={errorStyle}>Error: {error}</div>}
          <div ref={bottomRef} />
        </div>

        {pinnedPeople.length > 0 && (
          <div style={pinnedStripStyle}>
            <span style={pinnedLabelStyle}>Asking about</span>
            {pinnedPeople.map(p => (
              <span key={p.id} style={pinnedChipStyle}>
                {p.name}
                <button
                  onClick={() => setPinnedPeopleIds(ids => ids.filter(id => id !== p.id))}
                  style={pinnedChipCloseStyle}
                  aria-label={`Remove ${p.name}`}
                >
                  ✕
                </button>
              </span>
            ))}
            <button onClick={() => setPinnedPeopleIds([])} style={pinnedClearStyle}>
              Clear all
            </button>
          </div>
        )}

        <div style={composerStyle}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Ask about people, projects, decisions…"
            disabled={isStreaming}
            style={composerInputStyle}
          />
          <button onClick={handleSend} disabled={isStreaming || !input.trim()} style={composerBtnStyle}>
            Send
          </button>
        </div>
      </div>

      {/* ─── Right rail: Sources + Related people ────────────────────────── */}
      <aside style={railStyle}>
        <RailSection
          title="Sources"
          count={citations.length}
          emptyHint="No documents retrieved yet. The agent surfaces sources as it answers."
        >
          {citations.map(c => (
            <CitationCard key={c.key} citation={c} />
          ))}
        </RailSection>

        <RailSection
          title="Related people"
          count={mentionedPeople.length}
          emptyHint="People mentioned in the response will appear here."
        >
          {mentionedPeople.map(p => (
            <PersonCard key={p.id} person={p} />
          ))}
        </RailSection>
      </aside>
    </div>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────────

interface MessageToolCall {
  id: string;
  name: string;
  done?: boolean;
}

function Message({
  role,
  content,
  toolCalls,
  streaming = false,
}: {
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ReadonlyArray<MessageToolCall>;
  streaming?: boolean;
}) {
  return (
    <div style={messageStyle}>
      <div style={messageRoleStyle}>{role === 'user' ? 'You' : 'Search agent'}</div>
      {toolCalls.length > 0 && (
        <div style={toolCallsStripStyle}>
          {toolCalls.map(tc => (
            <span key={tc.id} style={toolCallPillStyle(tc.done === true)}>
              {tc.name}{tc.done ? ' ✓' : '…'}
            </span>
          ))}
        </div>
      )}
      {role === 'assistant' ? (
        <Markdown>{content || (streaming ? '…' : '')}</Markdown>
      ) : (
        <div style={userTextStyle}>{content}</div>
      )}
    </div>
  );
}

function RailSection({
  title,
  count,
  emptyHint,
  children,
}: {
  title: string;
  count: number;
  emptyHint: string;
  children: React.ReactNode;
}) {
  return (
    <section style={railSectionStyle}>
      <div style={railSectionHeaderStyle}>
        <span>{title}</span>
        <span style={railSectionCountStyle}>{count}</span>
      </div>
      {count === 0 ? (
        <div style={railEmptyStyle}>{emptyHint}</div>
      ) : (
        <div style={railListStyle}>{children}</div>
      )}
    </section>
  );
}

function CitationCard({ citation }: { citation: KbCitation }) {
  const [open, setOpen] = useState(false);
  const label = citationLabel(citation.source);
  const isHttp = /^https?:/.test(citation.source);

  return (
    <div style={citationCardStyle}>
      <div style={citationHeadStyle}>
        {isHttp ? (
          <a href={citation.source} target="_blank" rel="noreferrer" style={citationTitleStyle}>{label}</a>
        ) : (
          <span style={citationTitleStyle}>{label}</span>
        )}
        <span style={citationScoreStyle}>{citation.score.toFixed(2)}</span>
      </div>
      <div style={citationSnippetStyle}>
        {open ? citation.content : truncate(citation.content, 180)}
      </div>
      {citation.content.length > 180 && (
        <button
          onClick={() => setOpen(o => !o)}
          style={citationToggleStyle}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function PersonCard({ person }: { person: GraphPerson }) {
  return (
    <Link
      to={`/explore?focus=${encodeURIComponent(person.id)}`}
      style={personCardStyle}
    >
      <div style={personNameStyle}>{person.name}</div>
      {(person.title || person.department) && (
        <div style={personMetaStyle}>
          {person.title}{person.title && person.department ? ' · ' : ''}{person.department}
        </div>
      )}
    </Link>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// ── Styles ───────────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  display: 'flex',
  height: '100%',
  background: 'var(--color-bg)',
};
const chatColumnStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  padding: '14px 24px',
  borderBottom: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  gap: 16,
};
const titleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};
const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
  marginTop: 2,
};
const resetBtnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '4px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--color-text-secondary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const chatScrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '20px 24px',
};
const emptyStyle: React.CSSProperties = {
  maxWidth: 720,
  margin: '40px auto',
};
const emptyTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  marginBottom: 6,
};
const emptyDetailStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary)',
  marginBottom: 16,
};
const quickPromptsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 8,
};
const quickPromptBtnStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 12,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  cursor: 'pointer',
  color: 'var(--color-text-primary)',
  fontFamily: 'inherit',
};
const quickPromptLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  marginBottom: 4,
};
const quickPromptHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  lineHeight: 1.4,
};
const messageStyle: React.CSSProperties = {
  marginBottom: 20,
};
const messageRoleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--color-text-tertiary)',
  marginBottom: 6,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
const userTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  color: 'var(--color-text-primary)',
};
const toolCallsStripStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  marginBottom: 6,
};
function toolCallPillStyle(done: boolean): React.CSSProperties {
  return {
    fontSize: 10.5,
    padding: '2px 8px',
    borderRadius: 999,
    background: done ? 'var(--color-success-bg, #ecfdf5)' : 'var(--color-info-bg, #eff6ff)',
    color: done ? 'var(--color-success, #047857)' : 'var(--color-info, #1d4ed8)',
    fontFamily: 'monospace',
  };
}
const errorStyle: React.CSSProperties = {
  color: 'var(--color-danger)',
  fontSize: 13,
  padding: '8px 0',
};
const pinnedStripStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  padding: '8px 24px',
  borderTop: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
};
const pinnedLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  fontWeight: 600,
};
const pinnedChipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  padding: '3px 4px 3px 10px',
  background: 'var(--color-surface-hover, #eef2ff)',
  color: 'var(--color-primary, #6366f1)',
  border: '1px solid var(--color-primary, #6366f1)',
  borderRadius: 999,
  fontWeight: 500,
};
const pinnedChipCloseStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  padding: '0 4px',
  fontSize: 11,
  fontFamily: 'inherit',
};
const pinnedClearStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  background: 'transparent',
  color: 'var(--color-text-tertiary)',
  border: 'none',
  cursor: 'pointer',
  marginLeft: 'auto',
  fontFamily: 'inherit',
};
const composerStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '14px 24px',
  borderTop: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
};
const composerInputStyle: React.CSSProperties = {
  flex: 1,
  padding: '10px 14px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  fontSize: 14,
  outline: 'none',
  fontFamily: 'inherit',
};
const composerBtnStyle: React.CSSProperties = {
  padding: '10px 20px',
  background: 'var(--color-primary)',
  color: 'white',
  border: 'none',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
  fontWeight: 500,
  fontFamily: 'inherit',
};
const railStyle: React.CSSProperties = {
  width: 320,
  borderLeft: '1px solid var(--color-border)',
  background: 'var(--color-surface)',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
};
const railSectionStyle: React.CSSProperties = {
  borderBottom: '1px solid var(--color-border)',
  padding: '14px 16px',
};
const railSectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 8,
};
const railSectionCountStyle: React.CSSProperties = {
  fontSize: 10,
  padding: '1px 6px',
  background: 'var(--color-bg)',
  borderRadius: 999,
  color: 'var(--color-text-secondary)',
};
const railEmptyStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--color-text-tertiary)',
  lineHeight: 1.5,
};
const railListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const citationCardStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '8px 10px',
  background: 'var(--color-bg)',
};
const citationHeadStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 6,
  marginBottom: 4,
};
const citationTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-primary)',
  textDecoration: 'none',
  wordBreak: 'break-word',
};
const citationScoreStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--color-text-tertiary)',
  fontFamily: 'monospace',
};
const citationSnippetStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--color-text-secondary)',
  lineHeight: 1.45,
};
const citationToggleStyle: React.CSSProperties = {
  marginTop: 4,
  background: 'transparent',
  border: 'none',
  padding: 0,
  fontSize: 10.5,
  color: 'var(--color-primary, #6366f1)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const personCardStyle: React.CSSProperties = {
  display: 'block',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '8px 10px',
  background: 'var(--color-bg)',
  textDecoration: 'none',
  color: 'inherit',
};
const personNameStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-primary)',
};
const personMetaStyle: React.CSSProperties = {
  fontSize: 10.5,
  color: 'var(--color-text-tertiary)',
  marginTop: 2,
};

export default SearchPage;
