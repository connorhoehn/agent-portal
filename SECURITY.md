# Security

This is a research project. It is not deployed anywhere, and no production
instance exists.

The local development defaults are deliberately open so the stack runs on a
laptop. They only take effect when `INSECURE_DEV_MODE=true` is set, and the
services refuse to start with that flag in a production environment. Without
it, the code fails closed. `docs/fail-open-audit.md` lists every place that
behaves differently under the flag and how each was checked.

## Reporting an issue

Please use GitHub security advisories on this repository: open the Security
tab, choose "Report a vulnerability", and describe what you found and how to
reproduce it. Do not open a public issue for something exploitable.

Credentials in this repository are placeholders or local-only. If you find one
that looks real, report it the same way.
