// VIEW 2 — team list for a cohort (or "all"): a filterable table of id, name,
// cohort, status, lead, dimensions assessed, open follow-ups, updated.
// Reproduces the source's TeamList.tsx on ui-components primitives.

import { useMemo, useState } from 'react';
import {
  Button,
  Chip,
  DataTable,
  Inline,
  Input,
  MetaLine,
  PageHeader,
  Select,
  Stack,
  StatStrip,
} from '@connorhoehnslalom/ui-components/shared';
import { filterAndSortTeams, formatTeamStatus, statusOptions, summarizeTeamList } from '../assessmentFormat';
import { fmtDate, teamCertificationCellLabel, type Cohort, type TeamSummary } from '../types';
import { PersonRef } from '../../project-detail/PersonRef';

interface TeamListProps {
  teams: TeamSummary[];
  cohort: Cohort | 'all';
  cohortTitle: string;
  onSelectTeam: (teamId: string) => void;
}

const ALL = 'all';

export function TeamList({ teams, cohortTitle, onSelectTeam }: TeamListProps) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>(ALL);

  const statuses = useMemo(() => statusOptions(teams), [teams]);
  const filtered = useMemo(() => filterAndSortTeams(teams, { search, status }), [teams, search, status]);
  const summary = useMemo(() => summarizeTeamList(filtered), [filtered]);
  const hasFilters = search.trim() !== '' || status !== ALL;

  return (
    <Stack gap="md">
      <PageHeader
        title={cohortTitle}
        description={`${teams.length} team${teams.length === 1 ? '' : 's'} in this motion.`}
      />

      <StatStrip
        items={[
          { label: 'Teams', value: summary.count },
          {
            label: summary.targetLevel === null ? 'Certified' : `Verified at Level ${summary.targetLevel}`,
            value: summary.targetLevel === null ? '—' : summary.certifiedCount,
            hint: summary.targetLevel === null ? 'not yet assessed' : `of ${summary.count} teams`,
          },
          { label: 'Assessed', value: summary.dimensionsAssessed, hint: `/ ${summary.dimensionsTotal}` },
          {
            label: 'Open follow-ups',
            value: summary.followupsOpen,
            tone: summary.followupsOpen > 0 ? 'danger' : 'default',
          },
        ]}
      />

      <Inline wrap align="center" gap="sm" className="rounded-lg bg-surface px-3 py-2.5 shadow-sm ring-1 ring-border">
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by team name or ID…"
          className="min-w-[200px] flex-1"
        />
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[{ value: ALL, label: 'All statuses' }, ...statuses.map((s) => ({ value: s, label: formatTeamStatus(s) }))]}
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => { setSearch(''); setStatus(ALL); }}>
            Clear filters
          </Button>
        )}
      </Inline>

      <DataTable<TeamSummary>
        data={filtered}
        keyField={(t) => t.id}
        onRowClick={(t) => onSelectTeam(t.id)}
        striped
        emptyMessage={teams.length === 0 ? 'No teams found in this cohort yet.' : 'No teams match the current filters.'}
        columns={[
          {
            key: 'id',
            header: 'Team',
            sortable: true,
            // A real Button, not just the row's onClick: DataTable's row-click
            // is a bare <tr onClick> with no tabIndex/keydown handling, so a
            // keyboard user tabbing through the filter bar would otherwise
            // skip straight past every row with no way to open one. This is
            // the row's one focusable, Enter/Space-activatable control; the
            // row click stays as a mouse convenience alongside it.
            render: (t) => (
              <Button
                variant="ghost"
                size="sm"
                className="font-mono text-xs text-text-tertiary"
                title={t.name}
                onClick={(e) => { e.stopPropagation(); onSelectTeam(t.id); }}
              >
                {t.id}
              </Button>
            ),
          },
          { key: 'name', header: 'Name', sortable: true },
          { key: 'cohort_label', header: 'Cohort' },
          { key: 'status', header: 'Status', render: (t) => <Chip size="xs">{formatTeamStatus(t.status)}</Chip> },
          { key: 'assessment_lead', header: 'Lead', render: (t) => (
            <PersonRef personId={t.assessment_lead_person_id ?? null} name={t.assessment_lead} showAvatar={false} />
          ) },
          { key: 'dimensions', header: 'Assessed', sortable: true, render: (t) => (
            <Inline gap="none">
              <strong className="font-medium text-text-primary">{t.dimensions_assessed}</strong>
              {`/${t.dimensions_total}`}
            </Inline>
          ) },
          { key: 'followups_open', header: 'Open follow-ups', sortable: true, render: (t) => (
            t.followups_open > 0 ? <Chip tone="warning" size="xs">{t.followups_open} open</Chip> : <MetaLine items={['—']} />
          ) },
          { key: 'certification', header: 'Certification', render: (t) => (
            <MetaLine size="xs" tone="secondary" items={[teamCertificationCellLabel(t.certification) ?? 'Not yet assessed']} />
          ) },
          { key: 'updated_at', header: 'Updated', sortable: true, render: (t) => fmtDate(t.updated_at) },
        ]}
      />
    </Stack>
  );
}
