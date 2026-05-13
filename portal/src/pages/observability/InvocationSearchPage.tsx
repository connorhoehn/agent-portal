// InvocationSearchPage — rich filter panel + results table for triage.
//
// Backend: GET /api/observability/invocations/search?... → { invocations, count }
// Polling: 30s, but only when results are loaded (i.e. a query has been run).
//
// Pattern is mirrored on DriftPage / QualityPage: Card/Table primitives,
// `useFetch` hook, defensive parsing, EmptyState component, CostChip +
// PromptVersionChip reused verbatim from Sprint 1.

import { useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { CostChip } from '../../components/observability/CostChip';
import { PromptVersionChip } from '../../components/observability/PromptVersionChip';

interface InvocationSearchResult {
  invocationId: string;
  agentId: string;
  agentName: string;
  templateId: string | null;
  promptSnippet: string;
  responseSnippet: string;
  judgeScore: number | null;
  schemaValid: boolean | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  promptVersion: string | null;
  modelId: string | null;
  parentInvocationId: string | null;
  userId: string | null;
  ts: string;
}

interface SearchResponse {
  invocations: InvocationSearchResult[];
  count: number;
}

interface DriftSummaryRow {
  agentId: string;
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const judgeTone = (v: number | null): Tone =>
  v == null ? 'neutral' : v >= 0.75 ? 'success' : v >= 0.55 ? 'warning' : 'danger';

const fmt = (n: number | null | undefined, digits = 2): string =>
  n != null && Number.isFinite(n) ? Number(n).toFixed(digits) : '—';

const fmtDur = (ms: number | null | undefined): string => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
};

function isoLocal(d: Date): string {
  // YYYY-MM-DDThh:mm — what the datetime-local input wants. Truncate the
  // timezone offset so the user sees their wall clock.
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function defaultSince(): string {
  return isoLocal(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

function defaultUntil(): string {
  return isoLocal(new Date());
}

function toIsoOrEmpty(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

interface FilterState {
  q: string;
  agentId: string;
  mode: 'all' | 'live' | 'sim';
  minScore: string;
  maxScore: string;
  since: string;
  until: string;
  promptVersion: string;
  userId: string;
}

function defaultFilters(): FilterState {
  return {
    q: '',
    agentId: '',
    mode: 'all',
    minScore: '',
    maxScore: '',
    since: defaultSince(),
    until: defaultUntil(),
    promptVersion: '',
    userId: '',
  };
}

function buildUrl(f: FilterState): string {
  const params = new URLSearchParams();
  if (f.q) params.set('q', f.q);
  if (f.agentId) params.set('agentId', f.agentId);
  if (f.mode && f.mode !== 'all') params.set('mode', f.mode);
  if (f.minScore) params.set('minScore', f.minScore);
  if (f.maxScore) params.set('maxScore', f.maxScore);
  const since = toIsoOrEmpty(f.since);
  const until = toIsoOrEmpty(f.until);
  if (since) params.set('since', since);
  if (until) params.set('until', until);
  if (f.promptVersion) params.set('promptVersion', f.promptVersion);
  if (f.userId) params.set('userId', f.userId);
  params.set('limit', '50');
  return `/api/observability/invocations/search?${params.toString()}`;
}

function snip(s: string | null | undefined, max = 80): string {
  if (!s) return '—';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function InvocationSearchPage() {
  const navigate = useNavigate();

  // Working filter state (edited freely until Search pressed).
  const [draft, setDraft] = useState<FilterState>(defaultFilters);
  // Applied filter state (only this drives the fetch URL — protects against
  // typing-as-you-go thrash).
  const [applied, setApplied] = useState<FilterState | null>(null);

  const url = applied ? buildUrl(applied) : '';
  const { data, isLoading, error } = useFetch<SearchResponse>(url, 30_000);

  const rows = useMemo<InvocationSearchResult[]>(() => {
    if (!data) return [];
    if (Array.isArray(data)) return data as InvocationSearchResult[];
    return Array.isArray(data.invocations) ? data.invocations : [];
  }, [data]);

  const totalCount = data?.count ?? rows.length;

  // Agent options derived from drift summary endpoint (same as QualityPage).
  const { data: agentsSummary } = useFetch<DriftSummaryRow[]>(
    '/api/observability/drift/summary?windowHours=24',
    30_000,
  );
  const agentOptions = useMemo(
    () =>
      Array.isArray(agentsSummary) ? agentsSummary.map((a) => a.agentId).sort() : [],
    [agentsSummary],
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setApplied({ ...draft });
  }

  function onClear() {
    const fresh = defaultFilters();
    setDraft(fresh);
    setApplied(null);
  }

  function update<K extends keyof FilterState>(key: K, val: FilterState[K]) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  return (
    <div style={pageStyle}>
      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Search Invocations{' '}
            <span style={hint}>
              {applied
                ? `30s refresh · ${rows.length} loaded of ${totalCount}`
                : 'filter to triage by prompt / agent / score'}
            </span>
          </h2>
        </div>
        <form onSubmit={onSubmit} style={form}>
          <div style={filterGrid}>
            <label style={field}>
              <span style={lab}>Search prompt</span>
              <input
                type="text"
                value={draft.q}
                onChange={(e) => update('q', e.target.value)}
                placeholder="substring match…"
                style={input}
              />
            </label>

            <label style={field}>
              <span style={lab}>Agent</span>
              <select
                value={draft.agentId}
                onChange={(e) => update('agentId', e.target.value)}
                style={input}
              >
                <option value="">All</option>
                {agentOptions.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>

            <label style={field}>
              <span style={lab}>Mode</span>
              <select
                value={draft.mode}
                onChange={(e) =>
                  update('mode', e.target.value as FilterState['mode'])
                }
                style={input}
              >
                <option value="all">All</option>
                <option value="live">Live</option>
                <option value="sim">Sim</option>
              </select>
            </label>

            <label style={field}>
              <span style={lab}>Min judge score</span>
              <input
                type="number"
                value={draft.minScore}
                onChange={(e) => update('minScore', e.target.value)}
                placeholder="0.00"
                step="0.05"
                min="0"
                max="1"
                style={input}
              />
            </label>

            <label style={field}>
              <span style={lab}>Max judge score</span>
              <input
                type="number"
                value={draft.maxScore}
                onChange={(e) => update('maxScore', e.target.value)}
                placeholder="1.00"
                step="0.05"
                min="0"
                max="1"
                style={input}
              />
            </label>

            <label style={field}>
              <span style={lab}>Since</span>
              <input
                type="datetime-local"
                value={draft.since}
                onChange={(e) => update('since', e.target.value)}
                style={input}
              />
            </label>

            <label style={field}>
              <span style={lab}>Until</span>
              <input
                type="datetime-local"
                value={draft.until}
                onChange={(e) => update('until', e.target.value)}
                style={input}
              />
            </label>

            <label style={field}>
              <span style={lab}>Prompt version</span>
              <input
                type="text"
                value={draft.promptVersion}
                onChange={(e) => update('promptVersion', e.target.value)}
                placeholder="sha (full or partial)"
                style={input}
              />
            </label>

            <label style={field}>
              <span style={lab}>User id</span>
              <input
                type="text"
                value={draft.userId}
                onChange={(e) => update('userId', e.target.value)}
                placeholder="optional"
                style={input}
              />
            </label>
          </div>
          <div style={btnRow}>
            <button type="submit" style={btnPrimary}>
              Search
            </button>
            <button type="button" onClick={onClear} style={btnSecondary}>
              Clear
            </button>
          </div>
        </form>
      </Card>

      <Card padding="md">
        {!applied && (
          <EmptyState text="Use filters above to find invocations. Try widening the time range or removing filters." />
        )}
        {applied && error && (
          <EmptyState
            text={`Search failed: ${error}. The backend may not have the search endpoint yet.`}
          />
        )}
        {applied && !error && rows.length === 0 && (
          <EmptyState
            text={
              isLoading
                ? 'Searching…'
                : 'No invocations match. Try widening the time range or removing filters.'
            }
          />
        )}
        {applied && !error && rows.length > 0 && (
          <>
            <div style={resultHint}>
              Showing {rows.length} of {totalCount}
            </div>
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>When</TableTh>
                  <TableTh>Agent</TableTh>
                  <TableTh>Prompt</TableTh>
                  <TableTh>Response</TableTh>
                  <TableTh>Score</TableTh>
                  <TableTh>Cost</TableTh>
                  <TableTh>Prompt ver.</TableTh>
                  <TableTh>Duration</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.invocationId}
                    onClick={() =>
                      navigate(`/observability/invocations/${r.invocationId}`)
                    }
                    style={{ cursor: 'pointer' }}
                  >
                    <TableTd style={tsCell}>
                      {new Date(r.ts).toLocaleString()}
                    </TableTd>
                    <TableTd style={agentCell}>
                      {r.agentName || r.agentId}
                    </TableTd>
                    <TableTd style={snippetCell} title={r.promptSnippet}>
                      {snip(r.promptSnippet, 100)}
                    </TableTd>
                    <TableTd style={snippetCell} title={r.responseSnippet}>
                      {snip(r.responseSnippet, 100)}
                    </TableTd>
                    <TableTd>
                      <Chip tone={judgeTone(r.judgeScore)} size="xs">
                        {fmt(r.judgeScore)}
                      </Chip>
                    </TableTd>
                    <TableTd style={{ whiteSpace: 'nowrap' }}>
                      <CostChip cost={r.totalCostUsd} />
                    </TableTd>
                    <TableTd style={{ whiteSpace: 'nowrap' }}>
                      <PromptVersionChip promptVersion={r.promptVersion} />
                    </TableTd>
                    <TableTd style={numCell}>{fmtDur(r.durationMs)}</TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: 'center',
        fontSize: 12,
        color: 'var(--color-text-tertiary)',
      }}
    >
      {text}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
};

const headerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 12,
  gap: 12,
  flexWrap: 'wrap',
};

const h2: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };

const hint: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontWeight: 400,
};

const form: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const filterGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
};

const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const lab: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: 0.5,
  textTransform: 'uppercase',
};

const input: CSSProperties = {
  fontSize: 12,
  padding: '6px 8px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
};

const btnRow: CSSProperties = {
  display: 'flex',
  gap: 8,
};

const btnPrimary: CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 500,
  background: 'var(--color-primary, #6366f1)',
  color: '#fff',
  border: '1px solid var(--color-primary, #6366f1)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};

const btnSecondary: CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  background: 'var(--color-surface)',
  color: 'var(--color-text-secondary)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};

const resultHint: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  marginBottom: 8,
};

const tsCell: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  whiteSpace: 'nowrap',
};

const agentCell: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

const snippetCell: CSSProperties = {
  fontSize: 12,
  maxWidth: 280,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const numCell: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  whiteSpace: 'nowrap',
};

export default InvocationSearchPage;
