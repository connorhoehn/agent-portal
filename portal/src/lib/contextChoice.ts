// Tracks whether the user has picked a workspace (tenant + role) via the
// context chooser. Keyed by the identity's `sub`, so a different sign-in
// re-prompts automatically (no logout hook needed), while navigating around as
// the same identity doesn't nag. Session-scoped: a new tab starts fresh.

const KEY = 'orgiq.contextChosen';

export function markContextChosen(sub: string): void {
  try { sessionStorage.setItem(KEY, sub); } catch { /* private mode — ignore */ }
}

export function hasChosenContext(sub: string): boolean {
  try { return !!sub && sessionStorage.getItem(KEY) === sub; } catch { return false; }
}

/** Count the distinct (tenant, role) contexts a grants map offers. */
export function contextCount(grants: Record<string, string[]> | undefined): number {
  if (!grants) return 0;
  return Object.values(grants).reduce((n, roles) => n + (roles?.length ?? 0), 0);
}
