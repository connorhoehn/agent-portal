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
}
