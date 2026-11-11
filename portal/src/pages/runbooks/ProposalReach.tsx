// The review page's "Would be given to" table: the open work items the proposed text would reach.
// Rows open the work item where work items open today (the initiative's Work tab).
import { DataTable, T, type DataTableColumn } from '@connorhoehn/ui-components/shared';
import { RecordLink } from '../decisions/RecordLink';
import { workItemHref } from '../project-detail/overviewModel';
import { outcomeLabel, reachEmpty, reachItemName, reachNote, type ProposalReach, type ReachItem } from './reachModel';

export function ProposalReach({ reach }: { reach: ProposalReach }) {
  const columns: DataTableColumn<ReachItem>[] = [
    { key: 'item', header: 'Work item', render: (i) => (
      <RecordLink to={workItemHref(i.initiative.id, i.id)} data-testid="reach-work-item">
        <T size="sm" title={reachItemName(i)} className="block max-w-[30rem] truncate">{reachItemName(i)}</T>
      </RecordLink>
    ) },
    { key: 'initiative', header: 'Initiative', width: '200px', priority: 3, render: (i) => <T size="sm" className="block truncate">{i.initiative.name}</T> },
    { key: 'outcome', header: 'Result', width: '248px', priority: 2, render: (i) => <T size="sm" tone={i.outcome === 'chosen' ? 'primary' : 'secondary'}>{outcomeLabel(i.outcome)}</T> },
  ];
  const note = reachNote(reach);
  return (
    <>
      <DataTable
        narrow
        data={reach.items}
        columns={columns}
        keyField={(i) => i.id}
        pageSize={20}
        data-testid="proposal-reach-table"
        emptyMessage={reachEmpty(reach)}
      />
      {note && <T size="xs" tone="tertiary" wrap data-testid="proposal-reach-note">{note}</T>}
    </>
  );
}
