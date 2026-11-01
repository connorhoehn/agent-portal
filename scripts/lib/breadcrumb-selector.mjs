// Breadcrumbs may name their location to distinguish navigation landmarks.
// ScopeHeader declares its trail with a *-crumbs test id and an ordered list;
// an arbitrary location/navigation label alone must never satisfy the probes.
export const BREADCRUMB_SELECTOR = 'nav[aria-label*="breadcrumb" i], nav[aria-label][data-testid$="-crumbs"]:has(> ol)';
