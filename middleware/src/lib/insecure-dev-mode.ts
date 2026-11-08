// The one switch that may open a security default (docs/fail-open-audit.md §2).
//
// `insecureDevMode()` is true only when INSECURE_DEV_MODE=true AND NODE_ENV is
// not 'production'. Nothing else opens anything: an unset NODE_ENV, a missing
// secret or a missing policy store fails closed exactly as production does.
// `npm run dev`, `dev:mock`, the compose files and the jest setup set the flag;
// the ECS task never does (infra/test/middleware-service-stack.test.ts).
// Every middleware module imports the helper from this path.
export { insecureDevMode, assertDevShortcutAllowed, announceInsecureDevMode } from '@connorhoehn/service-runtime';
