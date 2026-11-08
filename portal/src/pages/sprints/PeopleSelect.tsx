// The steward / grantee picker, shared by the new-sprint modal and the grants
// panel — the two places this page names a person.
//
// It reads BOTH the initiative's contributors and the org roster (audit RM-5):
// a cross-initiative SME who does not contribute here is still someone the
// backend will accept, so hiding them makes the picker lie about what is
// possible. Contributors come first, labelled with their role, because they
// are the common case.

import { Select } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { peopleGroups } from './sprintFormat';
import type { Contributor, ProjectDetailLite, RosterResponse } from './types';

/** Both pickers need the same two fetches keyed on the same initiative, so the
 *  fetching lives here rather than being re-declared by each caller. Pass a
 *  null initiative id to hold off (the modal does, until one is chosen). */
export function usePeopleOptions(initiativeId: string | null) {
  const { data: project } = useFetch<ProjectDetailLite>(
    initiativeId ? `/api/graph/projects/${encodeURIComponent(initiativeId)}` : null,
  );
  const { data: roster, isLoading } = useFetch<RosterResponse>('/api/roster');
  const contributors: Contributor[] = project?.contributors ?? [];
  return { groups: peopleGroups(contributors, roster?.people ?? []), isLoading };
}

export interface PeopleSelectProps {
  value: string;
  onChange: (personId: string) => void;
  groups: ReturnType<typeof peopleGroups>;
  loading: boolean;
  /**
   * The label on the empty option. It is a real, selectable choice for the
   * steward ("Unassigned" clears the field) and a prompt for the grantee
   * ("Select…"), so it is an ordinary option rather than Select's disabled
   * `placeholder`.
   */
  emptyLabel: string;
  id?: string;
  'aria-describedby'?: string;
  /** Focus this field on mount — the caller uses it when this select is the
   *  first field of a form that just opened. */
  autoFocus?: boolean;
}

export function PeopleSelect({
  value, onChange, groups, loading, emptyLabel, id, autoFocus, ...aria
}: PeopleSelectProps) {
  const hasPeople = groups.length > 0;
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={[{
        value: '',
        label: hasPeople ? emptyLabel : loading ? 'Loading people…' : 'No people available',
        disabled: !hasPeople,
      }]}
      groups={groups}
      autoFocus={autoFocus}
      {...aria}
    />
  );
}
