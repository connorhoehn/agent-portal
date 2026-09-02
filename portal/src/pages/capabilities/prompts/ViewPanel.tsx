import { Button, Chip, DetailHeader, Inline, InlineAlert, InlinePlaceholder, MetaLine, SectionLabel, SkeletonCard, Stack } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../../lib/relativeTime';
import { TemplateHighlighted } from './TemplateHighlighted';
import { VersionSelect } from './VersionSelect';
import { extractVariables } from './promptFormat';
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
}: {
  selection: Selection;
  onVersionChange: (v: string) => void;
  onEdit: () => void;
  onTest: () => void;
  /** ManageCanary — Test/Edit affordances hide without it. */
  canManage: boolean;
}) {
  const { detail, loading, error } = usePromptVersionDetail(selection.promptId, selection.version);

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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-none border-b border-border px-6 pb-4 pt-5">
        <DetailHeader
          as="h2"
          title={<span className="font-mono">{selection.promptName}</span>}
          meta={
            <MetaLine
              items={[
                detail?.arn && (
                  <code key="arn" className="block max-w-[480px] truncate font-mono" title={detail.arn}>
                    {detail.arn}
                  </code>
                ),
                detail?.updatedAt && `Updated ${relativeTime(detail.updatedAt)}`,
              ]}
            />
          }
          aside={
            <Inline gap="sm" justify="end" wrap={false}>
              <VersionSelect promptId={selection.promptId} value={selection.version} onChange={onVersionChange} />
              {canManage && (
                <>
                  <Button variant="ghost" onClick={onTest}>Test ▶</Button>
                  <Button variant="primary" onClick={onEdit}>Edit / new version</Button>
                </>
              )}
            </Inline>
          }
          asideWidth={canManage ? 380 : 120}
        />
      </div>

      <div className="flex-1 overflow-auto border-b border-border">
        {templateText
          ? <TemplateHighlighted text={templateText} />
          : <InlinePlaceholder size="sm" className="px-6 py-5">No template text for this version.</InlinePlaceholder>}
      </div>

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
    </div>
  );
}
