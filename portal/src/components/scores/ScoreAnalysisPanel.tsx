// What the composite score is actually doing.
//
// The three score columns are rendered as numbers everywhere else, which
// supports two questions: who is highest, and what is the number. It cannot
// answer the ones people actually ask — what is this score weighting, is it
// telling us anything the inputs don't already, and who is ranked somewhere
// the evidence doesn't support.
//
// Those are least-squares fits, rank correlations and concentration measures.
// They run in the Code Interpreter, which is used here as arithmetic rather
// than as a sandbox: the code is fixed and server-side, and what surfaces is
// the answer.

import { useCallback, useState } from 'react';
import { Card } from '@connorhoehnslalom/ui-components/shared';

interface Distribution {
  signal: string; n: number; mean: number; median: number; stdev: number;
  p25: number; p75: number; p90: number; min: number; max: number;
  topDecileShare: number; gini: number;
}
interface Weights {
  expertise: number; pagerank: number; intercept: number;
  expertiseShare: number; r2: number; reading: string;
}
interface Disagreement {
  personId: string; name: string; team: string | null;
  compositeRank: number; predictedRank: number; rankDelta: number;
  composite: number; predicted: number;
}
interface Analysis {
  people: number;
  distributions: Distribution[];
  correlations: Array<{ a: string; b: string; pearson: number; spearman: number }>;
  weights: Weights | null;
  disagreements: Disagreement[];
  durationMs: number; sessionId: string; computedAt: string;
  stderr?: string;
}

const SIGNAL_LABEL: Record<string, string> = {
  expertise: 'Expertise', pagerank: 'PageRank', composite: 'Composite',
};

function num(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(digits);
}

/** Correlation strength, said in words rather than left as a bare number. */
function strength(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.9) return 'almost the same ordering';
  if (a >= 0.7) return 'strongly related';
  if (a >= 0.4) return 'loosely related';
  if (a >= 0.2) return 'weakly related';
  return 'essentially unrelated';
}

