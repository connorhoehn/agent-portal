import { useState, useEffect, useRef, useMemo } from 'react';
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Card, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip, SegmentedControl } from '@connorhoehnslalom/ui-components/shared';
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

type BrowserMode = 'qa' | 'journey' | 'crawl' | 'sessions';
type CrawlView = 'carousel' | 'timeline' | 'sitemap';

// ─── Page ─────────────────────────────────────────────────────────────────────

function BrowserPage() {
  const [mode, setMode] = useState<BrowserMode>('qa');

  return (
    <div className="p-6">
      <div className="flex flex-col gap-4">
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as BrowserMode)}
          options={[
            { value: 'qa',       label: '🔎 Web Q&A' },
            { value: 'journey',  label: '🛤  Journey Recorder' },
            { value: 'crawl',    label: '🕸 Doc Crawler' },
            { value: 'sessions', label: '⚙ Sessions' },
          ]}
        />

        {mode === 'qa' && <WebQATab />}
        {mode === 'journey' && <JourneyTab />}
        {mode === 'crawl' && <CrawlTab />}
        {mode === 'sessions' && <SessionsRawTab />}
      </div>
    </div>
  );
}

// ── Web Q&A: URL + question → screenshot + Nova Lite answer ────────────────

function WebQATab() {
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <button onClick={() => onIdx(Math.max(0, idx - 1))} disabled={idx === 0} style={carouselArrowStyle(idx === 0)}>‹</button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{step.pageTitle || step.url}</div>
          <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)', marginTop: 2 }}>{step.url}</div>
          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
            Step {idx + 1} of {steps.length} · {new Date(step.startedAt).toLocaleTimeString()}
          </div>
        </div>
        <button onClick={() => onIdx(Math.min(steps.length - 1, idx + 1))} disabled={idx === steps.length - 1} style={carouselArrowStyle(idx === steps.length - 1)}>›</button>
      </div>
      {step.imageDataUrl ? (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 4, padding: 4, background: '#fafafa' }}>
          <img src={step.imageDataUrl} alt={step.pageTitle} style={{ width: '100%', display: 'block' }} />
        </div>
      ) : (
        <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>(no screenshot)</div>
      )}
      {step.question && (
        <div style={{ marginTop: 10, padding: 10, background: 'var(--color-surface-hover)', borderRadius: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>Q: {step.question}</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>{step.answer}</div>
        </div>
      )}
      {/* Thumbnail strip */}
      <div style={{ display: 'flex', gap: 6, marginTop: 12, overflowX: 'auto', paddingBottom: 4 }}>
        {steps.map((s, i) => (
          <button
            key={s.index}
            onClick={() => onIdx(i)}
            style={{
              flex: '0 0 auto',
              border: i === idx ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
              padding: 0,
              background: 'var(--color-surface)',
              cursor: 'pointer',
              width: 80,
              height: 50,
              overflow: 'hidden',
              borderRadius: 3,
            }}
            title={s.pageTitle || s.url}
          >
            {s.imageDataUrl ? (
              <img src={s.imageDataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>{i + 1}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function Timeline({ steps, onJump }: { steps: JourneyStep[]; onJump: (i: number) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 480, overflowY: 'auto' }}>
      {steps.map((step, i) => (
        <button
          type="button"
          key={step.index}
          onClick={() => onJump(i)}
          aria-label={`Jump to step ${i + 1}`}
          style={{
            display: 'flex',
            gap: 12,
            padding: 8,
            width: '100%',
            textAlign: 'left',
            border: '1px solid var(--color-border)',
            borderRadius: 4,
            cursor: 'pointer',
            background: 'var(--color-surface)',
          }}
        >
          <div style={{ flex: '0 0 120px', height: 76, overflow: 'hidden', borderRadius: 3, background: 'var(--color-surface-inset)' }}>
            {step.imageDataUrl ? (
              <img src={step.imageDataUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 10, color: 'var(--color-text-tertiary)' }}>no shot</div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>#{i + 1}</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{step.pageTitle || step.url}</span>
            </div>
            <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {step.url}
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
              {new Date(step.startedAt).toLocaleTimeString()}
            </div>
            {step.question && (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-secondary)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any }}>
                <b>Q:</b> {step.question}
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Doc Crawler: autonomous BFS crawl that feeds the KB ─────────────────────

function CrawlTab() {
  const [startUrl, setStartUrl] = useState('https://example.com');
  const [maxPages, setMaxPages] = useState(10);
  const [includePattern, setIncludePattern] = useState('');
  const [sameOriginOnly, setSameOriginOnly] = useState(true);
  const [label, setLabel] = useState('docs-crawl');

  const [active, setActive] = useState<CrawlSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [view, setView] = useState<CrawlView>('carousel');
  const [carouselIdx, setCarouselIdx] = useState(0);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  // Cache screenshots from the underlying journey ring so the carousel has imagery.
  const { data: journeyData, refresh: refreshJourney } = useFetch<{ steps: JourneyStep[] }>(
    active?.sessionId ? `/api/capabilities/browser-sessions/${active.sessionId}/journey` : '',
    active?.status === 'running' ? 4000 : 0,
  );
  const steps = journeyData?.steps ?? [];

  // Subscribe to SSE for live progress.
  const esRef = useRef<EventSource | null>(null);
  useEffect(() => {
    esRef.current?.close();
    esRef.current = null;
    if (!active || active.status !== 'running') return;
    const es = new EventSource(`/api/capabilities/browser/crawl/${active.id}/stream`);
    esRef.current = es;
    es.onmessage = (evt) => {
      try {
        const ev = JSON.parse(evt.data);
        if (ev.session) setActive(ev.session as CrawlSession);
        if (ev.type === 'page') refreshJourney();
        if (ev.type === 'completed' || ev.type === 'cancelled' || ev.type === 'failed') {
          es.close();
          refreshJourney();
        }
      } catch { /* ignore parse errors */ }
    };
    es.onerror = () => { es.close(); };
    return () => { es.close(); };
  }, [active?.id, active?.status]);

  async function start() {
    setError(null);
    setSyncMsg(null);
    setStarting(true);
    try {
      const r = await fetch('/api/capabilities/browser/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrl,
          maxPages,
          includePattern: includePattern.trim() || undefined,
          sameOriginOnly,
          label,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setActive(body.crawl as CrawlSession);
      setCarouselIdx(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!active) return;
    await fetch(`/api/capabilities/browser/crawl/${active.id}/cancel`, { method: 'POST' });
  }

  async function triggerKbSync() {
    setSyncMsg(null);
    try {
      // Look up the first available data source and start an ingestion job.
      const ds = await fetch('/api/ingest/data-sources').then(r => r.json());
      const dsId = ds?.sources?.[0]?.id;
      if (!dsId) { setSyncMsg('No data source configured — set KNOWLEDGE_BASE_ID first.'); return; }
      const r = await fetch('/api/ingest/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId: dsId, description: `Doc crawl ${active?.id?.slice(0, 8)}` }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) { setSyncMsg(body.error || 'Sync failed'); return; }
      setSyncMsg(`KB sync started: ${body.job.jobId.slice(0, 12)}…`);
    } catch (e) {
      setSyncMsg((e as Error).message);
    }
  }

  // Merge crawl pages with journey screenshots (matched by URL).
  const stepsByUrl = useMemo(() => {
    const m = new Map<string, JourneyStep>();
    for (const s of steps) m.set(s.url, s);
    return m;
  }, [steps]);

  const journeySteps: JourneyStep[] = (active?.pages ?? []).map((p, i) => {
    const fromJourney = stepsByUrl.get(p.url);
    return {
      index: i,
      startedAt: p.crawledAt,
      url: p.url,
      pageTitle: p.title || fromJourney?.pageTitle || p.url,
      textSnippet: p.textSnippet,
      imageDataUrl: fromJourney?.imageDataUrl,
    };
  });

  const progress = active ? Math.round((active.pages.length / active.maxPages) * 100) : 0;
  const errorCount = (active?.pages ?? []).filter(p => p.error).length;
  const indexedCount = (active?.pages ?? []).filter(p => p.s3Key).length;

  return (
    <Card padding="md">
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Doc Discovery Crawler</h2>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          BFS crawl from a starting URL — extracts page text, screenshots, and links. Each page lands in the
          documents S3 bucket so a KB sync can index it.
        </div>
      </div>

      {!active || active.status !== 'running' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
          <input
            value={startUrl}
            onChange={e => setStartUrl(e.target.value)}
            placeholder="https://docs.example.com"
            style={inputStyle()}
          />
          <input
            type="number" min={1} max={50}
            value={maxPages}
            onChange={e => setMaxPages(Math.max(1, Math.min(50, parseInt(e.target.value) || 10)))}
            placeholder="Max pages"
            style={inputStyle()}
          />
          <input
            value={includePattern}
            onChange={e => setIncludePattern(e.target.value)}
            placeholder="path regex (optional)"
            style={inputStyle()}
          />
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Crawl label"
            style={inputStyle()}
          />
        </div>
      ) : null}

      {!active || active.status !== 'running' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <Toggle value={sameOriginOnly} onChange={setSameOriginOnly} />
            Same-origin only
          </label>
          <div style={{ flex: 1 }} />
          <button onClick={start} disabled={starting || !startUrl} style={primaryBtnStyle(starting || !startUrl)}>
            {starting ? 'Starting…' : 'Start Crawl'}
          </button>
        </div>
      ) : null}

      {error && <div style={errBoxStyle()}>{error}</div>}

      {active && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Chip
                tone={active.status === 'completed' ? 'success' : active.status === 'running' ? 'warning' : active.status === 'failed' ? 'danger' : 'neutral'}
                size="xs"
              >
                {active.status}
              </Chip>
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {active.pages.length} / {active.maxPages} pages
                {active.queued > 0 ? ` · ${active.queued} queued` : ''}
                {errorCount > 0 ? ` · ${errorCount} errors` : ''}
                {indexedCount > 0 ? ` · ${indexedCount} uploaded` : ''}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {active.status === 'running' && (
                <button onClick={cancel} style={{ ...primaryBtnStyle(false), background: 'var(--color-danger, #dc2626)' }}>Cancel</button>
              )}
              {active.status === 'completed' && indexedCount > 0 && (
                <button onClick={triggerKbSync} style={primaryBtnStyle(false)}>Trigger KB Sync</button>
              )}
              {active.status !== 'running' && (
                <button onClick={() => { setActive(null); setCarouselIdx(0); }} style={{ ...primaryBtnStyle(false), background: 'transparent', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}>New Crawl</button>
              )}
            </div>
          </div>
          <div style={{ height: 4, background: 'var(--color-border)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: 'var(--color-primary)', transition: 'width 0.4s' }} />
          </div>
          {syncMsg && (
            <div style={{ marginTop: 8, fontSize: 11, color: syncMsg.includes('started') ? 'var(--color-success)' : 'var(--color-danger)' }}>
              {syncMsg}
            </div>
          )}
        </div>
      )}

      {active && active.pages.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginBottom: 8 }}>
            <button onClick={() => setView('carousel')} style={tabBtn(view === 'carousel')}>Carousel</button>
            <button onClick={() => setView('timeline')} style={tabBtn(view === 'timeline')}>Timeline</button>
            <button onClick={() => setView('sitemap')} style={tabBtn(view === 'sitemap')}>Site Map</button>
          </div>
          {view === 'carousel' && journeySteps.length > 0 && (
            <Carousel steps={journeySteps} idx={Math.min(carouselIdx, journeySteps.length - 1)} onIdx={setCarouselIdx} />
          )}
          {view === 'timeline' && (
            <Timeline steps={journeySteps} onJump={(i) => { setView('carousel'); setCarouselIdx(i); }} />
          )}
          {view === 'sitemap' && <SiteMap pages={active.pages} onPickPage={(i) => { setView('carousel'); setCarouselIdx(i); }} />}
        </>
      )}

      {active && active.pages.length === 0 && active.status === 'running' && (
        <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Crawling first page…
        </div>
      )}
    </Card>
  );
}

function SiteMap({ pages, onPickPage }: { pages: CrawlPage[]; onPickPage: (i: number) => void }) {
  const { nodes, edges } = useMemo(() => buildSiteMap(pages), [pages]);
  return (
    <div style={{ height: 480, border: '1px solid var(--color-border)', borderRadius: 4 }}>
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
          <div style={{ padding: 4, maxWidth: 200, overflow: 'hidden' }}>
            <div style={{ fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {p.title || new URL(p.url).pathname || p.url}
            </div>
            <div style={{ fontSize: 9, fontFamily: 'monospace', color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {p.url.replace(/^https?:\/\//, '')}
            </div>
            <div style={{ fontSize: 9, marginTop: 2, color: p.error ? 'var(--color-danger)' : 'var(--color-text-tertiary)' }}>
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
                    <button
                      onClick={() => closeSession(session.sessionId)}
                      style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                    >
                      Close
                    </button>
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

function carouselArrowStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text-primary)',
    fontSize: 18,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.3 : 1,
  };
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
