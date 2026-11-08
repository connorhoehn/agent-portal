// Credential providers in the AgentCore Identity vault, as `dev:mock` sees them.
//
// WHY. providers/connected-sources.ts calls ListApiKeyCredentialProviders and
// ListOauth2CredentialProviders with `.catch(() => [])` on each, so offline the
// Ingest page's "Connected sources" panel rendered an empty list with no error
// — identical to a healthy account with nothing connected yet. There is no way
// to tell those apart, and no way to judge the panel at all: the connected,
// api-key and oauth2 rows never appear.
//
// The names follow providerNameFor() exactly (`orgiq-<kind>-<slugged label>`),
// because kindOf() parses the kind back out of the name — a fixture that spelt
// a name freehand would classify every row as `unknown`. The GitHub row's label
// is the org schema/seed_program.sql actually points its repos at
// (github.com/connorhoehn/orgiq-*); the Confluence and Jira labels name
// the two systems the seeded corpus is described as coming from.
//
// These labels used to be justified by mirroring mock/ingest-sources.ts, a
// connector-list fixture that no route ever served and nothing ever imported.
// It was deleted rather than given an endpoint: an endpoint with no page is the
// same defect one layer up. This fixture is self-contained now — the rows below
// are the whole source of truth for these three names.
//
// No secret is stored here, in either direction — the point of the vault is
// that the secret has one short-lived home, and the mock keeps that property.

import { clock, defineFixture } from './core/index.js';
import type { ConnectedSource } from '../providers/connected-sources.js';

export const connectedSourceRows = defineFixture<ConnectedSource>({
  key: 'connected-sources',
  scenarios: {
    default: () => [
      {
        name: 'orgiq-github-connorhoehn',
        kind: 'github',
        authType: 'api-key',
        createdAt: clock.daysAgo(38),
      },
      {
        name: 'orgiq-jira-platform',
        kind: 'jira',
        authType: 'api-key',
        createdAt: clock.daysAgo(12),
      },
      {
        // Atlassian Cloud hands out OAuth2 rather than an API key, so this row
        // is what exercises the oauth2 branch of the list — those providers are
        // listed here but created in the console, never by this app.
        name: 'orgiq-confluence-engineering',
        kind: 'confluence',
        authType: 'oauth2',
        createdAt: clock.daysAgo(12),
      },
    ],
    // Nothing connected — the state a fresh account is really in, and the one
    // the panel's own empty state has to render.
    empty: () => [],
  },
});
