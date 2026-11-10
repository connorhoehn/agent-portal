import { runbookDisplayTitle } from './runbookTitles.ts';
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
  /** Sign-in accounts (`u-nora`) by display name: the tenant's shared directory (`/api/people/shared`). */
  users?: ReadonlyArray<{ id: string; name: string }>;
}

export interface Names {
  person(id: string | null | undefined): string;
  initiative(id: string | null | undefined): string;
  /** A run's label: its job's title when the queue knows it ("auth-dep-watch run"), else a plain description. */
  run(ref: string | null | undefined): string;
  runbook(id: string | null | undefined): string;
  /** A sign-in account's display name, or null when the directory does not know it (no fallback: a diff keeps the id). */
  user(id: string | null | undefined): string | null;
  /** Initiatives to choose from, by name. */
  initiatives: ReadonlyArray<{ id: string; name: string }>;
}

const clean = (s: string | undefined | null) => (s ?? '').trim();

export function buildNames(src: NameSources = {}): Names {
  const people = new Map((src.people ?? []).map((p) => [p.id, clean(p.name)]));
  const initiatives = new Map((src.initiatives ?? []).map((p) => [p.id, clean(p.name)]));
  const jobs = new Map((src.jobs ?? []).map((j) => [j.id, clean(j.title)]));
  const runbooks = new Map((src.runbooks ?? []).map((r) => [r.id, runbookDisplayTitle(clean(r.title))]));
  const users = new Map((src.users ?? []).filter((u) => clean(u.name) && clean(u.name) !== u.id).map((u) => [u.id, clean(u.name)]));
  return {
    person: (id) => (id && people.get(id)) || 'A colleague',
    initiative: (id) => (id && initiatives.get(id)) || 'An initiative',
    run: (ref) => {
      const title = ref ? jobs.get(ref) ?? jobs.get(ref.replace(/^job:/, '')) : undefined;
      if (title) return `${title} run`;
      return ref && /^sess-/.test(ref) ? 'A session run' : 'A run';
    },
    runbook: (id) => (id && runbooks.get(id)) || 'A runbook',
    user: (id) => (id && users.get(id)) || null,
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

/** An account id as a diff spells it: `u-nora`, `u-release`. */
const USER_ID = /\bu-[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/g;

/**
 * A proposal diff with its account ids read as names (UX leftovers, 10 November).
 *
 * A bundle's recorded data keys people by account id (a presence snapshot's `"u-omar"`, an
 * expected output's "Omar Haddad (u-omar)"), so the expanded diff showed raw `u-…` ids. This is
 * a presentational mapping at render time; the stored snapshot is unchanged and the page keeps a
 * "show raw" toggle for the literal diff. A name comes from the directory (`user`), else from the
 * diff itself where it pairs a name with the id ("Omar Haddad (u-omar)", `"u-omar": { "n": "Omar
 * Haddad"`). "Name (u-id)" reads as the name once; an id nothing names stays as written.
 */
export function diffWithNames(text: string, user: (id: string) => string | null): { text: string; replaced: number } {
  const paired = new Map<string, string>();
  for (const m of text.matchAll(/([A-Z][\p{L}'.-]*(?: [A-Z][\p{L}'.-]*)+) \((u-[a-z][a-z0-9-]*)\)/gu)) paired.set(m[2]!, m[1]!);
  for (const m of text.matchAll(/"(u-[a-z][a-z0-9-]*)":\s*\{\s*"n(?:ame)?":\s*"([^"]+)"/g)) if (!paired.has(m[1]!)) paired.set(m[1]!, m[2]!);
  const nameOf = (id: string) => user(id) ?? paired.get(id) ?? null;
  let replaced = 0;
  const lines = text.split('\n').map((line) => {
    // The diff's own headers name files, never people.
    if (/^(?:diff --git|--- |\+\+\+ |@@ )/.test(line)) return line;
    return line
      .replace(/([A-Z][\p{L}'.-]*(?: [A-Z][\p{L}'.-]*)+) \((u-[a-z][a-z0-9-]*)\)/gu, (whole, name: string, id: string) => {
        const resolved = nameOf(id);
        if (!resolved) return whole;
        replaced++;
        return resolved === name ? name : `${name} (${resolved})`;
      })
      .replace(USER_ID, (id) => { const resolved = nameOf(id); if (!resolved) return id; replaced++; return resolved; });
  });
  return { text: lines.join('\n'), replaced };
}
