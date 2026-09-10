import type { KbRegistryEntry } from '../../pages/admin/KBRegistryPage.js';
import { Inline, SectionLabel, Stack, StatusDot } from '@connorhoehnslalom/ui-components/shared';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface KBPipelineChainProps {
  kb: KbRegistryEntry;
  fileCount?: number;
  agentNames?: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function PipelineBox({
  title,
  value,
  showDot,
  dotActive,
}: {
  title: string;
  value: string;
  showDot?: boolean;
  dotActive?: boolean;
}) {
  return (
    <Stack gap="none"
      className="min-w-[120px] p-3 border border-border rounded-md bg-surface flex flex-col gap-1"
    >
      <SectionLabel className="text-[11px] font-medium tracking-[0.03em]">{title}</SectionLabel>

      <Inline gap="none"
        className="flex items-center gap-0 flex-nowrap"
      >
        <Inline
          as="span"
          gap="none"
          className={`text-[13px] font-medium text-text-primary truncate ${value === '—' ? '' : 'font-mono'}`}
          title={value}
        >
          {value}
        </Inline>
        {showDot && (
          // The library StatusDot, not the local one this file used to define
          // and which shadowed it by the same name.
          <StatusDot
            size="xs"
            className="ml-1.5 shrink-0"
            color={dotActive ? 'var(--color-success)' : 'var(--color-warning)'}
          />
        )}
      </Inline>
    </Stack>
  );
}

function Arrow() {
  return (
    <Inline
      as="span"
      gap="none"
      aria-hidden
      className="text-xl mx-2 text-text-tertiary self-center select-none shrink-0"
    >
      ──▶
    </Inline>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

const DEFAULT_AGENTS: Record<KbRegistryEntry['tenant'], string[]> = {
  orgiq: ['search', 'advisor'],
};

export function KBPipelineChain({ kb, agentNames }: KBPipelineChainProps) {
  const isActive = kb.status === 'ACTIVE';

  const agents =
    agentNames ?? DEFAULT_AGENTS[kb.tenant] ?? DEFAULT_AGENTS.orgiq;

  const dataSourceValue = kb.dataSourceId
    ? kb.dataSourceId.slice(0, 8) + '…'
    : '—';

  return (
    <Inline gap="none" align="stretch" wrap={false} className="overflow-x-auto py-1">
      {/* S3 */}
      <PipelineBox
        title="S3 Prefix"
        value={kb.s3Prefix || '—'}
      />

      <Arrow />

      {/* Data Source */}
      <PipelineBox
        title="Data Source"
        value={dataSourceValue}
        showDot
        dotActive={isActive}
      />

      <Arrow />

      {/* Bedrock KB */}
      <PipelineBox
        title="Knowledge Base"
        value={kb.bedrockKbId ?? '—'}
        showDot
        dotActive={isActive}
      />

      <Arrow />

      {/* Agents */}
      <PipelineBox
        title="Agents"
        value={agents.join(' · ')}
      />
    </Inline>
  );
}

export default KBPipelineChain;
