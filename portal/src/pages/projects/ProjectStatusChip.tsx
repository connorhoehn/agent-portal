import { Chip } from '@connorhoehnslalom/ui-components/shared';
import { statusTone, normalizeStatus } from './projectFormat';

/**
 * The initiative status pill. Was a hand-built `<span>` with a six-entry table
 * of raw hex triples plus a nested dot `<span>`; `Chip` already does dotted,
 * uppercase, toned pills, so the table became a tone lookup.
 */
export function ProjectStatusChip({ status }: { status: string | null }) {
  return (
    <Chip tone={statusTone(status)} size="xs" dot="static" uppercase>
      {normalizeStatus(status).replace(/_/g, ' ')}
    </Chip>
  );
}
