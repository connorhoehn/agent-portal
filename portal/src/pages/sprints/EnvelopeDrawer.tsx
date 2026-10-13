// "What is left of my sprint envelope", per envelope.
//
// Opens from the Envelope tile on the sprints lens. A drawer rather than a
// block on the page for the reason the lens itself exists: the list is the
// page, and a second stack of money cards above it would push the first sprint
// row below the fold. One reader in ten needs the breakdown; all ten need the
// headline, which the tile already carries.
//
// The one rule here is that an unattributed burn is rendered in WORDS. The wire
// sends `spentUsd`/`remainingUsd` as null on a cluster with no
// `bot_runs.dispatched_by`, and "$0.00 spent" is the one thing that data cannot
// say — see lib/envelopeFormat.ts.

import {
  Chip,
  DataTable,
  Drawer,
  EmptyState,
  InlineAlert,
  Stack, T,
} from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import {
  envelopeScopeLabel, envelopeWindowLabel, hasKnownBurn, remainingLabel, spentLabel, usd,
} from '../../lib/envelopeFormat';
import type { EnvelopeRow, EnvelopesResponse } from '../../lib/envelopeFormat';

/** Right-aligned money is only comparable down a column with tabular numerals. */
const NUM = 'tabular-nums whitespace-nowrap';

const COLUMNS: DataTableColumn<EnvelopeRow>[] = [
  {
    key: 'scope', header: 'Envelope', sortable: true,
    compare: (a, b) => envelopeScopeLabel(a).localeCompare(envelopeScopeLabel(b)),
    render: (e) => <T title={envelopeScopeLabel(e)}>{envelopeScopeLabel(e)}</T>,
  },
  {
    key: 'window', header: 'Window',
    render: (e) => <T className="whitespace-nowrap text-text-secondary">{envelopeWindowLabel(e)}</T>,
  },
  {
    key: 'allocatedUsd', header: 'Granted', numeric: true, sortable: true,
    render: (e) => <T className={NUM}>{usd(e.allocatedUsd)}</T>,
  },
  {
    key: 'spentUsd', header: 'Spent by you', numeric: true, sortable: true,
    render: (e) => (
      <T className={hasKnownBurn(e) ? NUM : `${NUM} text-text-tertiary`}>{spentLabel(e)}</T>
    ),
  },
  {
    key: 'remainingUsd', header: 'Left', numeric: true, sortable: true,
    render: (e) => {
      if (!hasKnownBurn(e)) return <T className={`${NUM} text-text-tertiary`}>{remainingLabel(e)}</T>;
      return (
        <T weight="semibold" className={e.remainingUsd! <= 0 ? `${NUM} text-danger` : `${NUM} `}>
          {remainingLabel(e)}
        </T>
      );
    },
  },
  {
    key: 'sprintStatus', header: 'Sprint', sortable: true,
    render: (e) => (
      e.sprintStatus
        ? <Chip tone={e.sprintStatus === 'active' ? 'success' : 'neutral'} size="sm">{e.sprintStatus}</Chip>
        : <T className="text-text-tertiary">standing</T>
    ),
  },
];

export function EnvelopeDrawer({ open, onClose, data }: {
  open: boolean; onClose: () => void; data: EnvelopesResponse | null;
}) {
  const rows = data?.envelopes ?? [];
  const anyUnattributed = rows.some((e) => !hasKnownBurn(e));
  // `resolved: false` means nothing could be looked up. Rendering the table's
  // "No active sprint envelope" under that would answer a question we did not
  // get to ask — so the reason stands alone.
  const unresolved = data != null && !data.resolved;
  const reason = data?.reason ?? 'Your sprint envelopes could not be resolved.';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Your sprint envelopes"
      subtitle="What a release manager reserved for you, and what a dispatch is judged against."
      width={860}
    >
      <Stack gap="md">
        {unresolved ? (
          // Not "you hold none" — nothing could be resolved at all. The server
          // writes its reason as a lowercase clause meant to follow a colon.
          <InlineAlert tone="warning">
            {`${reason[0]!.toUpperCase()}${reason.slice(1)}.`}
          </InlineAlert>
        ) : anyUnattributed ? (
          <InlineAlert tone="info">
            This cluster does not record who dispatched a run, so the burn against at least one
            envelope below is unknown — not zero. Only the envelope's size can be compared against
            a forecast.
          </InlineAlert>
        ) : rows.length > 0 ? (
          // Written here rather than spliced from the wire: the server's `note`
          // is a lowercase sentence fragment ("counts only runs recorded as
          // dispatched by you") meant to be appended to a refusal, and pasting
          // it in front of a second sentence produced a run-on with no full stop.
          <InlineAlert tone="info">
            Spend counts only runs recorded as dispatched by you. Runs from before attribution
            was turned on, and everyone else's, count against nobody.
          </InlineAlert>
        ) : null}

        {unresolved ? null : rows.length === 0 ? (
          <EmptyState
            title="No active sprint envelope"
            body="No release manager has granted you a sprint envelope that is currently in force. An SME cannot dispatch an agent run without one."
          />
        ) : (
          <DataTable<EnvelopeRow>
            data={rows}
            columns={COLUMNS}
            keyField={(e) => e.grantId}
            pageSize={25}
            emptyMessage="No active sprint envelope"
          />
        )}
      </Stack>
    </Drawer>
  );
}
