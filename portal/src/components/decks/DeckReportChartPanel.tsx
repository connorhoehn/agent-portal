// "Fill from a report" (docs/deck-edit-operations.md, set_chart with a report): an inline panel in the editor's
// notice stack, never a dialog. It lists the reports the caller may chart (GET <deck>/:id/chart-reports), a chart
// kind and, when the report takes one, a period; Apply sends ONE set_chart operation on the saved head and the page
// reloads at the new revision. The operations route works on the saved head, so with unsaved edits the panel says
// to save first and Apply stays off (the revise-with-agent rule: useDeckAgentRun).

import { useState } from 'react';
import { Button, DetailSection, FormField, InlineAlert, Inline, SegmentedControl, Select, Stack, T } from '@connorhoehn/ui-components/shared';
import { DECK_CHART_KIND_LABELS, DECK_CHART_KINDS } from '@connorhoehn/ui-components/doc-editor';
import { applyDeckOperations, reportTakesPeriod, type DeckChartKindId, type DeckChartReport, type DeckOperationsResult, type DeckTenantId } from './deckApi';

export const SAVE_FIRST_LINE = 'Save your changes first: a report fills the saved version.';
const PERIODS = [{ value: '30d', label: 'Last 30 days' }, { value: '7d', label: 'Last 7 days' }, { value: 'month', label: 'This month' }];

export interface DeckReportChartPanelProps {
  tenant: DeckTenantId;
  deckId: string;
  /** The saved head the operation applies to; null while there is none. */
  headRevisionId: string | null;
  slide: { id: string; index: number; title: string; isChart: boolean } | null;
  reports: readonly DeckChartReport[];
  /** Unsaved edits on the page, or the page shows an older version than the head. */
  blockedReason: string | null;
  onApplied: (result: DeckOperationsResult) => void;
  onClose: () => void;
  testIdPrefix: string;
}

export function DeckReportChartPanel({ tenant, deckId, headRevisionId, slide, reports, blockedReason, onApplied, onClose, testIdPrefix }: DeckReportChartPanelProps) {
  const [reportId, setReportId] = useState(reports[0]?.id ?? '');
  const [kind, setKind] = useState<DeckChartKindId>('bar');
  const [period, setPeriod] = useState('30d');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = reports.find((r) => r.id === reportId) ?? null;
  const disabled = busy || !!blockedReason || !report || !slide || !headRevisionId;

  async function apply() {
    if (disabled || !report || !slide || !headRevisionId) return;
    setBusy(true); setError(null);
    try {
      const out = await applyDeckOperations(tenant, deckId, {
        baseRevisionId: headRevisionId,
        operations: [{ op: 'set_chart', slideId: slide.id, kind, report: { report: report.id, ...(reportTakesPeriod(report) ? { params: { period } } : {}) } }],
      });
      onApplied(out);
    } catch (err) {
      // The server's own sentence: a report below the caller's tier, nothing to chart, a stale version.
      setError(err instanceof Error ? err.message : 'The chart could not be filled.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailSection
      title="Fill from a report"
      hint={slide ? `Slide ${slide.index + 1}${slide.title ? `: ${slide.title}` : ''}${slide.isChart ? '' : ' becomes a chart slide'}` : 'Choose a slide first'}
      actions={<Button size="sm" variant="ghost" onClick={onClose} data-testid={`${testIdPrefix}-report-close`}>Close</Button>}
      data-testid={`${testIdPrefix}-report-panel`}
    >
      <Stack gap="sm">
        {reports.length === 0 ? <T size="sm" tone="secondary" wrap>No report can fill a chart on this deck for your role.</T> : (
          <>
            <Inline gap="md" align="end" wrap>
              <FormField label="Report">
                {({ id }) => <Select id={id} size="sm" value={reportId} onChange={(e) => setReportId(e.target.value)}
                  options={reports.map((r) => ({ value: r.id, label: r.description }))} data-testid={`${testIdPrefix}-report-select`} />}
              </FormField>
              {report && reportTakesPeriod(report) && (
                <FormField label="Period">
                  {({ id }) => <Select id={id} size="sm" value={period} onChange={(e) => setPeriod(e.target.value)} options={PERIODS} />}
                </FormField>
              )}
              <SegmentedControl size="sm" aria-label="Chart kind" value={kind} onChange={(v) => setKind(v as DeckChartKindId)}
                options={DECK_CHART_KINDS.map((k) => ({ value: k, label: DECK_CHART_KIND_LABELS[k] }))} />
              <Button size="sm" variant="primary" disabled={disabled} onClick={() => { void apply(); }} data-testid={`${testIdPrefix}-report-apply`}>
                {busy ? 'Filling…' : 'Apply'}
              </Button>
            </Inline>
            <T size="xs" tone="secondary" wrap>The numbers are read from the app's own data under your role; the slide cites the report.</T>
          </>
        )}
        {blockedReason && <InlineAlert tone="info" data-testid={`${testIdPrefix}-report-save-first`}>{blockedReason}</InlineAlert>}
        {error && <InlineAlert tone="error" data-testid={`${testIdPrefix}-report-error`}>{error}</InlineAlert>}
      </Stack>
    </DetailSection>
  );
}
