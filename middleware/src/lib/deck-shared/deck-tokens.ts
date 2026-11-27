// The base design-token values a deck theme is derived from
// (realtime-modules `deckThemeFromTokens(tokens, brand)`).
//
// A copy, on purpose: the middleware must not import the component library.
// These mirror the light preset of @connorhoehn/ui-components'
// `src/theme/presets.ts` (2.546.0), only the keys the generator reads. The
// tenant's own accent comes from `tenants/manifest.json` (`brand`), not from here.

export const DECK_BASE_TOKENS = {
  primary: '#5a61ff',
  primaryDark: '#4f55ff',
  danger: '#dc2626',
  success: '#16a34a',
  warning: '#d97706',
  info: '#2563eb',
  textPrimary: '#0f172a',
  textSecondary: '#475569',
  textMuted: '#64748b',
  textInverse: '#ffffff',
  background: '#f8fafc',
  surface: '#ffffff',
  border: '#e2e8f0',
  radiusMd: '6px',
} as const;
