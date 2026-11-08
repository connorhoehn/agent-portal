// The suite runs as a local dev process (docs/fail-open-audit.md §2).
//
// Every open default in the middleware now needs INSECURE_DEV_MODE=true (read
// through src/lib/insecure-dev-mode.ts), and most suites exercise those dev
// answers: seed-policy authz, the anonymous demo identity, unset callback
// secrets, the dev signing keys. A test that sets NODE_ENV=production still
// sees every production branch, because the helper is never on in production.
// The suites that pin the fail-closed answers delete the flag themselves
// (src/lib/__tests__/fail-closed-startup.test.ts). Runs once per test file,
// before the framework loads.
process.env.INSECURE_DEV_MODE = 'true';
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
