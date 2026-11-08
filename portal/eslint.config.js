// ESLint for the portal: the ui-components plugin's write-time rules only.
//
// `npm run lint:ui` runs this. It is not a general lint setup (no core or
// typescript-eslint rule sets): its one job is to stop new hand-rolled UI —
// raw controls, inline styles, arbitrary values that re-spell a token, a
// Button with no variant, a hand-drawn border separator on a page.
//
// The tree predates the plugin, so existing violations are recorded per file
// and per rule in eslint-suppressions.json (ESLint's bulk suppressions). That
// file is a RATCHET: a file may not gain a violation of a rule beyond its
// recorded count, and a file with no entry must be clean, so every new file
// is held to the full rule set. When you fix violations, shrink the baseline
// with `npm run lint:ui -- --prune-suppressions`. Never regenerate it with
// `--suppress-all` to make a new violation pass.
//
// The separator rule ships as a warning; it is an error here so the baseline
// can hold it (bulk suppressions only record errors, and an unbounded warning
// is not a gate).
import tseslint from 'typescript-eslint';
import uiComponents from '@connorhoehn/ui-components/eslint-plugin';

const SEPARATORS = 'ui-components/no-hand-rolled-separators';

// The source carries `eslint-disable` comments written for rule sets this
// config does not run (react-hooks, typescript-eslint). Their plugins are
// registered with no rules enabled so those comments resolve instead of
// erroring as unknown rules; nothing from either set is enforced here.
const reactHooksNames = { rules: { 'exhaustive-deps': { meta: { schema: false }, create: () => ({}) } } };

export default [
  { ignores: ['dist/**', 'node_modules/**', 'prototypes/**', 'e2e/**', 'qa/**', 'checks/**', 'public/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooksNames },
    // Directives for rules outside this narrow set are expected, not stale.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  ...uiComponents.configs.recommended.map((block) =>
    block.rules?.[SEPARATORS] ? { ...block, rules: { ...block.rules, [SEPARATORS]: 'error' } } : block),
];
