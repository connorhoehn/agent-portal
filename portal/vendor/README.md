This folder holds the packed library tarballs the portal installs with `file:vendor/...`; only the versions pinned in `portal/package.json` are kept.
Today: `@connorhoehn/realtime-modules` 0.151.0 for both `portal` and `middleware` (the middleware reaches it as `file:../portal/vendor/...`), `@connorhoehn/ui-components` 2.546.0 (packs as `connorhoehn-ui-components-<version>.tgz`).
To make a new one, run `npm pack --pack-destination <this folder>` in the library repo, point the `file:` pins at it, run `npm install`, and delete the tarball it replaces.
Both consumers (`portal` and `middleware`) must pin the same realtime-modules version.
Older tarballs, patches and provenance files are in git history before this commit.
