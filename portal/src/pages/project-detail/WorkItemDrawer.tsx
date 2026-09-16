// One work item, opened from the table by `?item=<id>`.
//
// The table's titles are links, and a link has to go somewhere. The
// destination is a query param rather than a nested path on purpose: the item
// is a detail OF this backlog, not a page away from it. As a param it is
// deep-linkable, survives a refresh, closes with the back button, and can be
// pasted to a colleague — while the initiative, its filters and its scroll
// position all stay put underneath.

import { useSearchParams } from 'react-router';
import {
  Button,
  Chip,
  DetailSection,
  Divider,
  Drawer,
  Inline,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { PersonRef } from './PersonRef';
import { T } from './Text';
import { KeyValue } from '../../components/KeyValue';
import { PrBadge, StatusChip } from './WorkItemChips';
import type { FlatWorkItem } from './projectFormat';
import type { WorkItemTree } from './types';

/** Read the open item out of the URL. Exported so the panel can stay dumb. */
export function useOpenWorkItem(items: FlatWorkItem[]): {
  item: FlatWorkItem | null;
  /** href that opens `id` while KEEPING every other param already in the URL. */
  itemHref: (id: string) => string;
  close: () => void;
} {
  const [params, setParams] = useSearchParams();
  const id = params.get('item');
  const item = id ? items.find((i) => i.id === id) ?? null : null;
  return {
    item,
    // A bare `?item=x` link would replace the whole query string, silently
    // dropping anything else living there. Opening a row is an addition to
    // the current view, never a reset of it.
    itemHref: (target: string) => {
      const next = new URLSearchParams(params);
      next.set('item', target);
      return `?${next.toString()}`;
    },
    close: () => {
      const next = new URLSearchParams(params);
      next.delete('item');
      // `replace` so closing a drawer does not leave a history entry the back
      // button has to walk through twice to leave the page.
      setParams(next, { replace: true });
    },
  };
}

export function WorkItemDrawer({
  item,
  onClose,
  onEstimate,
  canDispatch,
}: {
  item: FlatWorkItem | null;
  onClose: () => void;
  onEstimate: (item: WorkItemTree) => void;
  canDispatch: boolean;
}) {
  return (
    <Drawer
      open={item != null}
      onClose={onClose}
      title={item?.title}
      subtitle={item?.id}
      width={480}
      footer={item && canDispatch && item.status === 'open' && item.storyPoints != null ? (
        <Button
          variant="primary"
          // Same handle as EstimateChip — this button unmounts (this whole
          // drawer closes) in the very click that opens the Estimate drawer,
          // so it can't be refocused itself; EstimateDrawer re-queries by id
          // and lands on whichever trigger for this item is still around.
          data-estimate-trigger={item.id}
          onClick={() => { onEstimate(item); onClose(); }}
        >
          ⚡ Estimate &amp; dispatch
        </Button>
      ) : undefined}
    >
      {item && (
        <Stack gap="xs">
          <Inline gap="xs" align="center" className="pb-2">
            <Chip tone={item.type === 'bug' ? 'danger' : 'info'} size="xs" uppercase>{item.type}</Chip>
            <StatusChip status={item.status} />
            {item.prStatus && <PrBadge prStatus={item.prStatus} prUrl={item.prUrl} />}
          </Inline>

          <KeyValue layout="row" labelWidth="w-[104px]" label="ID"><T className="font-mono text-[11.5px]">{item.id}</T></KeyValue>
          <KeyValue layout="row" labelWidth="w-[104px]" label="Epic">
            <Stack gap="none">
              <span>{item.epicTitle}</span>
              <T className="font-mono text-[11px] text-text-tertiary">{item.epicId}</T>
            </Stack>
          </KeyValue>
          <KeyValue layout="row" labelWidth="w-[104px]" label="Initiative">
            <Stack gap="none">
              <span>{item.projectName}</span>
              <T className="font-mono text-[11px] text-text-tertiary">{item.projectId}</T>
            </Stack>
          </KeyValue>
          <KeyValue layout="row" labelWidth="w-[104px]" label="Assignee">
            <PersonRef
              personId={item.assigneeId}
              name={item.assigneeName}
              department={item.assigneeDept}
            />
          </KeyValue>
          <KeyValue layout="row" labelWidth="w-[104px]" label="Priority">{item.priority}</KeyValue>
          <KeyValue layout="row" labelWidth="w-[104px]" label="Complexity">
            {item.storyPoints != null ? `${item.storyPoints} pts` : 'unestimated'}
          </KeyValue>
          {item.labels.length > 0 && (
            <KeyValue layout="row" labelWidth="w-[104px]" label="Labels">
              <Inline gap="xs">
                {item.labels.map((l) => <Chip key={l} size="xs">{l}</Chip>)}
              </Inline>
            </KeyValue>
          )}

          {item.description && (
            <>
              <Divider spacing="sm" />
              <DetailSection title="Description" first>
                <T as="p" className="m-0 whitespace-pre-wrap text-[12.5px] leading-relaxed text-text-secondary">
                  {item.description}
                </T>
              </DetailSection>
            </>
          )}
        </Stack>
      )}
    </Drawer>
  );
}
