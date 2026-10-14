import { useEffect, useRef } from 'react';
import { Button, Chip, DetailHeader, Inline, InlineAlert, InlinePlaceholder, MetaLine, SectionLabel, SkeletonCard, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../../lib/relativeTime';
import { TemplateHighlighted } from './TemplateHighlighted';
import { VersionSelect } from './VersionSelect';
import { arnTail, extractVariables } from './promptFormat';
import { usePromptVersionDetail } from '../../../components/canary/usePromptLibrary.js';
import type { Selection } from './types';

/** Read-only view of one prompt version: the template, its variables, and the
 *  inference settings baked into the variant. */
export function ViewPanel({
  selection,
  onVersionChange,
  onEdit,
  onTest,
  canManage,
  returnFocusTo = null,
  onFocusReturned,
}: {
  selection: Selection;
  onVersionChange: (v: string) => void;
  onEdit: () => void;
  onTest: () => void;
  /** ManageCanary — Test/Edit affordances hide without it. */
  canManage: boolean;
  /** The trigger that opened the panel this view replaced: it gets focus back
   *  as soon as it is rendered, so leaving Edit or Test does not drop focus. */
  returnFocusTo?: 'edit' | 'test' | null;
  onFocusReturned?: () => void;
}) {
  const { detail, loading, error } = usePromptVersionDetail(selection.promptId, selection.version);
  const editRef = useRef<HTMLButtonElement>(null);
  const testRef = useRef<HTMLButtonElement>(null);

  // Waits for `detail`, not just `!loading`: the fetch hook's first render
  // reports loading=false with no detail yet, then flips to the skeleton —
  // focusing the button on that first frame is how focus was lost before.
  useEffect(() => {
    if (!returnFocusTo || loading || !detail) return;
    (returnFocusTo === 'edit' ? editRef : testRef).current?.focus();
    onFocusReturned?.();
  }, [returnFocusTo, loading, detail, onFocusReturned]);

  const templateText = detail?.variant?.templateText ?? '';
  const modelId = detail?.variant?.modelId ?? '';
  const inf = detail?.variant?.inferenceConfig;
  const variables = extractVariables(templateText);

  if (loading) {
    return (
      <Stack gap="md" className="p-6">
        <SkeletonCard height={28} width={280} />
        <SkeletonCard height={360} />
      </Stack>
    );
  }

  if (error) {
    return (
      <Stack gap="md" className="p-6">
        <InlineAlert tone="error">Failed to load: {error}</InlineAlert>
      </Stack>
    );
  }

  return (
    <Stack gap="none" className="h-full min-h-0">
      <Stack gap="none" className="flex-none border-b border-border px-6 pb-4 pt-5">
        <DetailHeader
          as="h2"
          title={<T className="font-mono">{selection.promptName}</T>}
          meta={
            <MetaLine
              items={[
                detail?.arn && (
                  // Capped to fit inside the header's own left column, not a
                  // guess at the ARN's natural width — see the arithmetic in
                  // ViewPanel's header comment below.
                  // …showing the ARN's identifying TAIL, not its head: every
                  // prompt's ARN opens with the same `arn:aws:bedrock:
                  // <region>:<account>:prompt/`, so a head-truncated 200px box
                  // read identically for all six (see arnTail).
                  <T key="arn" className="block max-w-[200px] truncate font-mono" title={detail.arn}>
                    {arnTail(detail.arn)}
                  </T>
                ),
                detail?.updatedAt && `Updated ${relativeTime(detail.updatedAt)}`,
              ]}
            />
          }
          aside={
            <Inline gap="sm" justify="end">
              <VersionSelect promptId={selection.promptId} value={selection.version} onChange={onVersionChange} />
              {canManage && (
                <>
                  {/* One word each: the audit measured "Test ▶" at 61px and
                      "Edit / new version" at 97px, which with the 246px
                      select and two 8px gaps filled the 420px aside exactly
                      — so BOTH wrapped to two lines. The fuller sense moves
                      into the title attribute. */}
                  <Button ref={testRef} variant="ghost" size="sm" data-prompt-test-trigger onClick={onTest} title="Test this prompt against a live model">Test</Button>
                  <Button ref={editRef} variant="primary" size="sm" data-prompt-edit-trigger onClick={onEdit} title="Edit the template and publish a new version">Edit</Button>
                </>
              )}
            </Inline>
          }
          // 420, not the old 380: at 1552px this header's content row is
          // ~772px wide (viewport minus the fixed shell rail + tenant rail +
          // the 240px prompt rail + this panel's px-6 padding — none of
          // which scale with the viewport, so the header row shrinks 1:1
          // with it). Select(246 measured) + gap(8) + "Test"(~52) +
          // gap(8) + "Edit"(~52) ≈ 366px. The old labels measured 61 and 97,
          // filling 420 exactly and wrapping both onto two lines; the short
          // ones leave ~54px of slack. That
          // takes the left (title/meta) column down to 772-420-12(gap)=340px
          // at 1552px and 660-420-12=228px at 1440px (660 = the same
          // arithmetic 112px narrower) — the ARN's 200px cap (below) fits
          // inside the smaller of the two with room to spare, instead of a
          // 480px box that was 100-250px wider than the column actually had.
          asideWidth={canManage ? 420 : 120}
        />
      </Stack>

      <Stack gap="none" className="flex-1 overflow-auto border-b border-border">
        {templateText
          ? <TemplateHighlighted text={templateText} />
          : <InlinePlaceholder size="sm" className="px-6 py-5">No template text for this version.</InlinePlaceholder>}
      </Stack>

      {(variables.length > 0 || modelId || inf) && (
        <Inline gap="md" className="flex-none bg-surface-panel px-6 py-2.5">
          {variables.length > 0 && (
            <Inline gap="xs">
              <SectionLabel>Variables</SectionLabel>
              {variables.map(v => <Chip key={v} tone="info" size="xs" mono>{v}</Chip>)}
            </Inline>
          )}
          {(modelId || inf) && (
            <Inline gap="xs">
              {modelId && <Chip tone="neutral" size="xs" mono>{modelId}</Chip>}
              {inf?.temperature !== undefined && <Chip tone="neutral" size="xs" mono>temp {inf.temperature}</Chip>}
              {inf?.maxTokens !== undefined && <Chip tone="neutral" size="xs" mono>{inf.maxTokens} tok</Chip>}
            </Inline>
          )}
        </Inline>
      )}
    </Stack>
  );
}