export function ScoreAnalysisPanel() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/scores/analysis', { method: 'POST', credentials: 'include' });
      const body = await res.json() as Analysis & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setAnalysis(body);
    } catch (err) {
      setError((err as Error).message);
    } finally { setRunning(false); }
  }, []);

  return (
    <Card padding="none" className="overflow-hidden mb-4">
      <div className="px-3.5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">
          WHAT THE SCORE IS DOING
        </span>
        <span className="text-[11px] text-text-tertiary">
          fitted from the real numbers, in the Code Interpreter
        </span>
        <div className="flex-1" />
        {analysis && (
          <span className="text-[11px] text-text-tertiary">
            {analysis.people} people · {(analysis.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        <button
          disabled={running}
          onClick={() => void run()}
          className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
        >
          {running ? 'computing…' : analysis ? 'Recompute' : 'Analyse scores'}
        </button>
      </div>

      {error && (
        <div className="px-3.5 py-3 text-[12px] text-danger leading-snug">{error}</div>
      )}

      {!analysis && !error && (
        <div className="px-3.5 py-3 text-[12px] text-text-secondary leading-snug">
          Fits the composite against expertise and PageRank to show what it actually weights, how much the
          signals overlap, and who is ranked somewhere the signals don’t justify. Runs on demand — it costs
          a Code Interpreter session.
        </div>
      )}

      {analysis && (
        <>
          {analysis.weights && (
            <div className="px-3.5 py-3 border-b border-border">
              <div className="text-[13px] font-semibold text-text-primary leading-snug">
                {analysis.weights.reading}
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full overflow-hidden bg-surface-hover flex">
                  <div
                    className="bg-primary h-full"
                    style={{ width: `${Math.round(analysis.weights.expertiseShare * 100)}%` }}
                    title={`Expertise ${Math.round(analysis.weights.expertiseShare * 100)}%`}
                  />
                  <div
                    className="bg-warning h-full"
                    style={{ width: `${Math.round((1 - analysis.weights.expertiseShare) * 100)}%` }}
                    title={`PageRank ${Math.round((1 - analysis.weights.expertiseShare) * 100)}%`}
                  />
                </div>
                <span className="text-[11px] text-text-tertiary shrink-0 tabular-nums">
                  R² {num(analysis.weights.r2)}
                </span>
              </div>
              <div className="flex gap-4 mt-2 text-[11px] text-text-tertiary">
                <span><span className="inline-block w-2 h-2 rounded-full bg-primary mr-1" />Expertise</span>
                <span><span className="inline-block w-2 h-2 rounded-full bg-warning mr-1" />PageRank</span>
                <span className="font-mono">
                  composite ≈ {num(analysis.weights.expertise, 3)}·expertise
                  {analysis.weights.pagerank >= 0 ? ' + ' : ' − '}
                  {num(Math.abs(analysis.weights.pagerank), 3)}·pagerank
                  {analysis.weights.intercept >= 0 ? ' + ' : ' − '}
                  {num(Math.abs(analysis.weights.intercept), 2)}
                </span>
              </div>
              {analysis.weights.r2 < 0.5 && (
                <div className="text-[11px] text-warning mt-2 leading-snug">
                  A low R² means the composite is not mostly a function of these two signals — treat the
                  split above as a weak description.
                </div>
              )}
            </div>
          )}

          {/* ── How much the signals overlap ─────────────────────────────── */}
          <div className="px-3.5 py-3 border-b border-border">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-2">
              Do the signals say different things?
            </div>
            <div className="grid gap-2 grid-cols-1 sm:grid-cols-3">
              {analysis.correlations.map((c) => (
                <div key={`${c.a}-${c.b}`} className="text-[11px]">
                  <div className="text-text-secondary">
                    {SIGNAL_LABEL[c.a] ?? c.a} ↔ {SIGNAL_LABEL[c.b] ?? c.b}
                  </div>
                  <div className="text-[15px] font-bold text-text-primary tabular-nums leading-tight mt-0.5">
                    {num(c.spearman)}
                  </div>
                  <div className="text-text-tertiary">{strength(c.spearman)}</div>
                </div>
              ))}
            </div>
            <div className="text-[11px] text-text-tertiary mt-2 leading-snug">
              Rank correlation. Two signals that agree completely are one signal counted twice.
            </div>
          </div>

          {/* ── Shape of each signal ─────────────────────────────────────── */}
          <div className="overflow-x-auto border-b border-border">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-text-tertiary">
                  <th className="text-left font-semibold px-3.5 py-2">Signal</th>
                  <th className="text-right font-semibold px-3.5 py-2">Median</th>
                  <th className="text-right font-semibold px-3.5 py-2">p90</th>
                  <th className="text-right font-semibold px-3.5 py-2">Max</th>
                  <th className="text-right font-semibold px-3.5 py-2">Top 10% hold</th>
                  <th className="text-right font-semibold px-3.5 py-2">Gini</th>
                </tr>
              </thead>
              <tbody>
                {analysis.distributions.map((d) => (
                  <tr key={d.signal} className="border-t border-border">
                    <td className="px-3.5 py-2 font-semibold text-text-primary">
                      {SIGNAL_LABEL[d.signal] ?? d.signal}
                    </td>
                    <td className="px-3.5 py-2 text-right tabular-nums">{num(d.median)}</td>
                    <td className="px-3.5 py-2 text-right tabular-nums">{num(d.p90)}</td>
                    <td className="px-3.5 py-2 text-right tabular-nums">{num(d.max)}</td>
                    <td className="px-3.5 py-2 text-right tabular-nums">
                      {(d.topDecileShare * 100).toFixed(0)}%
                    </td>
                    <td className="px-3.5 py-2 text-right tabular-nums">{num(d.gini)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Where the ranking disagrees with its own inputs ──────────── */}
          {analysis.disagreements.length > 0 && (
            <div>
              <div className="px-3.5 py-2 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                Ranked differently than the signals imply
              </div>
              {analysis.disagreements.slice(0, 8).map((d) => (
                <div key={d.personId} className="px-3.5 py-2 border-t border-border flex items-center gap-3">
                  <span className={`text-[11px] font-semibold tabular-nums shrink-0 w-12 text-right ${
                    d.rankDelta > 0 ? 'text-success' : 'text-warning'}`}>
                    {d.rankDelta > 0 ? '+' : ''}{d.rankDelta}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-text-primary truncate">{d.name}</div>
                    {d.team && <div className="text-[11px] text-text-tertiary truncate">{d.team}</div>}
                  </div>
                  <span className="text-[11px] text-text-tertiary tabular-nums shrink-0">
                    ranked #{d.compositeRank}, signals say #{d.predictedRank}
                  </span>
                </div>
              ))}
              <div className="px-3.5 py-2.5 text-[11px] text-text-tertiary leading-snug border-t border-border">
                A large gap means the composite places someone where expertise and PageRank alone would not.
                That is worth looking at — it is either a scoring bug or a signal the model cannot see.
              </div>
            </div>
          )}

          {analysis.stderr && (
            <details className="border-t border-border">
              <summary className="px-3.5 py-2 text-[11px] text-text-tertiary cursor-pointer select-none">
                Sandbox output
              </summary>
              <pre className="px-3.5 pb-3 text-[10px] text-text-tertiary font-mono whitespace-pre-wrap">
                {analysis.stderr}
              </pre>
            </details>
          )}
        </>
      )}
    </Card>
  );
}
