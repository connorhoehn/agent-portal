// A runbook document read as a person would: the summary, when to use it, what to check first, the numbered
// steps with their commands and what to expect, how to verify, what goes wrong and how to roll back.
// Every field is plain text in a React text node (never HTML); the one free-markdown field, `notes`, goes
// through SafeMarkdown. The exact bytes a box receives sit in a disclosure at the end, with their sha.
import type { ReactNode } from 'react';
import { KeyValue, ProcedureSteps } from '@connorhoehn/ui-components';
import { Chip, CodeBlock, DetailSection, Disclosure, Stack, T } from '@connorhoehn/ui-components/shared';
import { SafeMarkdown } from './SafeMarkdown';
import { shortSha } from './runbooksModel';
import type { RunbookCommand, RunbookDoc } from './types';

/** `code` spans in a one-line field become mono chips; everything else is a plain text node. */
function inline(text: string): ReactNode {
  const parts = text.split(/`([^`]+)`/);
  return parts.length === 1 ? text : parts.map((part, i) => (i % 2 === 1 ? <Chip key={i} mono size="sm" tone="neutral">{part}</Chip> : part));
}

const LANG: Record<RunbookCommand['lang'], 'bash' | 'text'> = { bash: 'bash', sql: 'text', http: 'text', text: 'text' };

function Command({ command }: { command: RunbookCommand }) {
  return <CodeBlock code={command.text} language={LANG[command.lang]} copyButton theme="console" className="mt-1" />;
}

function Body({ children }: { children: ReactNode[] }) {
  const parts = children.filter(Boolean);
  return parts.length ? <Stack gap="xs">{parts}</Stack> : null;
}

export function RunbookDocView({ doc, markdown, sha256 }: { doc: RunbookDoc; markdown?: string; sha256?: string }) {
  const list = (items: readonly string[], label: string) => (
    <ProcedureSteps aria-label={label} numbered={false} size="md" steps={items.map((t, i) => ({ id: `${label}-${i}`, title: inline(t) }))} />
  );
  const triggers = [
    ['Labels', doc.triggers.work_item_labels], ['Repositories', doc.triggers.repos], ['Tools', doc.triggers.tools], ['Keywords', doc.triggers.keywords],
  ] as const;
  return (
    <Stack gap="md" data-testid="runbook-doc">
      <T size="sm" tone="secondary" wrap data-testid="runbook-summary">{doc.summary}</T>

      {doc.use_when.length > 0 && <DetailSection variant="heading" first title="Use this when">{list(doc.use_when, 'Use this when')}</DetailSection>}
      {doc.not_for.length > 0 && <DetailSection variant="heading" title="Not for">{list(doc.not_for, 'Not for')}</DetailSection>}
      {doc.preconditions.length > 0 && <DetailSection variant="heading" title="Before you start">{list(doc.preconditions, 'Before you start')}</DetailSection>}

      <DetailSection variant="heading" title="Steps" hint={`${doc.steps.length}`}>
        <ProcedureSteps
          aria-label="Steps"
          size="md"
          steps={doc.steps.map((s, i) => ({
            id: `step-${i + 1}`,
            title: inline(s.do),
            body: <Body>{[
              s.command ? <Command key="c" command={s.command} /> : null,
              s.expect ? <T key="e" size="sm" tone="secondary" wrap>Expect: {inline(s.expect)}</T> : null,
              s.why ? <T key="w" size="sm" tone="tertiary" wrap>Why: {inline(s.why)}</T> : null,
            ]}</Body>,
          }))}
        />
      </DetailSection>

      {doc.verify.length > 0 && (
        <DetailSection variant="heading" title="Verify">
          <ProcedureSteps
            aria-label="Verify" numbered={false} size="md"
            steps={doc.verify.map((v, i) => ({ id: `verify-${i}`, title: inline(v.check), ...(v.command ? { body: <Command command={v.command} /> } : {}) }))}
          />
        </DetailSection>
      )}

      {doc.failure_modes.length > 0 && (
        <DetailSection variant="heading" title="If it goes wrong">
          <ProcedureSteps
            aria-label="If it goes wrong" numbered={false} size="md"
            steps={doc.failure_modes.map((f, i) => ({
              id: `fail-${i}`, title: inline(f.symptom),
              body: <Body>{[
                <T key="c" size="sm" tone="secondary" wrap>Likely cause: {inline(f.cause)}</T>,
                <T key="r" size="sm" tone="secondary" wrap>Do this: {inline(f.response)}</T>,
              ]}</Body>,
            }))}
          />
        </DetailSection>
      )}

      {doc.rollback.length > 0 && (
        <DetailSection variant="heading" title="Roll back">
          <ProcedureSteps
            aria-label="Roll back" size="md"
            steps={doc.rollback.map((r, i) => ({ id: `rb-${i}`, title: inline(r.do), ...(r.command ? { body: <Command command={r.command} /> } : {}) }))}
          />
        </DetailSection>
      )}

      {doc.notes ? <DetailSection variant="heading" title="Notes"><SafeMarkdown markdown={doc.notes} scale="sm" testId="runbook-notes" /></DetailSection> : null}

      <Disclosure summary="How a run is matched to this runbook" variant="plain" density="compact" data-testid="runbook-triggers">
        <KeyValue layout="row" labelWidth="w-32" items={triggers.map(([label, values]) => ({ label, value: values.length ? values.join(', ') : '—' }))} />
      </Disclosure>

      {markdown && (
        <Disclosure summary="The exact text a box receives" hint={sha256 ? `sha256 ${shortSha(sha256)}` : undefined} variant="plain" density="compact" data-testid="runbook-exact-text">
          <CodeBlock code={markdown} language="text" copyButton theme="console" ariaLabel="Runbook markdown" />
        </Disclosure>
      )}
    </Stack>
  );
}
