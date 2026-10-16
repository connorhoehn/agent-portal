The portal consumes checked-in archives built from the consolidated shared repositories:

- ui-components 2.440.0: main `e7a42a4fc772760c8271d8cee99a1a9a05456500`; archive SHA-256 `ca4bb18704495a29d473cd463d36fbd3f35faaec372c7bdb21263b8b7f7bcbd2`.
- realtime-modules 0.115.0: main `57d8a1b424382b856389ae65a78662fc89a630aa`; archive SHA-256 `cf1fd6456cddb295f143bd13abbc7489f8516b72e0f1d3855056e84957de52e8`.
- realtime-modules 0.116.1 (`connorhoehn-realtime-modules-0.116.1.tgz`): tag `v0.116.1`, main `fa803ceaee06bb7e6c67d780d1e81180cd9099e0`, distributed-core 0.48.0 `077d7594`; archive SHA-256 `7bf2c27d29ab154ab008de1504254a858f2b1d2a1f8f2148cae2d951619ff5de`.
- realtime-modules 0.117.0 (`connorhoehn-realtime-modules-0.117.0.tgz`): tag `v0.117.0`, main `dc7eb68611946a5079dc59c618534c465c6d8ff8`, distributed-core 0.48.0 `077d7594`; archive SHA-256 `e139ad1d4733b3e74ae792a8757b356673374bf3f1aefebba5a54f4e964d20f1`.
- realtime-modules 0.119.0 (`connorhoehn-realtime-modules-0.119.0.tgz`): tag `v0.119.0`, main `d9e3c7cbee975d6c506bcbf43fe3ff4b7e02b690`, distributed-core 0.48.0 `077d7594`; archive SHA-256 `08f129e9deca0dfee9ea7bc380f93d7fa14c02d40eaca6be68afacc473baafd0`.
- realtime-modules 0.120.0 (`connorhoehn-realtime-modules-0.120.0.tgz`): tag `v0.120.0`, main `6dcaaeea8ee5b191a3152d1cbc6f9cb6c04fdc1b`, distributed-core 0.48.0 `077d7594`; archive SHA-256 `578133acd727d202f48f0e676dc887eb9f63abc47fd0dd3426f832986a31f74e`.
- realtime-modules 0.120.1 (`connorhoehn-realtime-modules-0.120.1.tgz`): tag `v0.120.1`, main `b932a6fcb196abd63f65c25cf6e4848704836070`, distributed-core 0.48.0 `077d7594`; archive SHA-256 `717d4bf5db3de5dd9380d00f4aac475656e42acdf0eecbd7014ded762fb131fb`.
- realtime-modules 0.134.0 (current pin, `connorhoehn-realtime-modules-0.134.0.tgz`): tag `v0.134.0`, main `76dc298b467f26d8932cbee6c9701d3e075b3b27` (meetings: `./meeting`, `./client/meeting`, `useConversationCall({ mediaLobby })`); archive SHA-256 `1c8c22ff802279996a4e0cb381fd2fae9dd34e373c63d5a07d0d3cf0652f97ee`.
- ui-components 2.478.0 (current pin, `connorhoehnslalom-ui-components-2.478.0.tgz`): main `607af592425e18610b7d5d99980e41f321d0f55d` (meeting toolbar, rooms pane, call-host meeting seams); archive SHA-256 `5f96639e730307090417b1e2c14c4ae15d02ef8a47a824637dadb7bbdb6295a8`.

ActivityTicker, notification icon actions, message hover placement, composer bounds, prejoin layout and shared controls belong to ui-components. The app supplies scoped data, navigation and preferences. Vite patches to compiled shared components have been removed. The Today content remains an explicitly labeled local demo.

Native source/dist/package parity, focused native tests, portal typecheck/build and isolated browser checks passed. The optional native static style guard retains 16 inherited unrelated violations. Historical archives/provenance are retained for reproducibility.
