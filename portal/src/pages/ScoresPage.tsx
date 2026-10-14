import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, CollapsibleSection, EmptyState, ErrorState, LoadingState, PageSection, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { CollectionCommandHost } from '../components/collections/CollectionCommandHost';
import { collectionCommandAdapter, resolveCollectionTarget } from '../components/collections/collectionCommands';
import { scoreTargets, scoresGrammar } from './scoresCommands';
import { ScoreAnalysisPanel } from '../components/scores/ScoreAnalysisPanel';
import { useFetch } from '../hooks/useFetch';
import { useCapabilities } from '../lib/capabilities';
import { ScoreEntry, PersonDetail, DEPT_COLORS } from '../components/scores/types';
import { computeReweighted } from '../components/scores/scoresFormat';
import { StatCards } from '../components/scores/StatCards';
import { FilterBar } from '../components/scores/FilterBar';
import { Leaderboard } from '../components/scores/Leaderboard';
import { PersonDetailCard } from '../components/scores/PersonDetailCard';
import { LeaderboardAccessNeeded, isLeaderboardForbiddenError } from '../components/scores/LeaderboardAccessNeeded';
import { showingLabel } from '../lib/format';
import { useUrlState } from '../lib/useUrlState';

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
  // The selected person is the URL (`?person=<id>`): a row opens a record the
  // reader can share and Back out of (the rendered-UI audit's record.popout rule).
  const [selectedId, setSelectedId] = useUrlState<string | null>('person', (raw) => raw || null, (v) => v, { replace: false });
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
        setSearchParams((prev: URLSearchParams) => { prev.set('w', newWeight.toString()); return prev; }, { replace: true });
      }
    }, 300);
  }, [setSearchParams]);

  const { data: detail } = useFetch<PersonDetail>(
    selectedId ? `/api/graph/people/${encodeURIComponent(selectedId)}` : '',
  );

  // Keyboard: Escape closes the detail panel and returns focus to whatever
  // opened it (the row's name Button, or a connection row inside the panel
  // itself) — DEFECTS.md org-leader #12. Two bugs stacked here, and fixing
  // only the second one (below) was not enough on its own:
  //
  // 1. The leaderboard used to be re-parented under a `RailLayout` only
  //    while a person was selected (`leaderboardEl` used to be `detail ?
  //    <RailLayout>{leaderboard}</RailLayout> : leaderboard`). That changes
  //    the *type* of the element at this JSX slot — plain `Leaderboard` vs.
  //    `RailLayout` wrapping it — on both Enter (open) and Escape (close),
  //    so React tore down and remounted every row button on both
  //    transitions. A captured DOM-node reference (or even a captured id
  //    looked up fresh) is useless when the target itself was destroyed and
  //    recreated on the very same transition that needs to restore focus to
  //    it. The leaderboard is now rendered in one stable position — see
  //    `{leaderboard}` / `{detail && <PersonDetailCard .../>}` below — never
  //    wrapped conditionally, so a row button is the same DOM node before
  //    and after opening or closing the panel.
  // 2. With the rows no longer remounting, a plain node reference would work
  //    for the *close* transition, but capturing the stable `id` string
  //    (rather than the node) and re-resolving it via `getElementById` in an
  //    effect after the state change — instead of calling `.focus()`
  //    synchronously inside the click handler — is what the DOM actually
  //    requires here: at the moment `selectPerson` runs, the panel hasn't
  //    rendered/unmounted yet, so the *target* of a synchronous `.focus()`
  //    (the row on open, or nothing in particular on close) isn't the right
  //    element yet either way. The row (a focusable <tr>) is the trigger.
  const triggerRef = useRef<HTMLElement | null>(null);
  const prevSelectedRef = useRef<string | null>(null);
  const selectPerson = useCallback((id: string | null) => {
    if (id !== null) {
      const active = document.activeElement;
      triggerRef.current = active instanceof HTMLElement ? active : null;
    }
    setSelectedId(id);
  }, [setSelectedId]);
  useEffect(() => {
    if (prevSelectedRef.current !== null && selectedId === null) {
      const el = triggerRef.current;
      if (el?.isConnected) el.focus();
      triggerRef.current = null;
    }
    prevSelectedRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedId(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, setSelectedId]);

  const reweighted = useMemo(
    () => (data ? computeReweighted(data.entries, weight) : []),
    [data, weight],
  );

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

  // The composer drives the toolbar's own state: search is the skill search
  // (it re-ranks, as the Skill box does), the filter is the Department select,
  // `open` is the row's detail card. Built before the early returns so the
  // hook order never changes.
  const adapter = useMemo(() => collectionCommandAdapter(scoresGrammar(departments), {
    setQuery: setSkillFilter, setFilter: setDeptFilter, refresh, label: 'Leaderboard', id: 'scores-leaderboard-commands',
    scopeNote: 'Commands rank by a skill, pick a department and open one person in the loaded leaderboard; they never change scores, weighting or comparisons.',
    open: (target) => {
      const person = resolveCollectionTarget(target, scoreTargets(filtered));
      selectPerson(person.id);
      return `Showing ${person.title}.`;
    },
  }), [departments, refresh, filtered, selectPerson]);

  const handleCompare = useCallback(() => {
    if (comparisonIds.size < 2) return;
    const ids = Array.from(comparisonIds).map(encodeURIComponent).join(',');
    const wParam = searchParams.get('w');
    const query = wParam ? `?ids=${ids}&w=${wParam}` : `?ids=${ids}`;
    navigate(`/iq/scores/compare${query}`);
  }, [comparisonIds, searchParams, navigate]);

  // Capabilities not resolved yet is LOADING, not denied — rendering "access
  // needed" during the probe would accuse the user of lacking a permission we
  // have not finished checking.
  if (!capsReady || isLoading) return <LoadingState label="Loading scores…" />;
  if (!mayViewLeaderboard) {
    return <LeaderboardAccessNeeded />;
  }
  if (error) {
    if (isLeaderboardForbiddenError(error)) return <LeaderboardAccessNeeded />;
    return (
      <ErrorState
        title="Could not load scores"
        description={<>Scores come from Aurora. {error}</>}
        actionLabel="Try again"
        onAction={refresh}
      />
    );
  }
  if (!data) return null;
  if (data.entries.length === 0) {
    return (
      <EmptyState
        title="No scored people yet"
        description={
          <>Run <code>python schema/seed.py</code> to populate Aurora, or invoke the scoring agent to compute scores.</>
        }
      />
    );
  }

  const top = filtered[0]?.composite ?? 0;
  const avg = filtered.length > 0
    ? Math.round(filtered.reduce((s, e) => s + e.composite, 0) / filtered.length)
    : 0;

  // `filtered.length` is what the table actually shows — a department filter
  // narrows it client-side (never sent server-side, so it's a subset of the
  // fetched ?limit=100 page, not a re-query), and a skill filter swaps the
  // fetch entirely. `data.total` is the real denominator behind whichever of
  // those fetched: the org-wide COUNT(*) when unfiltered or department-only,
  // or the skill's own holder count when a skill filter is active
  // (aurora.ts::realGetLeaderboard / realGetSkillLeaderboard — both a real
  // COUNT alongside the page query, not `entries.length`, which silently
  // equals the LIMIT the instant the real count outgrows it).
  //
  // The stat strip shows both rather than picking one: "56 people" when
  // nothing is hidden, "Showing the first 14 of 56 people" once a filter (or
  // the page cap) narrows the view — so "People Scored" never quietly
  // switches between meaning "org-wide" and "in this view" depending on
  // filter state. See StatCards.tsx.
  const peopleScoredLabel = showingLabel(filtered.length, data.total, 'people');

  // The selected row's own composite, on the same 0-100 scale the leaderboard
  // just displayed it on — threaded into the detail panel so it can show a
  // Composite figure that agrees with the row instead of only "Influence
  // (PageRank)" (DEFECTS.md org-leader #11).
  const selectedEntry = selectedId ? filtered.find(e => e.personId === selectedId) ?? null : null;

  const leaderboard = (
    <Leaderboard
      entries={filtered}
      selectedId={selectedId}
      onSelect={selectPerson}
      deptColors={DEPT_COLORS}
      rankedBy={skillFilter || null}
      weight={weight}
      comparisonIds={comparisonIds}
      onToggleCompare={handleToggleCompare}
      compareDisabled={compareDisabled}
    />
  );
  // Density (DEFECTS.md #3): header (~120px) + StatStrip (~90px) + one
  // description line (~20px) + one filter row (~40px) + this Card's own
  // padding/header (~50px) puts the first data row at roughly 320-360px —
  // comfortably inside the 640px budget at 1440-1552px wide. The "what the
  // score is doing" explainer that used to sit here, plus the separate
  // skill/weighting/department rows, all moved: the first three collapsed
  // into one FilterBar row, and the explainer is now a closed disclosure
  // below the table.
  return (
    <PageSection title="Scores">
      <StatCards
        peopleScoredLabel={peopleScoredLabel}
        avgComposite={avg}
        topScore={top}
        departmentCount={departments.length}
        mostRecentScoredAt={data.mostRecentScoredAt ?? null}
      />

      <T size="xs" as="p" className="mb-3 block text-text-secondary">
        Ranked by composite score (blended influence + expertise) across {departments.length} departments — search a skill to re-rank, or filter by department.
      </T>

      {/* The leaderboard's block owns its command input, which docks at the
          bottom of the content column (CollectionCommandHost → ColumnDock). */}
      <Stack gap="none" className="min-w-0">
        <FilterBar
          skillFilter={skillFilter}
          onSkillChange={setSkillFilter}
          weight={weight}
          onWeightChange={handleWeightChange}
          departments={departments}
          deptFilter={deptFilter}
          onDeptChange={setDeptFilter}
        />

        {leaderboard}

        {detail && (
          <PersonDetailCard
            detail={detail}
            compositeScore={selectedEntry?.composite ?? null}
            influenceScore={selectedEntry?.influence ?? null}
            deptColors={DEPT_COLORS}
            onClose={() => selectPerson(null)}
            onSelectConnection={selectPerson}
          />
        )}

        <CollectionCommandHost adapter={adapter} />
      </Stack>

      <CollapsibleSection title="How scoring works" className="mt-4">
        <ScoreAnalysisPanel />
      </CollapsibleSection>

      {comparisonIds.size >= 2 && comparisonIds.size <= 4 && (
        <Button
          onClick={handleCompare}
          className="fixed bottom-8 right-8 z-[100] shadow-lg"
        >
          Compare {comparisonIds.size} &#8594;
        </Button>
      )}
    </PageSection>
  );
}

export default ScoresPage;
