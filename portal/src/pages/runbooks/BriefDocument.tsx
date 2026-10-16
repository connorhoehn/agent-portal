// A session brief as a person reads it: the sha and token count, the sections it was assembled from
// with the reason each was included, what was left out, the org skills the box received (R8: name,
// description, version, the library sha) and the exact markdown the box received.
// Shared by Runbooks → Briefs, the run page's Brief tab and the work item's Brief preview.
import { useState } from 'react';
import { KeyValue } from '@connorhoehnslalom/ui-components';
import { Banner, Button, DataTable, DetailSection, Inline, Stack, T, type DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import { SafeMarkdown } from './SafeMarkdown';
import { briefTaskTitle } from './runbookNames';
import { SECTION_KIND_LABEL, runbookHref } from './runbooksModel';
import { useRunbookNames } from './useRunbookNames';
import { BriefSkills } from './BriefSkills';
import type { Brief, BriefSection, BriefSkillDetail } from './types';

export function BriefDocument({ brief, frozen, onOpen, skills }: { brief: Brief; frozen: boolean; onOpen: (href: string) => void; skills?: BriefSkillDetail[] }) {
  const [copied, setCopied] = useState(false);
  const names = useRunbookNames();
  const task = briefTaskTitle(brief.markdown);
  // What a section points at, by name. Long values truncate (the full text is the hover title) so a row stays one line.
  const refText = (s: BriefSection): string => {
    if (s.kind === 'runbook') return `${names.runbook(s.ref)}${s.version ? ` v${s.version}` : ''}`;
    if (s.kind === 'initiative') return names.initiative(s.ref ?? brief.initiative_id);
    if (s.kind === 'work_item') return task ?? 'The work item';
    return '';
  };
  const columns: DataTableColumn<BriefSection>[] = [
    { key: 'kind', header: 'Section', render: (s) => SECTION_KIND_LABEL[s.kind] ?? s.kind },
    {
      key: 'ref', header: 'Reference', className: 'max-w-xs truncate',
      render: (s) => <T title={s.ref ?? undefined}>{refText(s)}</T>,
    },
    { key: 'tokens', header: 'Tokens', numeric: true, render: (s) => s.tokens.toLocaleString('en-US') },
    { key: 'reason', header: 'Why it is here', className: 'max-w-sm truncate', render: (s) => <T title={s.reason}>{s.reason}</T> },
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
          ...(brief.work_item_id ? [{ label: 'Work item', value: task ?? 'The work item', title: brief.work_item_id }] : []),
          ...(brief.initiative_id ? [{ label: 'Initiative', value: names.initiative(brief.initiative_id), title: brief.initiative_id }] : []),
          ...(brief.repo ? [{ label: 'Repository', value: brief.repo }] : []),
          ...(brief.skill_library ? [{ label: 'Skill library', value: brief.skill_library.sha256, mono: true, title: `${brief.skill_library.sha256}${brief.skill_library.dir ? ` in ${brief.skill_library.dir}` : ''}` }] : []),
        ]}
      />
      {!frozen && (
        <Banner variant="info" layout="callout" icon title="A preview, not a run’s brief">
          This is what a run would be given if it started now. It is assembled fresh each time and stored nowhere; a real run freezes its own at claim.
        </Banner>
      )}
      {brief.omitted.length > 0 && (
        <Banner variant="warning" layout="callout" icon title={`${brief.omitted.length} left out`} data-testid="brief-omitted">
          {brief.omitted.map((o) => `${names.runbook(o.runbook_id)} (${o.reason === 'budget' ? 'over the token budget' : o.reason === 'scope' ? 'out of scope' : 'drifting, excluded'})`).join(' · ')}
        </Banner>
      )}
      <DetailSection variant="heading" first title="Sections" hint={`${brief.sections.length}`}>
        <DataTable data={brief.sections} columns={columns} keyField={(s) => `${s.kind}:${s.ref ?? ""}:${s.reason}`} frameless emptyMessage="No sections." onRowClick={(s) => { if (s.kind === 'runbook' && s.ref) onOpen(runbookHref(s.ref)); }} data-testid="brief-sections" />
      </DetailSection>
      {brief.skill_library && <BriefSkills library={brief.skill_library} skills={skills} frozen={frozen} onOpen={onOpen} />}
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
