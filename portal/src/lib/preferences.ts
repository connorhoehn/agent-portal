export type Theme = 'light' | 'dark' | 'system';

export interface Preferences {
  theme: Theme;
  defaultCompositeWeight: number;
  paletteEnabled: boolean;
}

export const DEFAULTS: Preferences = {
  theme: 'system',
  defaultCompositeWeight: 0.55,
  paletteEnabled: true,
};

const STORAGE_KEY = 'orgiq:preferences:v1';

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePreferences(p: Partial<Preferences>): void {
  try {
    const current = loadPreferences();
    const next: Preferences = { ...current, ...p };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable — silently ignore
  }
  // Applying here rather than in the Settings page means a saved theme can
  // never silently diverge from the rendered one — the bug this replaces was
  // exactly that: a toggle that wrote the pref and changed nothing.
  if (p.theme) applyTheme(p.theme);
}

function schemeMedia(): MediaQueryList | null {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

/**
 * Day and night are carried by one attribute: `data-theme="dark"` on the
 * document element flips every ui-components token family (app chrome and the
 * terminal ramp alike); absence means light. 'system' resolves against the OS
 * scheme here, because the stylesheet deliberately has no media-query dark
 * block — one switch, one place.
 */
export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && !!schemeMedia()?.matches);
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}

/** Apply the saved theme at boot, and follow the OS while the pref is 'system'. */
export function initTheme(): void {
  applyTheme(loadPreferences().theme);
  schemeMedia()?.addEventListener?.('change', () => {
    if (loadPreferences().theme === 'system') applyTheme('system');
  });
}
