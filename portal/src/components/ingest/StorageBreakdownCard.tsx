import { Card } from '@connorhoehnslalom/ui-components/shared';
import { formatBytes } from './types';
import type { StorageBreakdown } from './types';

export function StorageBreakdownCard({ storage }: { storage: StorageBreakdown | null }) {
  if (!storage) {
    return (
      <Card padding="md">
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>S3 Storage</div>
        <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>—</div>
      </Card>
    );
  }
  const topPrefix = storage.byPrefix[0];
  return (
    <Card padding="md">
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>S3 Storage</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>
        {formatBytes(storage.totalBytes)}
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
        {storage.totalObjects.toLocaleString()} objects
      </div>
      {topPrefix && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--color-text-tertiary)',
            marginTop: 4,
            fontFamily: 'monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={topPrefix.prefix}
        >
          {topPrefix.prefix}: {formatBytes(topPrefix.bytes)}
        </div>
      )}
    </Card>
  );
}
