import { useEffect, useState } from 'react';

/**
 * Autocomplete sources for the test harness.
 *
 * Both are best-effort: a prompt variable accepts free text regardless, so a
 * failed fetch degrades to a plain text box rather than blocking the test. That
 * is why the catch swallows — there is nothing for the user to do about it and
 * nothing broken if it never arrives.
 */

function useNameList(url: string, read: (body: unknown) => string[]): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(r => r.json())
      .then(body => { if (!cancelled) setNames(read(body).filter(Boolean)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // `read` is a module-level literal at every call site below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return names;
}

const readLeaderboard = (body: unknown): string[] =>
  ((body as { entries?: { name: string }[] }).entries ?? []).map(e => e.name);

const readSkills = (body: unknown): string[] =>
  (Array.isArray(body) ? (body as { name: string }[]) : []).map(s => s.name);

export function usePersonOptions(): string[] {
  return useNameList('/api/scores/leaderboard?limit=50', readLeaderboard);
}

export function useSkillOptions(): string[] {
  return useNameList('/api/scores/skills?limit=60', readSkills);
}
