// The fields a person fills in to propose runbook text: the markdown, why, and what the server said back.
// The edit tab on a runbook and the Library's "New runbook" form share them, so the two read alike.
import { Banner, FormField, Input, Stack, T, Textarea } from '@connorhoehn/ui-components/shared';
import type { LintFinding } from './types';

export function LintList({ findings }: { findings: readonly LintFinding[] }) {
  if (!findings.length) return null;
  return (
    <Stack gap="xs" data-testid="suggest-lint">
      {findings.map((f, i) => (
        <Banner key={`${i}:${f.rule}:${f.path}`} variant={f.severity === 'error' ? 'error' : 'warning'} title={`${f.rule} · ${f.path}`}>{f.message}</Banner>
      ))}
    </Stack>
  );
}

export interface ProposalFieldsProps {
  markdown: string;
  onMarkdown: (value: string) => void;
  markdownLabel: string;
  markdownHint: string;
  markdownRows: number;
  rationale: string;
  onRationale: (value: string) => void;
  rationaleLabel: string;
  rationalePlaceholder: string;
  /** Why the server refused, or null. */
  error: string | null;
  /** The parse problems the server listed with a refusal. */
  problems: readonly string[];
  /** Server lint findings to show beside the form. */
  lint?: readonly LintFinding[];
}

export function ProposalFields(p: ProposalFieldsProps) {
  return (
    <>
      <FormField label={p.markdownLabel} hint={p.markdownHint}>
        {({ labelId: _l, ...w }) => (
          <Textarea {...w} value={p.markdown} onChange={(e) => p.onMarkdown(e.target.value)} rows={p.markdownRows} data-testid="suggest-markdown" />
        )}
      </FormField>
      <FormField label={p.rationaleLabel} required>
        {({ labelId: _l, ...w }) => (
          <Input {...w} value={p.rationale} onChange={(e) => p.onRationale(e.target.value)} placeholder={p.rationalePlaceholder} data-testid="suggest-rationale" />
        )}
      </FormField>
      {p.error && <Banner variant="error" layout="callout" icon title="Not sent" data-testid="suggest-error">{p.error}</Banner>}
      {p.problems.length > 0 && (
        <Stack gap="xs">{p.problems.map((x) => <T key={x} size="sm" tone="secondary" className="text-danger-fg" wrap>{x}</T>)}</Stack>
      )}
      {p.lint && <LintList findings={p.lint} />}
    </>
  );
}
