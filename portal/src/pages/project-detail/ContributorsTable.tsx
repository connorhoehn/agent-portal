// Org-graph attribution for this initiative.
//
// Previously a hand-built <table> with inline cell padding, JS mouseenter/leave
// row hovering, and a <style> tag injected into the body to give the name cell
// a focus ring — because an inline style object can't carry :focus-visible.
// DataTable owns the chrome now, so focus styling comes from the design
// system and the row stays reachable from the keyboard. The name cell is a
// PersonRef — the same link-plus-people-card every other person on this page
// renders as.

import { DataTable, InlinePlaceholder, T } from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { PersonRef } from './PersonRef';
import { RoleCycleChip } from '../../components/marketplace/GovernanceEditor';
import type { ProjectContributor } from './types';

export function ContributorsTable({
  contributors,
  projectId,
  onRole,
  onOpenPerson,
}: {
  contributors: ProjectContributor[];
  projectId: string;
  /** Optimistic apply / revert of one contributor's role. */
  onRole: (personId: string, role: string | null) => void;
  /** Open the shared, page-level person card (keeps the breadcrumb). */
  onOpenPerson: (personId: string, role: string | null) => void;
}) {
  if (contributors.length === 0) {
    return <InlinePlaceholder>No contributors recorded.</InlinePlaceholder>;
  }

  const columns: DataTableColumn<ProjectContributor>[] = [
    {
      // The name is a LINK to the person's graph node, and hovering it opens
      // the people card. The row click still opens the in-place modal — the
      // two answer different questions ("remind me who this is", without
      // leaving, versus "take me to them"), and collapsing them into one
      // control is what left names unclickable everywhere else.
      key: 'name', header: 'Name', sortable: true,
      render: (c) => (
        <span onClick={(e) => e.stopPropagation()}>
          <PersonRef
            personId={c.personId}
            name={c.name}
            title={c.title}
            avatarUrl={c.avatarUrl}
            avatarSize={24}
            className="text-sm font-medium text-text-primary"
          />
        </span>
      ),
    },
    {
      key: 'title', header: 'Title', sortable: true,
      render: (c) => <T className="text-text-secondary">{c.title ?? '—'}</T>,
    },
    {
      key: 'role', header: 'Role',
      // Reserved roles get chips — owner runs the initiative, SMEs direct
      // agents across the initiatives they're attached to. The cell is a
      // compact cycle control ('—' → sme → owner) that PATCHes the role
      // optimistically; a 403 reverts with a quiet toast.
      render: (c) => (
        <span onClick={(e) => e.stopPropagation()}>
          <RoleCycleChip projectId={projectId} personId={c.personId} role={c.role} onRole={onRole} />
        </span>
      ),
    },
    {
      key: 'weight', header: 'Weight', numeric: true, sortable: true,
      render: (c) => (
        <T className="font-medium text-text-secondary tabular-nums" title={`${(c.weight * 100).toFixed(0)}% attribution`}>
          {(c.weight * 100).toFixed(0)}%
        </T>
      ),
    },
  ];

  return (
    <DataTable
      striped
      data={contributors}
      columns={columns}
      keyField={(c) => c.personId}
      onRowClick={(c) => onOpenPerson(c.personId, c.role)}
    />
  );
}
