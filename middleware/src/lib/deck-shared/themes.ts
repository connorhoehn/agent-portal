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
//
// A deck's composition style (bold, editorial, minimal, playful, corporate) rides
// on the same reference, because the deck format has no style field and the
// style must be part of the revision (undo, versions): `{ ref: '<base>-<style>' }`,
// where the base is a built-in name or the deck's tenant. The engine's
// `styledTheme` applies it over the resolved theme, so the tenant brand's
// colours, logo and footer stay. A plain built-in name or `{ ref: '<tenant>' }`
// keeps the theme's own style, exactly as before.

import type { DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { BUILTIN_THEMES, DECK_STYLES, builtinTheme, deckThemeFromTokens, styledTheme, type DeckStyle, type DeckThemeSpec } from '@connorhoehn/realtime-modules/deck/layout';
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
    const series = distinctSeries(theme.colors.series, theme.colors.muted);
    if (series.join() !== theme.colors.series.join()) adjustments.push(`series: ${theme.colors.series.join(' ')} had colours too close to tell apart; used ${series.join(' ')}`);
    hit = { theme: { ...theme, colors: { ...theme.colors, series }, id: tenant, name: TENANT_MANIFEST[tenant].displayName }, adjustments };
    derived.set(tenant, hit);
  }
  return hit;
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
/**
 * Below this distance two chart colours read as one. The distance is the "redmean" weighted RGB distance (0 to about
 * 765), which tracks the eye better than plain RGB: the orgiq accent #4F46E5 and its primaryDark #4F55FF are 52 apart,
 * #2563EB and #4F55FF 76, while #4F46E5 and #2563EB (told apart easily) are 86.
 */
export const MIN_SERIES_DISTANCE = 80;
const distance = (a: string, b: string): number => {
  const [x, y] = [rgb(a), rgb(b)];
  const r = (x[0] + y[0]) / 2;
  return Math.sqrt((2 + r / 256) * (x[0] - y[0]) ** 2 + 4 * (x[1] - y[1]) ** 2 + (2 + (255 - r) / 256) * (x[2] - y[2]) ** 2);
};
/** The smallest distance between any two colours of a list (for tests and the walk). */
export const closestPair = (colors: readonly string[]): number => Math.min(...colors.flatMap((a, i) => colors.slice(i + 1).map((b) => distance(a, b))));

/**
 * The derived series with every colour distinguishable from the ones before it. The generator drops only exact
 * duplicates, so a brand whose dark primary is a shade of its accent drew a pie's sixth slice ("Other", the last
 * one) in the first slice's colour. A near-duplicate is dropped and the list refilled from the product theme's
 * series, then the muted colour, keeping the count the engine expects (six to eight; one per pie slice).
 */
export function distinctSeries(series: readonly string[], muted: string): string[] {
  const want = Math.max(6, Math.min(8, series.length));
  const out: string[] = [];
  for (const c of [...series, ...BUILTIN_THEMES.product.colors.series, muted, '#8E8E93', '#111111']) {
    if (out.length >= want) break;
    if (/^#[0-9A-Fa-f]{6}$/.test(c) && out.every((o) => distance(o, c) >= MIN_SERIES_DISTANCE)) out.push(c);
  }
  return out.length >= 6 ? out : [...series];
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

export const isDeckStyle = (v: unknown): v is DeckStyle => typeof v === 'string' && (DECK_STYLES as readonly string[]).includes(v);

/** A deck theme choice split into its base (a built-in name or a tenant ref) and its style, when one is named. */
export function themeChoice(theme: DeckSpec['theme']): { base: string | undefined; builtin: boolean; style?: DeckStyle } {
  if (theme === undefined) return { base: undefined, builtin: true };
  if (typeof theme === 'string') return { base: theme, builtin: isBuiltin(theme) };
  const m = /^(.+)-([a-z]+)$/.exec(theme.ref);
  if (m && isDeckStyle(m[2])) return { base: m[1], builtin: isBuiltin(m[1]!), style: m[2] };
  return { base: theme.ref, builtin: isBuiltin(theme.ref) };
}

/** The style a deck is composed in: the one its reference names, else its theme's own (bold, or minimal for `plain`). */
export function deckStyleOf(theme: DeckSpec['theme'], tenant: DeckHostTenant): DeckStyle {
  return themeChoice(theme).style ?? resolveDeckTheme(theme, tenant).style ?? 'bold';
}

/** The same theme choice composed in `style`: `{ ref: '<base>-<style>' }`. */
export function withDeckStyle(theme: DeckSpec['theme'], style: DeckStyle, tenant: DeckHostTenant): NonNullable<DeckSpec['theme']> {
  const { base, builtin } = themeChoice(theme);
  return { ref: `${base && (builtin || base === tenant) ? base : base === undefined ? 'product' : tenant}-${style}` };
}

/** The theme to lay a deck out with, for a deck of `tenant`. */
export function resolveDeckTheme(theme: DeckSpec['theme'], tenant: DeckHostTenant): DeckThemeSpec {
  const { base, builtin, style } = themeChoice(theme);
  const resolved = base === undefined ? builtinTheme() : builtin ? builtinTheme(base as BuiltinName) : tenantDeckTheme(tenant);
  return style ? styledTheme(resolved, style) : resolved;
}
