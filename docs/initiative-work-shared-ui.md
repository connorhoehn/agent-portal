# Initiative Work page: shared UI ownership

The initiative detail page follows the supplied two-rail mockup. The portal
composes `ExplorerLayout`, `ScopeHeader`, `RailNavList`, `WorkTableView`, and the
document-view `RichChatComposer` / `FloatingComposerDock` from `ui-components`.
There is no portal-local Work table component or table styling override.

The reusable table lives in the sibling library at
`src/components/work/WorkTableView.tsx`, exported from the package root. Its
README, component documentation, Storybook examples, and interaction tests live
in that same domain. `RailNavList` owns the selected-view tint and router-event
extension. Portal code owns API data, role permissions, URL state, and callbacks.

## Dependency pin

The portal pins the library by full git sha in `portal/package.json`
(`github:connorhoehnslalom/ui-components#<sha>`, 2.407.23 = `0c7feebd`), the same
way as every other bump. It briefly ran on a `file:../../ui-components` link
while the component was being ported; that link and the `install-links` npmrc
line are gone, and neither should come back on a branch that gets committed.

After bumping the sha, `rm -rf portal/node_modules/.vite` and restart Vite,
since its module graph caches dependency exports.
