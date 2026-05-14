import { useMemo } from 'react';
import { useSearchParams, Navigate, Link } from 'react-router';
import { useFetch } from '../hooks/useFetch';
import { DEPT_COLORS } from '../components/scores/types';
import { OverlayRadar } from '../components/scores/OverlayRadar';
import { CompareDeltaTable } from '../components/scores/CompareDeltaTable';
import type { RadarBatchEntry } from '../components/scores/OverlayRadar';

function ScoresComparePage() {
  const [searchParams] = useSearchParams();
  const idsParam = searchParams.get('ids') ?? '';

  const ids = useMemo(() => {
    if (!idsParam) return [];
    return idsParam.split(',').map(s => s.trim()).filter(Boolean);
  }, [idsParam]);

  const isValid = ids.length >= 2 && ids.length <= 4;

  const fetchUrl = isValid ? `/api/scores/radar?ids=${ids.map(encodeURIComponent).join(',')}` : '';
  const { data, isLoading, error } = useFetch<RadarBatchEntry[]>(fetchUrl);

  if (!isValid) {
    return <Navigate to="/scores" replace />;
  }

  const backUrl = searchParams.get('w') ? `/scores?w=${searchParams.get('w')}` : '/scores';

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <Link
          to={backUrl}
          style={{ fontSize: 13, color: 'var(--color-primary, #6366f1)', textDecoration: 'none' }}
        >
          &#8592; Back to Scores
        </Link>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
          Compare {ids.length} {ids.length === 1 ? 'person' : 'people'}
        </h1>
      </div>

      {isLoading && (
        <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>Loading radar data...</div>
      )}

      {error && (
        <div style={{ color: '#dc2626', fontSize: 13 }}>Failed to load: {error}</div>
      )}

      {data && data.length > 0 && (
        <>
          <div style={{ marginBottom: 32 }}>
            <OverlayRadar entries={data} deptColors={DEPT_COLORS} />
          </div>

          <div style={{
            background: 'var(--color-surface, #1e1e2e)',
            border: '1px solid var(--color-border, #3f3f5f)',
            borderRadius: 8,
            overflow: 'hidden',
          }}>
            <CompareDeltaTable entries={data} />
          </div>
        </>
      )}

      {data && data.length === 0 && (
        <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13, padding: 24 }}>
          No radar data found for the selected people. Scores may not have been computed yet.
        </div>
      )}
    </div>
  );
}

export default ScoresComparePage;
