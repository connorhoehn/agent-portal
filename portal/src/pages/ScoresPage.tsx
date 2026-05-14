import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { ScoreEntry, PersonDetail, DEPT_COLORS } from '../components/scores/types';
import { StatCards } from '../components/scores/StatCards';
import { DepartmentFilter } from '../components/scores/DepartmentFilter';
import { Leaderboard } from '../components/scores/Leaderboard';
import { PersonDetailCard } from '../components/scores/PersonDetailCard';
import { SkillFilter } from '../components/scores/SkillFilter';
import { WeightSlider } from '../components/scores/WeightSlider';

function ScoresPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [skillFilter, setSkillFilter] = useState<string>('');
  const leaderboardUrl = skillFilter
    ? `/api/scores/by-skill?skill=${encodeURIComponent(skillFilter)}&limit=100`
    : '/api/scores/leaderboard?limit=100';
  const { data } = useFetch<{ entries: ScoreEntry[]; total: number; mostRecentScoredAt: string | null }>(leaderboardUrl);
  const [deptFilter, setDeptFilter] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comparisonIds, setComparisonIds] = useState<Set<string>>(new Set());

  const rawW = parseFloat(searchParams.get('w') ?? '');
  const initWeight = isNaN(rawW) || rawW < 0 || rawW > 1 ? 0.55 : rawW;
  const [weight, setWeight] = useState<number>(initWeight);

  useEffect(() => {
    if (weight === 0.55) {
      setSearchParams((prev: URLSearchParams) => { prev.delete('w'); return prev; }, { replace: true });
    } else {
      setSearchParams({ w: weight.toString() }, { replace: true });
    }
  }, [weight]);

  const { data: detail } = useFetch<PersonDetail>(
    selectedId ? `/api/graph/people/${encodeURIComponent(selectedId)}` : '',
  );

  const reweighted = useMemo(() => {
    if (!data) return [];
    const list = data.entries.map(e => ({
      ...e,
      composite: Math.round(weight * e.influence + (1 - weight) * e.expertise),
    }));
    list.sort((a, b) => b.composite - a.composite);
    return list;
  }, [data, weight]);

  const filtered = useMemo(() => {
    if (!reweighted.length) return [];
    return deptFilter ? reweighted.filter(e => e.department === deptFilter) : reweighted;
  }, [reweighted, deptFilter]);

  const departments = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.entries.map(e => e.department))).sort();
  }, [data]);

  const handleToggleCompare = useCallback((id: string) => {
    setComparisonIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 4) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const compareDisabled = comparisonIds.size >= 4;

  const handleCompare = useCallback(() => {
    if (comparisonIds.size < 2) return;
    const ids = Array.from(comparisonIds).join(',');
    const wParam = searchParams.get('w');
    const query = wParam ? `?ids=${ids}&w=${wParam}` : `?ids=${ids}`;
    navigate(`/iq/scores/compare${query}`);
  }, [comparisonIds, searchParams, navigate]);

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
        weight={weight}
      />

      <SkillFilter selectedSkill={skillFilter} onChange={setSkillFilter} />

      <WeightSlider value={weight} onChange={setWeight} />

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
          weight={weight}
          comparisonIds={comparisonIds}
          onToggleCompare={handleToggleCompare}
          compareDisabled={compareDisabled}
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

      {comparisonIds.size >= 2 && comparisonIds.size <= 4 && (
        <button
          onClick={handleCompare}
          style={{
            position: 'fixed',
            bottom: 32,
            right: 32,
            zIndex: 100,
            padding: '10px 20px',
            borderRadius: 8,
            border: 'none',
            background: 'var(--color-primary, #6366f1)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(99,102,241,0.35)',
          }}
        >
          Compare {comparisonIds.size} &#8594;
        </button>
      )}
    </PageSection>
  );
}

export default ScoresPage;
