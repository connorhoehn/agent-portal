// ResearcherPage — story-research assistant for the OrgIQ newsroom.
//
// Streams an AG-UI session against orgiq-news-researcher. The right rail
// surfaces:
//   - Sources: articles retrieved via search_archive (same KB citation pattern
//     as SearchPage but scoped to the news researcher's tool name)
//   - Mentioned entities: parsed from find_entities_in_articles tool results
//
// parseCitations / entity-parsing logic is replicated here (not imported from
// SearchPage) per the file-collision rules — each page is self-contained.

import { useMemo, useRef, useState } from 'react';
import { useAgentStream } from '@connorhoehn/realtime-modules/agent-streaming/client';
import type { ToolCall as LiveToolCall } from '@connorhoehn/realtime-modules/agent-streaming/client';
import { Markdown } from '../../components/Markdown';
import { useSessionPresence } from '../../hooks/useSessionPresence';
import { PresenceAvatarGroup } from '../../components/shell/PresenceAvatarGroup';
import { useActivityFeed } from '../../hooks/useActivityFeed';
import { ActivityFeedPanel } from '../../components/shell/ActivityFeedPanel';

// ── Types ────────────────────────────────────────────────────────────────────

interface ArchiveCitation {
  key: string;
  source: string;
  content: string;
  score: number;
  fromToolCallId: string;
}

interface MentionedEntity {
  entityId: string;
  name: string;
  entityType: string;
  salience: number;
}

// ── Citation extraction (search_archive results) ─────────────────────────────

function parseCitations(toolCalls: ReadonlyArray<LiveToolCall>): ArchiveCitation[] {
  const out: ArchiveCitation[] = [];
  for (const tc of toolCalls) {
    if (tc.name !== 'search_archive' || !tc.result) continue;
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
      // Non-JSON result — skip silently.
    }
  }
  const seen = new Set<string>();
  return out.filter(c => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
}

// ── Entity extraction (find_entities_in_articles results) ────────────────────

