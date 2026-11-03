// Entity titles for the breadcrumb trail.
//
// `resolveBreadcrumbs` is pure pathname → crumbs, so a detail route can only
// show what the URL carries: "des-auth…" for a design, "Job 3f9a…" for a run.
// The page that fetched the entity knows its title. This is the one-way
// channel between the two: a page registers `id → label` while it is mounted,
// the shell reads it, and the crumb says "Session token rotation on tenant
// switch" instead of a truncated id. Unregistered ids fall back to the
// resolver's label, so nothing here is load-bearing for a page that does not
// opt in.
import { useEffect, useSyncExternalStore } from 'react';

const labels = new Map<string, string>();
const listeners = new Set<() => void>();
// A new Map identity per change so useSyncExternalStore sees a snapshot move.
let snapshot: ReadonlyMap<string, string> = new Map();

function emit(): void {
  snapshot = new Map(labels);
  listeners.forEach((l) => l());
}

export function setCrumbLabel(id: string, label: string | null | undefined): void {
  if (!id) return;
  if (label == null || label === '') {
    if (!labels.delete(id)) return;
  } else {
    if (labels.get(id) === label) return;
    labels.set(id, label);
  }
  emit();
}

export function crumbLabel(id: string | undefined): string | undefined {
  return id ? snapshot.get(id) : undefined;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function getSnapshot(): ReadonlyMap<string, string> { return snapshot; }

/** The shell's read side. */
export function useCrumbLabels(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** A page's write side: the label lives exactly as long as the page does. */
export function useCrumbLabel(id: string | undefined, label: string | null | undefined): void {
  useEffect(() => {
    if (!id) return;
    setCrumbLabel(id, label);
    return () => setCrumbLabel(id, null);
  }, [id, label]);
}

/** Test seam. */
export function resetCrumbLabels(): void {
  labels.clear();
  emit();
  trails.clear();
  trailSnapshot = new Map();
}

// ─── A page-owned trail ──────────────────────────────────────────────────────
// A pathname can name a record whose PLACE the URL does not carry: a Work
// page under /iq/documents/:id belongs to an initiative, while the resolver
// can only say "Search › <id>". The page that fetched it registers the whole
// trail under the record's id; the shell uses that trail while the page is
// mounted and falls back to the resolver's otherwise (2026-11-03).
export interface TrailCrumb { label: string; path?: string; id?: string }
const trails = new Map<string, readonly TrailCrumb[]>();
let trailSnapshot: ReadonlyMap<string, readonly TrailCrumb[]> = new Map();
function emitTrails(): void {
  trailSnapshot = new Map(trails);
  listeners.forEach((l) => l());
}
export function setCrumbTrail(id: string, trail: readonly TrailCrumb[] | null | undefined): void {
  if (!id) return;
  if (!trail || trail.length === 0) {
    if (!trails.delete(id)) return;
  } else {
    trails.set(id, trail);
  }
  emitTrails();
}
function getTrailSnapshot(): ReadonlyMap<string, readonly TrailCrumb[]> { return trailSnapshot; }
/** The shell's read side: the trail registered for a crumb's id, if any. */
export function useCrumbTrails(): ReadonlyMap<string, readonly TrailCrumb[]> {
  return useSyncExternalStore(subscribe, getTrailSnapshot, getTrailSnapshot);
}
/** A page's write side: the trail lives exactly as long as the page does. */
export function useCrumbTrail(id: string | undefined, trail: readonly TrailCrumb[] | null | undefined): void {
  const key = JSON.stringify(trail ?? null);
  useEffect(() => {
    if (!id) return;
    setCrumbTrail(id, trail);
    return () => setCrumbTrail(id, null);
  }, [id, key]); // eslint-disable-line react-hooks/exhaustive-deps
}
export function crumbTrail(id: string | undefined): readonly TrailCrumb[] | undefined {
  return id ? trailSnapshot.get(id) : undefined;
}
