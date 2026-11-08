// ModeChip — small chip showing whether an artifact (typically a harness run)
// was produced against a LIVE agent runtime or in SIM (deterministic synthetic)
// mode. Falls back to the raw label for unknown values.

import { Chip } from '@connorhoehn/ui-components/shared';

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

interface Props {
  mode: 'live' | 'sim' | string | null | undefined;
  size?: 'xs' | 'sm';
}

export function ModeChip({ mode, size = 'xs' }: Props) {
  if (mode == null || mode === '') {
    return (
      <Chip tone="neutral" size={size}>
        —
      </Chip>
    );
  }
  const m = String(mode).toLowerCase();
  let tone: Tone = 'neutral';
  let label = String(mode);
  if (m === 'live') {
    tone = 'success';
    label = 'LIVE';
  } else if (m === 'sim') {
    tone = 'warning';
    label = 'SIM';
  }
  return (
    <Chip tone={tone} size={size}>
      {label}
    </Chip>
  );
}

export default ModeChip;
