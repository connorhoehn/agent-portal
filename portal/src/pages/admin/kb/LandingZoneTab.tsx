// Where documents go in.
//
// NOTE: components/kb/LandingZoneBrowser.tsx is a full S3 file browser for this
// prefix and has ZERO consumers — this tab prints the path and stops. Wiring it
// up is a feature decision, not a cleanup one, so it is left alone here.

import { Card, CardHeader, Chip, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { KbRegistryEntry } from './types';

export function LandingZoneTab({ kb }: { kb: KbRegistryEntry }) {
  return (
    <Card padding="md">
      <Stack gap="md">
        <CardHeader title="Landing zone" subtitle="Upload documents to this S3 prefix, then run Sync Now to ingest them." />
        <Chip mono size="sm">{kb.s3Prefix}</Chip>
      </Stack>
    </Card>
  );
}
