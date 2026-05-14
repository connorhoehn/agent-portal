// TODO(D4): wire post-merge —
//   1. portal/src/App.tsx: lazy SettingsPage; <Route path="settings"> route.
//   2. portal/src/components/shell/Layout.tsx: NAV_ITEMS append { path: '/settings', label: 'Settings' }.
//   3. portal/src/components/shell/CommandPalette.tsx: add { label: 'Settings', hint: 'User preferences', path: '/settings' } to PAGES.
//   4. portal/src/pages/ScoresPage.tsx: read preferences.defaultCompositeWeight as slider initial when no ?w= present (out of scope here).

import { useState, useEffect } from 'react';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { SettingRow } from '../components/settings';
import { loadPreferences, savePreferences, DEFAULTS } from '../lib/preferences';
import type { Theme, Preferences } from '../lib/preferences';
import { useFetch } from '../hooks/useFetch';

const MASQUERADE_HISTORY_KEY = 'orgiq:masquerade:history';

interface Health {
  status: string;
  service: string;
  mocks: Record<string, boolean>;
  region: string;
}

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

function loadMasqueradeHistory(): string[] {
  try {
    const raw = localStorage.getItem(MASQUERADE_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 5);
  } catch {
    return [];
  }
}

export function SettingsPage() {
  const [prefs, setPrefs] = useState<Preferences>(() => loadPreferences());
  const [masqHistory, setMasqHistory] = useState<string[]>([]);
  const { data: health } = useFetch<Health>('/api/health');

  useEffect(() => {
    setMasqHistory(loadMasqueradeHistory());
  }, []);

  function updatePref<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    savePreferences({ [key]: value });
  }

  const infPct = Math.round(prefs.defaultCompositeWeight * 100);
  const expPct = Math.round((1 - prefs.defaultCompositeWeight) * 100);

  const mocksActive = health
    ? Object.entries(health.mocks)
        .filter(([, v]) => v)
        .map(([k]) => k)
    : [];

  return (
    <PageSection title="Settings">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 680 }}>

        {/* 1. Appearance */}
        <Card padding="md">
          <div style={sectionHeaderStyle}>Appearance</div>
          <div style={dividerStyle} />
          <SettingRow
            title="Theme"
            description="Controls colour scheme. No live preview — takes effect when applied by the app shell."
            control={
              <div style={{ display: 'flex', gap: 8 }}>
                {THEME_OPTIONS.map(opt => {
                  const active = prefs.theme === opt.value;
                  return (
                    <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="theme"
                        value={opt.value}
                        checked={active}
                        onChange={() => updatePref('theme', opt.value)}
                        style={{ accentColor: 'var(--color-primary, #6366f1)', cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 13, color: 'var(--color-text-primary)', fontWeight: active ? 600 : 400 }}>
                        {opt.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            }
          />
        </Card>

        {/* 2. Scores */}
        <Card padding="md">
          <div style={sectionHeaderStyle}>Scores</div>
          <div style={dividerStyle} />
          <SettingRow
            title="Default composite weighting"
            description="Applied when opening the Scores page with no ?w= query param."
            control={
              <button
                onClick={() => updatePref('defaultCompositeWeight', DEFAULTS.defaultCompositeWeight)}
                style={resetButtonStyle}
              >
                Reset
              </button>
            }
          />
          <div style={{ paddingTop: 4, paddingBottom: 8 }}>
            <input
              type="range"
              min={0}
              max={100}
              value={infPct}
              onChange={e => updatePref('defaultCompositeWeight', Number(e.target.value) / 100)}
              style={{ width: '100%', accentColor: 'var(--color-primary, #6366f1)', cursor: 'pointer' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--color-primary, #6366f1)', fontWeight: 500 }}>
                Influence {infPct}%
              </span>
              <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 500 }}>
                Expertise {expPct}%
              </span>
            </div>
          </div>
        </Card>

        {/* 3. Keyboard */}
        <Card padding="md">
          <div style={sectionHeaderStyle}>Keyboard</div>
          <div style={dividerStyle} />
          <SettingRow
            title="⌘K command palette"
            description="Enable global command palette (Cmd+K / Ctrl+K)."
            control={
              <button
                role="switch"
                aria-checked={prefs.paletteEnabled}
                onClick={() => updatePref('paletteEnabled', !prefs.paletteEnabled)}
                style={{
                  width: 44,
                  height: 24,
                  borderRadius: 12,
                  border: 'none',
                  cursor: 'pointer',
                  background: prefs.paletteEnabled ? 'var(--color-primary, #6366f1)' : 'var(--color-border, #334155)',
                  position: 'relative',
                  transition: 'background 0.2s',
                  flexShrink: 0,
                }}
              >
                <span style={{
                  position: 'absolute',
                  top: 3,
                  left: prefs.paletteEnabled ? 23 : 3,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: '#fff',
                  transition: 'left 0.2s',
                }} />
              </button>
            }
          />
        </Card>

        {/* 4. Masquerade history */}
        <Card padding="md">
          <div style={sectionHeaderStyle}>Masquerade history</div>
          <div style={dividerStyle} />
          {masqHistory.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>
              No masquerade history found. Switch roles via the header menu to populate.
            </div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20, listStyle: 'disc' }}>
              {masqHistory.map((entry, i) => (
                <li key={i} style={{ fontSize: 13, color: 'var(--color-text-secondary)', padding: '3px 0' }}>
                  {entry}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 5. About */}
        <Card padding="md">
          <div style={sectionHeaderStyle}>About</div>
          <div style={dividerStyle} />
          <SettingRow
            title="Region"
            control={
              <span style={readOnlyValueStyle}>
                {health?.region ?? '—'}
              </span>
            }
          />
          <div style={intraCardDivider} />
          <SettingRow
            title="Service status"
            control={
              <span style={{ ...readOnlyValueStyle, color: !health ? 'var(--color-text-tertiary)' : mocksActive.length === 0 ? 'var(--color-success, #10b981)' : 'var(--color-warning, #f59e0b)' }}>
                {!health ? '…' : mocksActive.length === 0 ? `Live · ${health.status}` : health.status}
              </span>
            }
          />
          <div style={intraCardDivider} />
          <SettingRow
            title="Mocks active"
            control={
              <span style={readOnlyValueStyle}>
                {!health ? '—' : mocksActive.length === 0 ? 'None' : mocksActive.join(', ')}
              </span>
            }
          />
        </Card>

      </div>
    </PageSection>
  );
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  color: 'var(--color-text-tertiary)',
  marginBottom: 4,
};

const dividerStyle: React.CSSProperties = {
  borderTop: '1px solid var(--color-border)',
  marginBottom: 4,
};

const intraCardDivider: React.CSSProperties = {
  borderTop: '1px solid var(--color-border)',
};

const readOnlyValueStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--color-text-secondary)',
  fontFamily: 'monospace',
};

const resetButtonStyle: React.CSSProperties = {
  fontSize: 12,
  background: 'none',
  border: 'none',
  color: 'var(--color-primary, #6366f1)',
  cursor: 'pointer',
  padding: 0,
};
