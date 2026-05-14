import { useMemo, useState } from 'react';
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { ScoreEntry, PersonDetail, DEPT_COLORS } from '../components/scores/types';
import { StatCards } from '../components/scores/StatCards';
import { DepartmentFilter } from '../components/scores/DepartmentFilter';
import { Leaderboard } from '../components/scores/Leaderboard';
import { PersonDetailCard } from '../components/scores/PersonDetailCard';
import { SkillFilter } from '../components/scores/SkillFilter';

function ScoresPage() {
  const [skillFilter, setSkillFilter] = useState<string>('');
  const leaderboardUrl = skillFilter
    ? `/api/scores/by-skill?skill=${encodeURIComponent(skillFilter)}&limit=100`
    : '/api/scores/leaderboard?limit=100';
  const { data } = useFetch<{ entries: ScoreEntry[]; total: number; mostRecentScoredAt: string | null }>(leaderboardUrl);
  const [deptFilter, setDeptFilter] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: detail } = useFetch<PersonDetail>(
    selectedId ? `/api/graph/people/${encodeURIComponent(selectedId)}` : '',
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    return deptFilter ? data.entries.filter(e => e.department === deptFilter) : data.entries;
  }, [data, deptFilter]);

  const departments = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.entries.map(e => e.department))).sort();
  }, [data]);

  if (!data) return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading scores...</div>;
  if (data.entries.length === 0) {
    return (
      <div style={{ padding: 40, maxWidth: 560 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>No scored people yet</h2>
        <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
          Run <code>python schema/seed.py</code> to populate Aurora, or invoke the scoring agent to compute scores.
        </p>
      </div>
    );
  }

  const top = filtered[0]?.composite ?? 0;
  const avg = filtered.length > 0
    ? Math.round(filtered.reduce((s, e) => s + e.composite, 0) / filtered.length)
    : 0;

  return (
    <PageSection title="Scoring Dashboard">
      <StatCards
        peopleScored={filtered.length}
        avgComposite={avg}
        topScore={top}
        departmentCount={departments.length}
        mostRecentScoredAt={data.mostRecentScoredAt ?? null}
      />

      <SkillFilter selectedSkill={skillFilter} onChange={setSkillFilter} />

      <DepartmentFilter
        departments={departments}
        selected={deptFilter}
        onChange={setDeptFilter}
        deptColors={DEPT_COLORS}
      />

      <div style={{ display: 'grid', gridTemplateColumns: detail ? '1fr 360px' : '1fr', gap: 24 }}>
        <Leaderboard
          entries={filtered}
          selectedId={selectedId}
          onSelect={setSelectedId}
          deptColors={DEPT_COLORS}
          rankedBy={skillFilter || null}
        />

        {detail && (
          <PersonDetailCard
            detail={detail}
            deptColors={DEPT_COLORS}
            onClose={() => setSelectedId(null)}
            onSelectConnection={setSelectedId}
          />
        )}
      </div>
    </PageSection>
  );
}

export default ScoresPage;
