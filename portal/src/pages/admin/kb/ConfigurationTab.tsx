// Every AWS handle and embedding setting for this KB, in one place.
//
// This is the ONLY place these values appear now. The detail header used to
// carry a row of six bordered "info pills" repeating Bedrock KB ID, Aurora
// table, embedding model and chunking — the same fields, 300px above the tab
// that lists them. One of the two had to go, and a labelled table beats six
// pills competing with the page title.
//
// The old version also mapped rows into a bare fragment and put `key` on the
// fragment's children rather than the fragment, which React ignores — every
// render warned. A table row has one key by construction.

import {
  T,
  Card,
  CardHeader,
  Stack,
  Table,
  TableBody,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { configRows } from './kbFormat';
import type { KbRegistryEntry } from './types';

export function ConfigurationTab({ kb }: { kb: KbRegistryEntry }) {
  return (
    <Card padding="md">
      <Stack gap="md">
        <CardHeader title="Configuration" />
        <Table>
          <TableBody>
            {configRows(kb).map(({ label, value }) => (
              <TableRow key={label}>
                <TableTh scope="row" className="w-px whitespace-nowrap">{label}</TableTh>
                <TableTd className="break-all"><T as="span" size="xs" className="font-mono">{value}</T></TableTd>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Stack>
    </Card>
  );
}
