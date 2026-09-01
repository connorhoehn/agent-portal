import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { ScoreAnalysisPanel } from '../components/scores/ScoreAnalysisPanel';
import { useFetch } from '../hooks/useFetch';
import { useCapabilities } from '../lib/capabilities';
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
  // The access message below used to be derived from the ERROR STRING
  // (/403|forbidden/), which meant the page had to be REFUSED before it could
  // explain itself — a guaranteed console error on every load for every role
  // without the grant. The capability answers the same question without asking
  // the server, so ask it first and skip the request entirely.
  //
  // The error-string check stays as a fallback: the server can deny for reasons
  // the client cannot predict (tenant scope, a policy condition), and those must
  // still land on this message rather than a raw failure.
  const { can, ready: capsReady } = useCapabilities();
  const mayViewLeaderboard = capsReady && can('ViewLeaderboard');
  const { data, isLoading, error, refresh } = useFetch<{ entries: ScoreEntry[]; total: number; mostRecentScoredAt: string | null }>(
    mayViewLeaderboard ? leaderboardUrl : null,
  );
  const [deptFilter, setDeptFilter] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comparisonIds, setComparisonIds] = useState<Set<string>>(new Set());

  const rawW = parseFloat(searchParams.get('w') ?? '');
  const initWeight = isNaN(rawW) || rawW < 0 || rawW > 1 ? 0.55 : rawW;
  const [weight, setWeight] = useState<number>(initWeight);
  const urlSyncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => { if (urlSyncTimerRef.current) clearTimeout(urlSyncTimerRef.current); };
  }, []);

  const handleWeightChange = useCallback((newWeight: number) => {
    setWeight(newWeight);
    if (urlSyncTimerRef.current) clearTimeout(urlSyncTimerRef.current);
    urlSyncTimerRef.current = setTimeout(() => {
      if (newWeight === 0.55) {
        setSearchParams((prev: URLSearchParams) => { prev.delete('w'); return prev; }, { replace: true });
      } else {
        setSearchParams({ w: newWeight.toString() }, { replace: true });
      }
    }, 300);
  }, [setSearchParams]);

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

  // Capabilities not resolved yet is LOADING, not denied — rendering "access
  // needed" during the probe would accuse the user of lacking a permission we
  // have not finished checking.
  if (!capsReady || isLoading) return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading scores…</div>;
  if (!mayViewLeaderboard || error) {
    const denied = !mayViewLeaderboard || /403|forbidden/i.test(error ?? '');
    return (
      <div style={{ padding: 40, maxWidth: 560 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
          {denied ? 'Leaderboard access needed' : 'Could not load scores'}
        </h2>
        <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
          {denied
            ? 'The scoring dashboard is limited to the org-leader and HR Admin roles (the ViewLeaderboard permission). Switch role from the identity menu, top right — or ask an admin for the grant.'
            : <>Scores come from Aurora. {error}</>}
        </p>
        {!denied && (
          <button
            type="button"
            onClick={refresh}
            style={{ marginTop: 14, padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}
          >
            Try again
          </button>
        )}
      </div>
    );
  }
  if (!data) return null;
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

      {/* Above the filters: the numbers below are only interpretable once you
          know what the composite is weighting, and that was never stated
          anywhere. */}
      <ScoreAnalysisPanel />

      <SkillFilter selectedSkill={skillFilter} onChange={setSkillFilter} />

      <WeightSlider value={weight} onChange={handleWeightChange} />

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
