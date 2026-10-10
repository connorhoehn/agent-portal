The portal consumes checked-in archives built from the consolidated shared repositories:

- ui-components 2.440.0: main `e7a42a4fc772760c8271d8cee99a1a9a05456500`; archive SHA-256 `ca4bb18704495a29d473cd463d36fbd3f35faaec372c7bdb21263b8b7f7bcbd2`.
- realtime-modules 0.115.0: main `57d8a1b424382b856389ae65a78662fc89a630aa`; archive SHA-256 `cf1fd6456cddb295f143bd13abbc7489f8516b72e0f1d3855056e84957de52e8`.

ActivityTicker, notification icon actions, message hover placement, composer bounds, prejoin layout and shared controls belong to ui-components. The app supplies scoped data, navigation and preferences. Vite patches to compiled shared components have been removed. The Today content remains an explicitly labeled local demo.

Native source/dist/package parity, focused native tests, portal typecheck/build and isolated browser checks passed. The optional native static style guard retains 16 inherited unrelated violations. Historical archives/provenance are retained for reproducibility.
