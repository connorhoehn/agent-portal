import { useState, useEffect, useRef, useMemo } from 'react';
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip, SegmentedControl } from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BrowserSession {
  sessionId: string;
  agentName: string;
  status: 'ACTIVE' | 'IDLE' | 'CLOSED';
  startedAt: string;
  lastActivityAt: string;
  currentUrl: string;
  pageTitle: string;
  requestCount: number;
  profileId: string;
}

interface JourneyStep {
  index: number;
  startedAt: string;
  url: string;
  pageTitle: string;
  textSnippet: string;
  imageDataUrl?: string;
  question?: string;
  answer?: string;
}

interface CrawlPage {
  url: string;
  title: string;
  textSnippet: string;
  contentLength: number;
  depth: number;
  parentUrl: string | null;
  linksFound: string[];
  s3Key: string | null;
  screenshotTaken: boolean;
  crawledAt: string;
  error: string | null;
}

interface CrawlSession {
  id: string;
  sessionId: string;
  startUrl: string;
  maxPages: number;
  includePattern: string | null;
  sameOriginOnly: boolean;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  pages: CrawlPage[];
  queued: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

type BrowserMode = 'qa' | 'journey' | 'sessions';
type CrawlView = 'carousel' | 'timeline' | 'sitemap';

// ─── Page ─────────────────────────────────────────────────────────────────────

function BrowserPage() {
  const [mode, setMode] = useState<BrowserMode>('qa');

  return (
    <PageSection
      title="Browser"
      description="Diagnostics for the AgentCore Browser capability. Crawling lives in Knowledge → Sources, where a survey scopes it first."
      actions={
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as BrowserMode)}
          options={[
            { value: 'qa',       label: '🔎 Web Q&A' },
            { value: 'journey',  label: '🛤  Journey Recorder' },
            { value: 'sessions', label: '⚙ Sessions' },
          ]}
        />
      }
    >
      {mode === 'qa' && <WebQATab />}
      {mode === 'journey' && <JourneyTab />}
      {mode === 'sessions' && <SessionsRawTab />}
    </PageSection>
  );
}

// ── Web Q&A: URL + question → screenshot + Nova Lite answer ────────────────

