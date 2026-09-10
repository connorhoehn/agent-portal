import {
  Card,
  Inline,
} from '@connorhoehnslalom/ui-components/shared';
import { formatBytes } from './types';
import type { StorageBreakdown } from './types';

export function StorageBreakdownCard({ storage }: { storage: StorageBreakdown | null }) {
  if (!storage) {
    return (
      <Card padding="md">
        <Inline gap="none" className="text-[12px] text-text-tertiary">S3 Storage</Inline>
        <Inline gap="none" className="text-2xl font-bold mt-4">—</Inline>
      </Card>
    );
  }
  const topPrefix = storage.byPrefix[0];
  return (
    <Card padding="md">
      <Inline gap="none" className="text-[12px] text-text-tertiary">S3 Storage</Inline>
      <Inline gap="none" className="text-2xl font-bold mt-4">
        {formatBytes(storage.totalBytes)}
      </Inline>
      <Inline gap="none" className="text-[11px] text-text-tertiary mt-4">
        {storage.totalObjects.toLocaleString()} objects
      </Inline>
      {topPrefix && (
        <Inline gap="none"
          className="text-[10px] text-text-tertiary mt-4 font-mono overflow-hidden truncate whitespace-nowrap"
          title={topPrefix.prefix}
        >
          {topPrefix.prefix}: {formatBytes(topPrefix.bytes)}
        </Inline>
      )}
    </Card>
  );
}
