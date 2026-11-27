// Which theme a deck renders with. A deck names its theme; it never carries
// colours. A built-in name (`plain`, `product`, `engineering`) renders with that
// built-in theme exactly as before; a `{ ref }` renders with the deck's own
// tenant's theme (a tenant's decks never borrow another product's brand, so an
// unknown ref, or another tenant's, falls back to the tenant's own).
//
// A tenant's theme is derived, not hand-picked: realtime-modules
// `deckThemeFromTokens` over the base design tokens (`deck-tokens.ts`) and the
// tenant's brand from tenants/manifest.json (`TENANT_BRANDS`). Whatever the
// generator had to change for contrast is logged once at startup
// (`logDeckThemeAdjustments`), never per request.

import type { DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { BUILTIN_THEMES, builtinTheme, deckThemeFromTokens, type DeckThemeSpec } from '@connorhoehn/realtime-modules/deck/layout';
import { TENANT_BRANDS, TENANT_MANIFEST } from '../tenants.generated.js';
import { DECK_BASE_TOKENS } from './deck-tokens.js';

/** The tenants that host decks, by manifest id (initiative decks are `orgiq`'s). */
export const DECK_HOST_TENANTS = ['assessment', 'orgiq', 'pipelines', 'social'] as const;
export type DeckHostTenant = typeof DECK_HOST_TENANTS[number];

type BuiltinName = keyof typeof BUILTIN_THEMES;
const isBuiltin = (v: string): v is BuiltinName => Object.prototype.hasOwnProperty.call(BUILTIN_THEMES, v);

const derived = new Map<DeckHostTenant, { theme: DeckThemeSpec; adjustments: string[] }>();

function derive(tenant: DeckHostTenant): { theme: DeckThemeSpec; adjustments: string[] } {
  let hit = derived.get(tenant);
  if (!hit) {
    const brand = TENANT_BRANDS[tenant];
    const { theme, adjustments } = deckThemeFromTokens({ ...DECK_BASE_TOKENS }, brand ? { ...brand } : undefined);
    hit = { theme: { ...theme, id: tenant, name: TENANT_MANIFEST[tenant].displayName }, adjustments };
    derived.set(tenant, hit);
  }
  return hit;
}

/** The theme a tenant's own decks use (`{ ref: '<tenant id>' }`), derived once per process. */
export function tenantDeckTheme(tenant: DeckHostTenant): DeckThemeSpec {
  return structuredClone(derive(tenant).theme);
}

/** What the generator changed or filled in for each tenant's theme, and why. */
export function tenantDeckThemeAdjustments(): Partial<Record<DeckHostTenant, string[]>> {
  return Object.fromEntries(DECK_HOST_TENANTS.map((t) => [t, [...derive(t).adjustments]]));
}

/** One line per tenant whose theme needed a contrast or fill-in change. Call once at startup. */
export function logDeckThemeAdjustments(log: (line: string) => void = console.log): void {
  for (const [tenant, adjustments] of Object.entries(tenantDeckThemeAdjustments())) {
    if (adjustments && adjustments.length) log(`[deck-themes] ${tenant}: ${adjustments.join('; ')}`);
  }
}

/** The theme to lay a deck out with, for a deck of `tenant`. */
export function resolveDeckTheme(theme: DeckSpec['theme'], tenant: DeckHostTenant): DeckThemeSpec {
  if (theme === undefined) return builtinTheme();
  if (typeof theme === 'string' && isBuiltin(theme)) return builtinTheme(theme);
  return tenantDeckTheme(tenant);
}
