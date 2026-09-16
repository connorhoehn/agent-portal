import {
  StatCard,
} from '@connorhoehnslalom/ui-components/shared';
import { formatBytes } from './types';
import type { StorageBreakdown } from './types';

export function StorageBreakdownCard({ storage }: { storage: StorageBreakdown | null }) {
  if (!storage) {
    return <StatCard label="S3 Storage" value="—" />;
  }
  const topPrefix = storage.byPrefix[0];
  return (
    <StatCard
      label="S3 Storage"
      value={formatBytes(storage.totalBytes)}
      hint={(
        <>
          {storage.totalObjects.toLocaleString()} objects
          {topPrefix && (
            <>
              {' · '}
              <span title={topPrefix.prefix}>{topPrefix.prefix}: {formatBytes(topPrefix.bytes)}</span>
            </>
          )}
        </>
      )}
    />
  );
}
