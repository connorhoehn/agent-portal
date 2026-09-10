import type { KbRegistryEntry } from '../../pages/admin/KBRegistryPage.js';
import { Inline, Stack } from '@connorhoehnslalom/ui-components/shared';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface KBPipelineChainProps {
  kb: KbRegistryEntry;
  fileCount?: number;
  agentNames?: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: active ? 'var(--color-success)' : 'var(--color-warning)',
        marginLeft: 5,
        flexShrink: 0,
      }}
    />
  );
}

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
      <div
        style={{
          fontSize: 11,
          color: 'var(--color-text-tertiary)',
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
        }}
      >
        {title}
      </div>

      <Inline gap="none"
        className="flex items-center gap-0 flex-nowrap"
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: value === '—' ? 'inherit' : 'monospace',
          }}
          title={value}
        >
          {value}
        </span>
        {showDot && <StatusDot active={dotActive ?? false} />}
      </Inline>
    </Stack>
  );
}

function Arrow() {
  return (
    <span
      style={{
        fontSize: 20,
        margin: '0 8px',
        color: 'var(--color-text-tertiary)',
        alignSelf: 'center',
        userSelect: 'none',
        flexShrink: 0,
      }}
    >
      ──▶
    </span>
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
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
        overflowX: 'auto',
        padding: '4px 0',
      }}
    >
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
    </div>
  );
}

export default KBPipelineChain;
