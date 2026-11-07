This folder holds the packed library tarballs the portal installs with `file:vendor/...`; only the versions pinned in `portal/package.json` are kept.
Today: `@connorhoehn/realtime-modules` 0.142.0, `@connorhoehnslalom/ui-components` 2.500.3-work.2 (0.141.0 is still here because `middleware/package.json` pins it).
To make a new one, run `npm pack` in the library repo, copy the `.tgz` here, point the `file:` pin at it, run `npm install`, and delete the tarball it replaces.
Both consumers (`portal` and `middleware`) must pin the same realtime-modules version; the middleware currently lags and should be moved to 0.142.0.
Older tarballs, patches and provenance files are in git history before this commit.
