// A session brief as a person reads it: the sha and token count, the sections it was assembled from
// with the reason each was included, what was left out, the org skills the box received (R8: name,
// description, version, the library sha) and the exact markdown the box received.
// Shared by the run page's Brief tab and the work item's Brief preview.
import { useState } from 'react';
import { Button, Inline, Stack, T } from '@connorhoehn/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import { briefDocumentMarkdown } from './briefDocumentMarkdown';
import { ReadOnlyDocument } from '../../components/documents/ReadOnlyDocument';
import { briefTaskTitle } from './runbookNames';
import { SECTION_KIND_LABEL } from './runbooksModel';
import { useRunbookNames } from './useRunbookNames';
import type { Brief, BriefSection, BriefSkillDetail } from './types';

export function BriefDocument({ brief, frozen, onOpen, skills, presentation = 'page' }: { brief: Brief; frozen: boolean; onOpen: (href: string) => void; skills?: BriefSkillDetail[]; presentation?: 'page' | 'pane' }) {
  const [copied, setCopied] = useState(false);
  const names = useRunbookNames();
  const task = briefTaskTitle(brief.markdown);
  // Reference labels stay readable in the document’s supporting sections.
  const refText = (s: BriefSection): string => {
    if (s.kind === 'runbook') return `${names.runbook(s.ref)}${s.version ? ` v${s.version}` : ''}`;
    if (s.kind === 'initiative') return names.initiative(s.ref ?? brief.initiative_id);
    if (s.kind === 'work_item') return task ?? 'The work item';
    return '';
  };
  const markdown = briefDocumentMarkdown(brief, {
    frozen, skills, sectionLabel: section => SECTION_KIND_LABEL[section.kind] ?? section.kind,
    referenceLabel: refText, runbookLabel: names.runbook,
    workItemLabel: task ?? 'The work item', initiativeLabel: names.initiative(brief.initiative_id),
  });
  return (
    <Stack gap="sm" className={presentation === 'pane' ? 'h-full min-h-0 flex-1' : 'h-[75vh] min-h-96'} data-testid="brief-document">
      <Stack gap="xs" className="shrink-0">
        <Inline justify="between" align="start" gap="md" wrap>
          <Stack gap="xs">
            <T size="sm" weight="semibold" wrap>{frozen ? 'Saved run instructions' : 'Instructions for the next run'}</T>
            <T size="xs" tone="secondary">{`${brief.used_tokens.toLocaleString('en-US')} of ${brief.budget_tokens.toLocaleString('en-US')} tokens · ${frozen ? 'Saved' : 'Assembled'} ${relativeTime(brief.assembled_at)}`}</T>
          </Stack>
          <Button size="sm" variant="secondary" data-testid="brief-copy"
            onClick={() => { void navigator.clipboard?.writeText(brief.markdown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => undefined); }}>
            {copied ? 'Copied' : 'Copy markdown'}
          </Button>
        </Inline>
        {!frozen && <T size="xs" tone="secondary">Preview · A run saves its own copy when it starts.</T>}
      </Stack>
      <ReadOnlyDocument markdown={markdown} presentation={presentation} testId="brief-markdown" onOpen={onOpen} />
    </Stack>
  );
}