function parseEntities(toolCalls: ReadonlyArray<LiveToolCall>): MentionedEntity[] {
  const byId = new Map<string, MentionedEntity>();
  for (const tc of toolCalls) {
    if (tc.name !== 'find_entities_in_articles' || !tc.result) continue;
    try {
      const parsed = JSON.parse(tc.result);
      if (!Array.isArray(parsed)) continue;
      for (const row of parsed) {
        if (!row || typeof row !== 'object') continue;
        const entityId = String(row['entityId'] ?? row['entity_id'] ?? '');
        if (!entityId) continue;
        const existing = byId.get(entityId);
        const salience = typeof row['salience'] === 'number' ? row['salience'] : 1.0;
        if (!existing || salience > existing.salience) {
          byId.set(entityId, {
            entityId,
            name: String(row['name'] ?? entityId),
            entityType: String(row['entityType'] ?? row['entity_type'] ?? 'unknown'),
            salience,
          });
        }
      }
    } catch {
      // Non-JSON result — skip silently.
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.salience - a.salience);
}

function citationLabel(source: string): string {
  if (source === 'unknown') return 'Unknown source';
  const tail = source.split('/').pop();
  return tail || source;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// ── Quick prompts ─────────────────────────────────────────────────────────────

interface QuickPrompt {
  label: string;
  prompt: string;
}

const QUICK_PROMPTS: QuickPrompt[] = [
  {
    label: 'Climate policy coverage',
    prompt: "What's been written about climate policy in the past month?",
  },
  {
    label: 'AI startup angles',
    prompt: 'Find related coverage for an emerging story about an AI startup.',
  },
  {
    label: 'Education reform sources',
    prompt: 'Who keeps appearing in education reform articles?',
  },
  {
    label: 'Housing crisis angles',
    prompt: 'Surface untouched angles on the housing crisis.',
  },
];

// ── Constants ─────────────────────────────────────────────────────────────────

const RESEARCHER_AGENT_ID = 'orgiq-news-researcher';

// ── Page ──────────────────────────────────────────────────────────────────────

function ResearcherPage() {
  const {
    messages,
    isStreaming,
    streamingText,
    activeToolCalls,
    error,
    sendMessage,
    reset,
  } = useAgentStream({
    url: `/api/agents/${RESEARCHER_AGENT_ID}/invoke`,
  });

  const { peers } = useSessionPresence('newsroom-researcher');
  const { entries: activityEntries, isLoading: activityLoading } = useActivityFeed('newsroom-researcher');

  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Accumulate tool calls across the whole conversation (finalized + live).
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
  const entities = useMemo(() => parseEntities(allToolCalls), [allToolCalls]);

  function handleSend() {
    if (!input.trim() || isStreaming) return;
    void sendMessage(input.trim());
    setInput('');
  }

  const hasAnyMessages = messages.length > 0 || isStreaming;

  return (
    <div style={containerStyle}>
      {/* ─── Chat column ──────────────────────────────────────────────────── */}
      <div style={chatColumnStyle}>
        <header style={headerStyle}>
          <div>
            <div style={titleStyle}>Story Researcher</div>
            <div style={subtitleStyle}>
              Research any topic — the agent searches the archive, surfaces key entities,
              and suggests reporting angles based on co-mention patterns.
            </div>
            <PresenceAvatarGroup peers={peers} />
          </div>
          {hasAnyMessages && (
            <button onClick={reset} style={resetBtnStyle} title="Start a new research session">
              + New research
            </button>
          )}
        </header>

        <div style={chatScrollStyle}>
          {!hasAnyMessages && (
            <div style={emptyStyle}>
              <div style={emptyTitleStyle}>What story are you researching?</div>
              <div style={emptyDetailStyle}>
                The agent searches the archive, identifies key entities, and surfaces
                untapped angles via co-mention patterns. Try one of these:
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
            <Message
              key={msg.id}
              role={msg.role}
              content={msg.content}
              toolCalls={msg.toolCalls ?? []}
            />
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

        <div style={composerStyle}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Describe a topic, story angle, or emerging news event…"
            disabled={isStreaming}
            style={composerInputStyle}
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            style={composerBtnStyle}
          >
            Research
          </button>
        </div>
      </div>

      {/* ─── Right rail: Sources + Entities ───────────────────────────────── */}
      <aside style={railStyle}>
        <RailSection
          title="Archive Sources"
          count={citations.length}
          emptyHint="Retrieved articles will appear here as the agent searches the archive."
        >
          {citations.map(c => (
            <CitationCard key={c.key} citation={c} />
          ))}
        </RailSection>

        <RailSection
          title="Mentioned Entities"
          count={entities.length}
          emptyHint="People, organisations, and places extracted from retrieved articles will appear here."
        >
          {entities.map(e => (
            <EntityCard key={e.entityId} entity={e} />
          ))}
        </RailSection>

        <ActivityFeedPanel entries={activityEntries} isLoading={activityLoading} />
      </aside>
    </div>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

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
      <div style={messageRoleStyle}>{role === 'user' ? 'You' : 'Researcher agent'}</div>
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

function CitationCard({ citation }: { citation: ArchiveCitation }) {
  const [open, setOpen] = useState(false);
  const label = citationLabel(citation.source);
  const isHttp = /^https?:/.test(citation.source);

  return (
    <div style={citationCardStyle}>
      <div style={citationHeadStyle}>
        {isHttp ? (
          <a
            href={citation.source}
            target="_blank"
            rel="noreferrer"
            style={citationTitleStyle}
          >
            {label}
          </a>
        ) : (
          <span style={citationTitleStyle}>{label}</span>
        )}
        <span style={citationScoreStyle}>{citation.score.toFixed(2)}</span>
      </div>
      <div style={citationSnippetStyle}>
        {open ? citation.content : truncate(citation.content, 180)}
      </div>
      {citation.content.length > 180 && (
        <button onClick={() => setOpen(o => !o)} style={citationToggleStyle}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function EntityCard({ entity }: { entity: MentionedEntity }) {
  const typeColor = entityTypeColor(entity.entityType);
  return (
    <div style={entityCardStyle}>
      <div style={entityHeadStyle}>
        <span style={entityNameStyle}>{entity.name}</span>
        <span style={{ ...entityTypeBadgeStyle, background: typeColor.bg, color: typeColor.fg }}>
          {entity.entityType}
        </span>
      </div>
      <div style={entitySalienceStyle}>salience {entity.salience.toFixed(2)}</div>
    </div>
  );
}

function entityTypeColor(type: string): { bg: string; fg: string } {
  switch (type.toLowerCase()) {
    case 'person':
      return { bg: 'var(--color-info-bg, #eff6ff)', fg: 'var(--color-info, #1d4ed8)' };
    case 'organization':
    case 'org':
      return { bg: 'var(--color-success-bg, #ecfdf5)', fg: 'var(--color-success, #047857)' };
    case 'place':
    case 'location':
      return { bg: '#fef9c3', fg: '#92400e' };
    default:
      return { bg: 'var(--color-bg)', fg: 'var(--color-text-secondary)' };
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
  maxWidth: 560,
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
  whiteSpace: 'nowrap',
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
const entityCardStyle: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '8px 10px',
  background: 'var(--color-bg)',
};
const entityHeadStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 6,
  marginBottom: 2,
};
const entityNameStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-primary)',
  wordBreak: 'break-word',
};
const entityTypeBadgeStyle: React.CSSProperties = {
  fontSize: 9.5,
  padding: '1px 6px',
  borderRadius: 999,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  whiteSpace: 'nowrap',
};
const entitySalienceStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--color-text-tertiary)',
  fontFamily: 'monospace',
};

export default ResearcherPage;
