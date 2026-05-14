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
}
