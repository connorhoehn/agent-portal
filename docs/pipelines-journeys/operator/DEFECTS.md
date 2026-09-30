# operator — pipelines journey defects

## Open (owned by lane P2)

1. **Configuration is in the rail for every pipelines role.** `NAV_ITEMS` (`portal/src/components/shell/Layout.tsx`) and the palette row carry no role gate for `/pipelines/configuration`, so an operator sees the entry. On lane P0 the page is a read-only empty state with no control, so no forbidden action is reachable; the separation-of-duties table says author and operator never see Configuration. Gate the rail row, the palette row and the route together (validate-nav-parity.sh judges all three) when P2 gives the page its `ManagePipelineConfig` controls.
