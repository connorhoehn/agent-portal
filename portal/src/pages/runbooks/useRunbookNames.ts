// The lookups behind `buildNames`, read from lists other pages already share (one request each, deduplicated).
// A list that fails to load only costs its names: the page falls back to plain descriptions.
import { useMemo } from 'react';
import { useFetch } from '../../hooks/useFetch';
import { buildNames, type Names } from './runbookNames';
import type { RunbookRow } from './types';

interface GraphNodes { nodes?: Array<{ id: string; name?: string | null }> }

export function useRunbookNames(): Names {
  const people = useFetch<GraphNodes>('/api/graph/entities', 0, { share: true });
  const initiatives = useFetch<Array<{ id: string; name: string }>>('/api/graph/projects?limit=200', 0, { share: true });
  const jobs = useFetch<{ jobs: Array<{ id: string; title: string }> }>('/api/work/jobs?limit=200', 0, { share: true });
  const runbooks = useFetch<{ runbooks: RunbookRow[] }>('/api/runbooks?status=draft,published,retired&limit=200', 0, { share: true });
  return useMemo(() => buildNames({
    people: (people.data?.nodes ?? []).filter((n): n is { id: string; name: string } => !!n.name),
    initiatives: Array.isArray(initiatives.data) ? initiatives.data : [],
    jobs: jobs.data?.jobs ?? [],
    runbooks: runbooks.data?.runbooks ?? [],
  }), [people.data, initiatives.data, jobs.data, runbooks.data]);
}
