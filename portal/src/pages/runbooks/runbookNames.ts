// Names for the ids the runbooks API speaks in. A person reads "Eli Garcia", "Auth Migration" and
// "auth-dep-watch run", never `p-011`, `p-auth-migration` or `job-auth-maint-2`; the id belongs in a hover
// title. The lookups come from lists other pages already read (/api/graph/entities, /api/graph/projects,
// /api/work/jobs, /api/runbooks), so nothing here needs a new endpoint. An id nothing resolves reads as a
// plain description ("A colleague", "An initiative"), never as the id.
// No React; relative imports carry their `.ts` so `node --test` runs it.

export interface NameSources {
  people?: ReadonlyArray<{ id: string; name: string }>;
  initiatives?: ReadonlyArray<{ id: string; name: string }>;
  jobs?: ReadonlyArray<{ id: string; title: string }>;
  runbooks?: ReadonlyArray<{ id: string; title: string }>;
}

export interface Names {
  person(id: string | null | undefined): string;
  initiative(id: string | null | undefined): string;
  /** A run's label: its job's title when the queue knows it ("auth-dep-watch run"), else a plain description. */
  run(ref: string | null | undefined): string;
  runbook(id: string | null | undefined): string;
  /** Initiatives to choose from, by name. */
  initiatives: ReadonlyArray<{ id: string; name: string }>;
}

const clean = (s: string | undefined | null) => (s ?? '').trim();

export function buildNames(src: NameSources = {}): Names {
  const people = new Map((src.people ?? []).map((p) => [p.id, clean(p.name)]));
  const initiatives = new Map((src.initiatives ?? []).map((p) => [p.id, clean(p.name)]));
  const jobs = new Map((src.jobs ?? []).map((j) => [j.id, clean(j.title)]));
  const runbooks = new Map((src.runbooks ?? []).map((r) => [r.id, clean(r.title)]));
  return {
    person: (id) => (id && people.get(id)) || 'A colleague',
    initiative: (id) => (id && initiatives.get(id)) || 'An initiative',
    run: (ref) => {
      const title = ref ? jobs.get(ref) ?? jobs.get(ref.replace(/^job:/, '')) : undefined;
      if (title) return `${title} run`;
      return ref && /^sess-/.test(ref) ? 'A session run' : 'A run';
    },
    runbook: (id) => (id && runbooks.get(id)) || 'A runbook',
    initiatives: [...(src.initiatives ?? [])].filter((i) => clean(i.name)).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Names with nothing loaded: every lookup falls back to its plain description. */
export const NO_NAMES: Names = buildNames();

/** The task title a brief's markdown opens its "Your task" section with (`**Title** (story, 3 pts, …)`), or null. */
export function briefTaskTitle(markdown: string): string | null {
  const m = /^## Your task\s*\n\*\*(.+?)\*\*/m.exec(markdown);
  return m ? m[1]!.trim() : null;
}