function WebQATab() {
  // Web Q&A spins up a real browser microVM — /api/capabilities mutations
  // require ManageDevbox.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  const [url, setUrl] = useState('https://example.com');
  const [question, setQuestion] = useState('What is this page about?');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; pageTitle: string; imageDataUrl: string | null; answer: string } | null>(null);

  async function ask() {
    if (!url.trim() || !question.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch('/api/capabilities/browser/web-qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, question }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setResult(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="md">
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Ask a webpage</h2>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Spins up a sandboxed Chrome, screenshots the page, sends it + your question to Nova Lite (multimodal). Returns an answer grounded in the visible content.
        </div>
      </div>

      {canManage ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://..."
            style={inputStyle()}
          />
          <input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ask()}
            placeholder="What do you want to know about this page?"
            style={inputStyle()}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={ask} disabled={busy || !url || !question} style={primaryBtnStyle(busy || !url || !question)}>
              {busy ? 'Asking…' : 'Ask the page'}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic', marginBottom: 12 }}>
          Viewing only — your role can&apos;t drive the browser.
        </div>
      )}

      {error && <div style={errBoxStyle()}>{error}</div>}

      {result && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Screenshot ({result.pageTitle || result.url})
            </div>
            {result.imageDataUrl ? (
              <div style={{ border: '1px solid var(--color-border)', borderRadius: 4, padding: 4, background: '#fafafa' }}>
                <img src={result.imageDataUrl} alt="page" style={{ width: '100%', display: 'block' }} />
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>(no screenshot)</div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Answer
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{result.answer}</div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Journey Recorder: build a sequence of URL visits with carousel + timeline ──

function JourneyTab() {
  // Starting/steering/ending a journey mutates /api/capabilities (ManageDevbox);
  // resuming to VIEW recorded steps is a read and stays open.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  const { data: sessionsData, refresh: refreshSessions } = useFetch<{ sessions: BrowserSession[] }>('/api/capabilities/browser-sessions', 10000);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [url, setUrl] = useState('https://example.com');
  const [label, setLabel] = useState('journey');
  const [navigating, setNavigating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'carousel' | 'timeline'>('carousel');
  const [carouselIdx, setCarouselIdx] = useState(0);

  const { data: journeyData, refresh: refreshJourney } = useFetch<{ steps: JourneyStep[] }>(
    activeSessionId ? `/api/capabilities/browser-sessions/${activeSessionId}/journey` : '',
    5000,
  );
  const steps = journeyData?.steps ?? [];

  const openSessions = (sessionsData?.sessions ?? []).filter(s => s.status !== 'CLOSED');

  async function startJourney() {
    setNavigating(true);
    setError(null);
    try {
      const r = await fetch('/api/capabilities/browser-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentName: label, url }),
      });
      const body = await r.json();
      if (!r.ok || !body.session?.sessionId) throw new Error(body.error || 'launch failed');
      setActiveSessionId(body.session.sessionId);
      // First step gets a screenshot — call navigate explicitly with capture flag
      // to populate the journey ring (the launch endpoint navigates but doesn't
      // capture into the journey).
      await fetch(`/api/capabilities/browser-sessions/${body.session.sessionId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, captureScreenshot: true }),
      });
      setCarouselIdx(0);
      refreshJourney();
      refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setNavigating(false);
    }
  }

  async function stepTo(nextUrl: string) {
    if (!activeSessionId) return;
    setNavigating(true);
    setError(null);
    try {
      const r = await fetch(`/api/capabilities/browser-sessions/${activeSessionId}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: nextUrl, captureScreenshot: true }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || 'navigate failed');
      }
      refreshJourney();
      // Jump carousel to the new step
      setCarouselIdx(steps.length);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setNavigating(false);
    }
  }

  async function endJourney() {
    if (!activeSessionId) return;
    await fetch(`/api/capabilities/browser-sessions/${activeSessionId}`, { method: 'DELETE' });
    refreshSessions();
    setActiveSessionId(null);
    setCarouselIdx(0);
  }

  return (
    <Card padding="md">
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Journey Recorder</h2>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Record an ordered series of web pages with screenshots. Replay as a carousel or scrollable timeline.
        </div>
      </div>

      {!activeSessionId ? (
        <div>
          {canManage ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="Journey label (e.g. competitor-research)"
                style={inputStyle()}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="Starting URL"
                  onKeyDown={e => e.key === 'Enter' && startJourney()}
                  style={{ ...inputStyle(), flex: 1 }}
                />
                <button onClick={startJourney} disabled={navigating || !url} style={primaryBtnStyle(navigating || !url)}>
                  {navigating ? 'Starting…' : 'Start journey'}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
              Viewing only — your role can&apos;t start a journey. Open sessions below can still be replayed.
            </div>
          )}

          {openSessions.length > 0 && (
            <div style={{ marginTop: 16, padding: 10, background: 'var(--color-surface-hover)', borderRadius: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Or resume an open session
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {openSessions.map(s => (
                  <button
                    key={s.sessionId}
                    onClick={() => { setActiveSessionId(s.sessionId); refreshJourney(); }}
                    style={{
                      textAlign: 'left',
                      padding: '6px 10px',
                      fontSize: 12,
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  >
                    <code style={{ fontFamily: 'monospace', fontSize: 11 }}>{s.sessionId}</code>
                    <span style={{ marginLeft: 8, color: 'var(--color-text-tertiary)' }}>{s.agentName}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div>
          {canManage && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="Next URL"
                onKeyDown={e => e.key === 'Enter' && stepTo(url)}
                style={{ ...inputStyle(), flex: 1 }}
              />
              <button onClick={() => stepTo(url)} disabled={navigating || !url} style={primaryBtnStyle(navigating || !url)}>
                {navigating ? 'Navigating…' : 'Navigate (record)'}
              </button>
              <button onClick={endJourney} style={{ ...primaryBtnStyle(false), background: 'var(--color-danger, #dc2626)' }}>
                End
              </button>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {steps.length} step{steps.length !== 1 ? 's' : ''} · session <code style={{ fontFamily: 'monospace', fontSize: 11 }}>{activeSessionId.slice(0, 12)}…</code>
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => setView('carousel')} style={tabBtn(view === 'carousel')}>Carousel</button>
              <button onClick={() => setView('timeline')} style={tabBtn(view === 'timeline')}>Timeline</button>
            </div>
          </div>

          {error && <div style={errBoxStyle()}>{error}</div>}

          {steps.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              No steps captured yet. Enter a URL above.
            </div>
          ) : view === 'carousel' ? (
            <Carousel steps={steps} idx={Math.min(carouselIdx, steps.length - 1)} onIdx={setCarouselIdx} />
          ) : (
            <Timeline steps={steps} onJump={(i) => { setView('carousel'); setCarouselIdx(i); }} />
          )}
        </div>
      )}
    </Card>
  );
}

function Carousel({ steps, idx, onIdx }: { steps: JourneyStep[]; idx: number; onIdx: (i: number) => void }) {
  const step = steps[idx];
  if (!step) return null;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <button onClick={() => onIdx(Math.max(0, idx - 1))} disabled={idx === 0} className={carouselArrowClass(idx === 0)}>‹</button>
        <div className="flex-1 text-center">
          <div className="text-xs font-semibold">{step.pageTitle || step.url}</div>
          <div className="text-[10px] font-mono text-text-tertiary mt-0.5">{step.url}</div>
          <div className="text-[10px] text-text-tertiary mt-0.5">
            Step {idx + 1} of {steps.length} · {new Date(step.startedAt).toLocaleTimeString()}
          </div>
        </div>
        <button onClick={() => onIdx(Math.min(steps.length - 1, idx + 1))} disabled={idx === steps.length - 1} className={carouselArrowClass(idx === steps.length - 1)}>›</button>
      </div>
      {step.imageDataUrl ? (
        <div className="border border-border rounded p-1 bg-[#fafafa]">
          <img src={step.imageDataUrl} alt={step.pageTitle} className="w-full block" />
        </div>
      ) : (
        <div className="p-6 text-center text-xs text-text-tertiary">(no screenshot)</div>
      )}
      {step.question && (
        <div className="mt-2.5 p-2.5 bg-surface-hover rounded">
          <div className="text-[11px] font-semibold text-text-tertiary">Q: {step.question}</div>
          <div className="text-xs mt-1">{step.answer}</div>
        </div>
      )}
      {/* Thumbnail strip */}
      <div className="flex gap-1.5 mt-3 overflow-x-auto pb-1">
        {steps.map((s, i) => (
          <button
            key={s.index}
            onClick={() => onIdx(i)}
            className={`flex-[0_0_auto] p-0 bg-surface cursor-pointer w-20 h-[50px] overflow-hidden rounded-[3px] ${i === idx ? 'border-2 border-primary' : 'border border-border'}`}
            title={s.pageTitle || s.url}
          >
            {s.imageDataUrl ? (
              <img src={s.imageDataUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-[9px] text-text-tertiary">{i + 1}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function Timeline({ steps, onJump }: { steps: JourneyStep[]; onJump: (i: number) => void }) {
  return (
    <div className="flex flex-col gap-2 max-h-[480px] overflow-y-auto">
      {steps.map((step, i) => (
        <button
          type="button"
          key={step.index}
          onClick={() => onJump(i)}
          aria-label={`Jump to step ${i + 1}`}
          className="flex gap-3 p-2 w-full text-left border border-border rounded cursor-pointer bg-surface"
        >
          <div className="flex-[0_0_120px] h-[76px] overflow-hidden rounded-[3px] bg-surface-inset">
            {step.imageDataUrl ? (
              <img src={step.imageDataUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="flex items-center justify-center h-full text-[10px] text-text-tertiary">no shot</div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold text-text-tertiary">#{i + 1}</span>
              <span className="text-[13px] font-medium">{step.pageTitle || step.url}</span>
            </div>
            <div className="text-[10px] font-mono text-text-tertiary mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap">
              {step.url}
            </div>
            <div className="text-[10px] text-text-tertiary mt-0.5">
              {new Date(step.startedAt).toLocaleTimeString()}
            </div>
            {step.question && (
              <div className="mt-1.5 text-[11px] text-text-secondary overflow-hidden line-clamp-2">
                <b>Q:</b> {step.question}
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

function SiteMap({ pages, onPickPage }: { pages: CrawlPage[]; onPickPage: (i: number) => void }) {
  const { nodes, edges } = useMemo(() => buildSiteMap(pages), [pages]);
  return (
    <div className="h-[480px] border border-border rounded">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          const idx = pages.findIndex(p => p.url === (node.data as { url: string }).url);
          if (idx >= 0) onPickPage(idx);
        }}
      >
        <Background gap={16} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}

function buildSiteMap(pages: CrawlPage[]): { nodes: Node[]; edges: Edge[] } {
  const urlToIdx = new Map<string, number>();
  pages.forEach((p, i) => urlToIdx.set(p.url, i));

  // Layout: column per depth, rows within column.
  const byDepth = new Map<number, CrawlPage[]>();
  for (const p of pages) {
    const arr = byDepth.get(p.depth) ?? [];
    arr.push(p);
    byDepth.set(p.depth, arr);
  }

  const COLW = 260;
  const ROWH = 96;

  const nodes: Node[] = pages.map((p) => {
    const col = byDepth.get(p.depth)!;
    const row = col.indexOf(p);
    return {
      id: p.url,
      position: { x: p.depth * COLW, y: row * ROWH },
      data: {
        url: p.url,
        label: (
          <div className="p-1 max-w-[200px] overflow-hidden">
            <div className="text-[11px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
              {p.title || new URL(p.url).pathname || p.url}
            </div>
            <div className="text-[9px] font-mono text-text-tertiary whitespace-nowrap overflow-hidden text-ellipsis">
              {p.url.replace(/^https?:\/\//, '')}
            </div>
            <div className={`text-[9px] mt-0.5 ${p.error ? 'text-danger' : 'text-text-tertiary'}`}>
              {p.error ? `error: ${p.error.slice(0, 40)}` : p.s3Key ? `↑ S3 · ${p.contentLength} chars` : `${p.contentLength} chars`}
            </div>
          </div>
        ),
      },
      style: {
        border: '1px solid ' + (p.error ? 'var(--color-danger)' : 'var(--color-border-emphasis)'),
        background: p.error ? 'var(--color-danger-bg)' : 'var(--color-surface)',
        padding: 0,
        borderRadius: 4,
        fontSize: 11,
        width: 220,
      },
    };
  });

  const edges: Edge[] = [];
  // Edges from parentUrl (the link that led us here) — gives clean tree shape.
  for (const p of pages) {
    if (!p.parentUrl) continue;
    if (!urlToIdx.has(p.parentUrl)) continue;
    edges.push({
      id: `${p.parentUrl}->${p.url}`,
      source: p.parentUrl,
      target: p.url,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      style: { stroke: '#94a3b8' },
    });
  }
  return { nodes, edges };
}

// ── Sessions: raw open + closed session lists (admin power-user view) ───────

function SessionsRawTab() {
  // Launch/close mutate /api/capabilities (ManageDevbox); the lists stay.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  const { data, refresh } = useFetch<{ sessions: BrowserSession[] }>('/api/capabilities/browser-sessions', 10000);
  const [newSessionAgent, setNewSessionAgent] = useState('portal');
  const [newSessionUrl, setNewSessionUrl] = useState('');
  const [launching, setLaunching] = useState(false);

  async function launchSession() {
    if (!newSessionAgent) return;
    setLaunching(true);
    await fetch('/api/capabilities/browser-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: newSessionAgent, url: newSessionUrl || undefined }),
    });
    setNewSessionUrl('');
    setLaunching(false);
    refresh();
  }

  async function closeSession(sessionId: string) {
    await fetch(`/api/capabilities/browser-sessions/${sessionId}`, { method: 'DELETE' });
    refresh();
  }

  const sessions = data?.sessions ?? [];
  const open = sessions.filter(s => s.status !== 'CLOSED');
  const closed = sessions
    .filter(s => s.status === 'CLOSED')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const statusTone = (s: BrowserSession['status']): 'success' | 'warning' | 'neutral' =>
    s === 'ACTIVE' ? 'success' : s === 'IDLE' ? 'warning' : 'neutral';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Launch new session */}
      {canManage && (
      <Card padding="md">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Launch Browser Session</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="Session label (any text)"
            value={newSessionAgent}
            onChange={e => setNewSessionAgent(e.target.value)}
            style={{ flex: '0 0 160px', padding: '7px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)' }}
          />
          <input
            placeholder="Starting URL (optional)"
            value={newSessionUrl}
            onChange={e => setNewSessionUrl(e.target.value)}
            style={{ flex: 1, padding: '7px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)' }}
          />
          <button
            onClick={launchSession}
            disabled={!newSessionAgent || launching}
            style={{ padding: '7px 16px', fontSize: 12, background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', opacity: !newSessionAgent ? 0.5 : 1 }}
          >
            {launching ? 'Launching…' : 'Launch'}
          </button>
        </div>
      </Card>
      )}

      {/* Active sessions */}
      <Card padding="md">
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          Open Sessions <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400 }}>({open.length})</span>
        </h2>
        {open.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--color-text-secondary)', fontSize: 13 }}>
            No open browser sessions.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Label</TableTh>
                <TableTh>Status</TableTh>
                <TableTh>Current URL</TableTh>
                <TableTh>Requests</TableTh>
                <TableTh>Last Active</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {open.map(session => (
                <TableRow key={session.sessionId}>
                  <TableTd style={{ fontWeight: 500 }}>{session.agentName}</TableTd>
                  <TableTd><Chip tone={statusTone(session.status)} size="xs">{session.status}</Chip></TableTd>
                  <TableTd style={{ fontSize: 11, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {session.currentUrl === 'about:blank' ? <span style={{ color: 'var(--color-text-tertiary)' }}>—</span> : (
                      <a href={session.currentUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>
                        {session.currentUrl}
                      </a>
                    )}
                  </TableTd>
                  <TableTd>{session.requestCount}</TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{formatAge(session.lastActivityAt)}</TableTd>
                  <TableTd>
                    {canManage && (
                      <button
                        onClick={() => closeSession(session.sessionId)}
                        style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                      >
                        Close
                      </button>
                    )}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Past sessions */}
      <Card padding="md">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Past Sessions{' '}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-tertiary)' }}>
              from AgentCore Data Plane
            </span>
          </h2>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {closed.length} closed
          </span>
        </div>
        {closed.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            No past sessions yet. Launch one above or invoke the search agent with a Browse-the-web prompt.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Started</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Last URL</TableTh>
                <TableTh>Requests</TableTh>
                <TableTh>Status</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {closed.slice(0, 20).map(s => (
                <TableRow key={s.sessionId}>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                    {new Date(s.startedAt).toLocaleString()}
                  </TableTd>
                  <TableTd style={{ fontSize: 12 }}>{s.agentName}</TableTd>
                  <TableTd style={{ fontSize: 11, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.currentUrl}>
                    {s.currentUrl === 'about:blank' ? <span style={{ color: 'var(--color-text-tertiary)' }}>—</span> : s.currentUrl}
                  </TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{s.requestCount}</TableTd>
                  <TableTd><Chip tone="neutral" size="xs">{s.status}</Chip></TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ─── Local helpers ────────────────────────────────────────────────────────────

function inputStyle(): React.CSSProperties {
  return {
    padding: '7px 10px',
    fontSize: 12,
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-surface)',
    outline: 'none',
  };
}

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '7px 16px',
    fontSize: 12,
    background: 'var(--color-primary)',
    color: 'var(--color-surface)',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    fontWeight: 500,
  };
}

function errBoxStyle(): React.CSSProperties {
  return {
    padding: 8,
    background: 'var(--color-danger-bg)',
    color: 'var(--color-danger)',
    fontSize: 12,
    borderRadius: 4,
    marginBottom: 12,
  };
}

function tabBtn(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '4px 10px',
    background: active ? 'var(--color-primary)' : 'var(--color-surface)',
    color: active ? '#fff' : 'var(--color-text-secondary)',
    border: '1px solid ' + (active ? 'var(--color-primary)' : 'var(--color-border)'),
    borderRadius: 4,
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
  };
}

function carouselArrowClass(disabled: boolean): string {
  return `w-8 h-8 rounded-full border border-border bg-surface text-text-primary text-lg font-semibold ${disabled ? 'cursor-not-allowed opacity-30' : 'cursor-pointer opacity-100'}`;
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0, position: 'relative',
        background: value ? 'var(--color-success, #16a34a)' : 'var(--color-border, #e2e8f0)',
        transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: value ? 19 : 3, width: 14, height: 14,
        borderRadius: '50%', background: 'var(--color-surface)', transition: 'left 0.15s',
      }} />
    </button>
  );
}

function formatAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export default BrowserPage;
