# operator — pipelines journey defects

## Open (owned by lane P2)

1. **Configuration is in the rail for every pipelines role.** `NAV_ITEMS` (`portal/src/components/shell/Layout.tsx`) and the palette row carry no role gate for `/pipelines/configuration`, so an operator sees the entry. On lane P0 the page is a read-only empty state with no control, so no forbidden action is reachable; the separation-of-duties table says author and operator never see Configuration. Gate the rail row, the palette row and the route together (validate-nav-parity.sh judges all three) when P2 gives the page its `ManagePipelineConfig` controls.

   *Still open after the P2 walk (2026-09-30).* P2 shipped the server half —
   `GET/PUT /api/pipelines/configuration`, the PUT gated on
   `ManagePipelineConfig` (default approver role, design §8) — but not the
   page or the rail/palette/route gate, because gating the Configuration row
   changes `Layout.tsx`/`portalCommands.ts`/`App.tsx` together and re-opens
   the configuration logs, which the P2 walk did not own.
