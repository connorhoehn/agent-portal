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
import {
  Button, Card, EntityCell, Inline, InlineAlert, MetaLine, ProgressBar, SectionLabel, Stack, Table, TableBody, TableHead, TableRow, TableTd, TableTh,
} from '@connorhoehnslalom/ui-components/shared';

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
      <Inline gap="sm" align="center" wrap className="px-3.5 py-3 border-b border-border">
        <SectionLabel>WHAT THE SCORE IS DOING</SectionLabel>
        <MetaLine size="xs" items={['the stored composite_score, fitted in the Code Interpreter']} />
        {analysis && (
          <MetaLine
            size="xs"
            className="ml-auto"
            items={[`${analysis.people} people`, `${(analysis.durationMs / 1000).toFixed(1)}s`]}
          />
        )}
        <Button variant="secondary" size="sm" disabled={running} onClick={() => void run()}>
          {running ? 'computing…' : analysis ? 'Recompute' : 'Analyse scores'}
        </Button>
      </Inline>

      {error && <InlineAlert tone="error" className="m-3.5">{error}</InlineAlert>}

      {!analysis && !error && (
        <MetaLine
          size="sm"
          className="px-3.5 py-3 leading-snug"
          items={['Fits the composite against expertise and PageRank to show what it actually weights, how much the signals overlap, and who is ranked somewhere the signals don’t justify. Runs on demand — it costs a Code Interpreter session.']}
        />
      )}

      {analysis && (
        <>
          <MetaLine
            size="xs"
            className="px-3.5 py-2 border-b border-border leading-snug"
            items={['This describes people.composite_score as stored — the number agents and every other surface use. The ranking below is re-weighted live by the slider from influence and expertise, so it is a different number on a different scale.']}
          />

          {/* A null fit is a real outcome, not a rendering gap: it happens when
              the two signals are collinear, so no unique blend explains the
              composite. Saying nothing looked like the panel had failed. */}
          {!analysis.weights && (
            <MetaLine
              size="sm"
              className="px-3.5 py-3 border-b border-border leading-snug"
              items={['No unique blend fits. Expertise and PageRank move together closely enough here that many different weightings would reproduce the composite equally well — the correlations below still hold, but the split cannot be pinned down.']}
            />
          )}

          {analysis.weights && (
            <Stack gap="sm" className="px-3.5 py-3 border-b border-border">
              <EntityCell label={analysis.weights.reading} className="min-w-0" />
              <Inline gap="sm" align="center">
                {/* One bar, expertise's share of it. The old markup was two
                    absolutely-sized divs whose widths were inline styles; a
                    ProgressBar states the same split as a value out of 100. */}
                <ProgressBar
                  className="flex-1"
                  value={Math.round(analysis.weights.expertiseShare * 100)}
                  max={100}
                  size="sm"
                  showRatio={false}
                  aria-label={`Expertise ${Math.round(analysis.weights.expertiseShare * 100)}%, PageRank ${Math.round((1 - analysis.weights.expertiseShare) * 100)}%`}
                />
                <MetaLine size="xs" className="shrink-0 tabular-nums" items={[`R² ${num(analysis.weights.r2)}`]} />
              </Inline>
              <Inline gap="md" wrap>
                <MetaLine size="xs" className="text-primary" items={[`Expertise ${Math.round(analysis.weights.expertiseShare * 100)}%`]} />
                <MetaLine size="xs" className="text-warning" items={[`PageRank ${Math.round((1 - analysis.weights.expertiseShare) * 100)}%`]} />
                <MetaLine
                  size="xs"
                  className="font-mono"
                  items={[`composite ≈ ${num(analysis.weights.expertise, 3)}·expertise ${analysis.weights.pagerank >= 0 ? '+' : '−'} ${num(Math.abs(analysis.weights.pagerank), 3)}·pagerank ${analysis.weights.intercept >= 0 ? '+' : '−'} ${num(Math.abs(analysis.weights.intercept), 2)}`]}
                />
              </Inline>
              {analysis.weights.r2 > 0.999 && (
                <InlineAlert tone="warning">
                  An exact fit means this column is derived, not measured. Showing it beside its own inputs
                  invites double-counting the same evidence.
                </InlineAlert>
              )}
              {analysis.weights.r2 < 0.5 && (
                <InlineAlert tone="warning">
                  A low R² means the composite is not mostly a function of these two signals — treat the
                  split above as a weak description.
                </InlineAlert>
              )}
            </Stack>
          )}

          {/* ── How much the signals overlap ─────────────────────────────── */}
          <Stack gap="sm" className="px-3.5 py-3 border-b border-border">
            <SectionLabel as="div">Do the signals say different things?</SectionLabel>
            <Inline gap="md" wrap className="grid gap-2 grid-cols-1 sm:grid-cols-3">
              {analysis.correlations.map((c) => (
                <Stack key={`${c.a}-${c.b}`} gap="none">
                  <MetaLine size="xs" tone="secondary" items={[`${SIGNAL_LABEL[c.a] ?? c.a} ↔ ${SIGNAL_LABEL[c.b] ?? c.b}`]} />
                  <EntityCell label={num(c.spearman)} labelClassName="text-[15px] tabular-nums" className="mt-0.5" />
                  <MetaLine size="xs" items={[strength(c.spearman)]} />
                </Stack>
              ))}
            </Inline>
            <MetaLine
              size="xs"
              className="leading-snug"
              items={['Rank correlation. Two signals that agree completely are one signal counted twice.']}
            />
          </Stack>

          {/* ── Shape of each signal ─────────────────────────────────────── */}
          <Stack gap="none" className="overflow-x-auto border-b border-border">
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh align="left">Signal</TableTh>
                  <TableTh align="right">Median</TableTh>
                  <TableTh align="right">p90</TableTh>
                  <TableTh align="right">Max</TableTh>
                  <TableTh align="right">Top 10% hold</TableTh>
                  <TableTh align="right">Gini</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {analysis.distributions.map((d) => (
                  <TableRow key={d.signal}>
                    <TableTd>{SIGNAL_LABEL[d.signal] ?? d.signal}</TableTd>
                    <TableTd align="right">{num(d.median)}</TableTd>
                    <TableTd align="right">{num(d.p90)}</TableTd>
                    <TableTd align="right">{num(d.max)}</TableTd>
                    <TableTd align="right">{(d.topDecileShare * 100).toFixed(0)}%</TableTd>
                    <TableTd align="right">{num(d.gini)}</TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Stack>

          {/* ── Where the ranking disagrees with its own inputs ──────────── */}
          {analysis.disagreements.length === 0 && analysis.weights && analysis.weights.r2 > 0.999 && (
            <MetaLine
              size="sm"
              className="px-3.5 py-3 leading-snug"
              items={['Nobody is ranked differently than the signals imply — the composite reproduces them exactly, so there is nothing here to disagree with.']}
            />
          )}

          {analysis.disagreements.length > 0 && (
            <Stack gap="none">
              <SectionLabel as="div" className="px-3.5 py-2">Ranked differently than the signals imply</SectionLabel>
              {analysis.disagreements.slice(0, 8).map((d) => (
                <Inline key={d.personId} gap="md" align="center" className="px-3.5 py-2 border-t border-border">
                  <MetaLine
                    size="xs"
                    className={`tabular-nums shrink-0 w-12 text-right ${d.rankDelta > 0 ? 'text-success' : 'text-warning'}`}
                    items={[`${d.rankDelta > 0 ? '+' : ''}${d.rankDelta}`]}
                  />
                  <Stack gap="none" className="flex-1 min-w-0">
                    <MetaLine size="sm" className="truncate" items={[d.name]} />
                    {d.team && <MetaLine size="xs" className="truncate" items={[d.team]} />}
                  </Stack>
                  <MetaLine
                    size="xs"
                    className="tabular-nums shrink-0"
                    items={[`ranked #${d.compositeRank}, signals say #${d.predictedRank}`]}
                  />
                </Inline>
              ))}
              <MetaLine
                size="xs"
                className="px-3.5 py-2.5 leading-snug border-t border-border"
                items={['A large gap means the composite places someone where expertise and PageRank alone would not. That is worth looking at — it is either a scoring bug or a signal the model cannot see.']}
              />
            </Stack>
          )}

          {analysis.stderr && (
            <details className="border-t border-border">
              <summary className="px-3.5 py-2 text-[11px] text-text-tertiary cursor-pointer select-none">
                Sandbox output
              </summary>
              <MetaLine
                size="xs"
                className="px-3.5 pb-3 font-mono whitespace-pre-wrap"
                items={[analysis.stderr]}
              />
            </details>
          )}
        </>
      )}
    </Card>
  );
}
