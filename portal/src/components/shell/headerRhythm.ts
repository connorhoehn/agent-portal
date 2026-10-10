// The Org header rhythm (docs/branding.md): a page's one title is the 20px/600
// `PageHeader`/`PageSection` heading, and its top sits 16px under the bottom
// of the trail above it — on a padded page and on a flush one alike.
//
// On a padded page the trail is the shell's own row, and `mb-4` in
// Breadcrumbs.tsx is the 16px. A flush layout (`data-shell-flush`) hides that
// row and prints the same trail as a `ScopeHeader variant="crumbs"` band,
// whose box ends 4px under its crumb line (`pb-1`). The body under the band
// therefore starts 12px lower, and the title it opens with lands 16px under
// the trail. Before this lived in one place each flush layout picked its own
// gap — 4px under Automate, 24px under a design thread — and every title
// landed somewhere different.
export const UNDER_CRUMBS_BAND = 'pt-3';

// Distillation hangs its repository select and the Agent library link in that
// band (app.css keeps the hang in flow inside the module), so the band ends
// 12px under the crumb line instead of 4px, and the body under it starts 4px
// lower to put its title at the same 16px.
export const UNDER_CRUMBS_BAND_WITH_CONTROLS = 'pt-1';
