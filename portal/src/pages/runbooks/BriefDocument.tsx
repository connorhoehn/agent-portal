// A session brief as a person reads it: the sha and token count, the sections it was assembled from
// with the reason each was included, what was left out, and the exact markdown the box received.
// Shared by Runbooks → Briefs, the run page's Brief tab and the work item's Brief preview.
import { useState } from 'react';
import { KeyValue } from '@connorhoehnslalom/ui-components';
import { Banner, Button, DataTable, DetailSection, Inline, Stack, T, type DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import { SafeMarkdown } from './SafeMarkdown';
import { SECTION_KIND_LABEL, runbookHref } from './runbooksModel';
import type { Brief, BriefSection } from './types';

export function BriefDocument({ brief, frozen, onOpen }: { brief: Brief; frozen: boolean; onOpen: (href: string) => void }) {
  const [copied, setCopied] = useState(false);
  const columns: DataTableColumn<BriefSection>[] = [
    { key: 'kind', header: 'Section', render: (s) => SECTION_KIND_LABEL[s.kind] ?? s.kind },
    {
      key: 'ref', header: 'Reference',
      render: (s) => `${s.ref ?? ''}${s.version ? ` v${s.version}` : ''}`,
    },
    { key: 'tokens', header: 'Tokens', numeric: true, render: (s) => s.tokens.toLocaleString('en-US') },
    { key: 'reason', header: 'Why it is here', render: (s) => s.reason },
  ];
  return (
    <Stack gap="md" data-testid="brief-document">
      <KeyValue
        layout="row"
        labelWidth="w-32"
        items={[
          { label: 'sha256', value: brief.sha256, mono: true, title: brief.sha256 },
          { label: 'Tokens', value: `${brief.used_tokens.toLocaleString('en-US')} of ${brief.budget_tokens.toLocaleString('en-US')}` },
          { label: frozen ? 'Frozen' : 'Assembled', value: relativeTime(brief.assembled_at), title: brief.assembled_at },
          ...(brief.work_item_id ? [{ label: 'Work item', value: brief.work_item_id, mono: true }] : []),
          ...(brief.repo ? [{ label: 'Repository', value: brief.repo }] : []),
        ]}
      />
      {!frozen && (
        <Banner variant="info" layout="callout" icon title="A preview, not a run’s brief">
          This is what a run would be given if it started now. It is assembled fresh each time and stored nowhere; a real run freezes its own at claim.
        </Banner>
      )}
      {brief.omitted.length > 0 && (
        <Banner variant="warning" layout="callout" icon title={`${brief.omitted.length} left out`} data-testid="brief-omitted">
          {brief.omitted.map((o) => `${o.runbook_id} (${o.reason === 'budget' ? 'over the token budget' : o.reason === 'scope' ? 'out of scope' : 'drifting, excluded'})`).join(' · ')}
        </Banner>
      )}
      <DetailSection variant="heading" first title="Sections" hint={`${brief.sections.length}`}>
        <DataTable data={brief.sections} columns={columns} keyField={(s) => `${s.kind}:${s.ref ?? ""}:${s.reason}`} frameless emptyMessage="No sections." onRowClick={(s) => { if (s.kind === 'runbook' && s.ref) onOpen(runbookHref(s.ref)); }} data-testid="brief-sections" />
      </DetailSection>
      <DetailSection
        variant="heading"
        title={frozen ? 'The exact text the box received' : 'The text a box would receive'}
        actions={(
          <Inline gap="sm" align="center">
            <Button size="sm" variant="secondary" data-testid="brief-copy"
              onClick={() => { void navigator.clipboard?.writeText(brief.markdown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => undefined); }}>
              {copied ? 'Copied' : 'Copy markdown'}
            </Button>
          </Inline>
        )}
      >
        <Stack gap="sm">
          <T size="xs" tone="tertiary">{frozen ? 'Byte for byte; the sha256 above is the hash of exactly this text.' : 'Assembled by the same code the dispatcher uses.'}</T>
          <SafeMarkdown markdown={brief.markdown} scale="md" testId="brief-markdown" />
        </Stack>
      </DetailSection>
    </Stack>
  );
}
