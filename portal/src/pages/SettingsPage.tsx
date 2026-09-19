import { useState, useEffect } from 'react';
import {
  PageSection, Card, Stack, Inline, Divider, SectionLabel, Button, Switch, RadioGroup,
} from '@connorhoehnslalom/ui-components/shared';
import { T } from './Text';
import { RangeSliderFrame } from './RangeSliderFrame';
import { SettingRow } from '../components/settings';
import { loadPreferences, savePreferences, DEFAULTS } from '../lib/preferences';
import type { Theme, Preferences } from '../lib/preferences';
import { useFetch } from '../hooks/useFetch';
import { useGatewayInfo } from '../hooks/useGatewayInfo';
import { useSession } from '../lib/auth';
import { Can } from '../lib/capabilities';


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

export function SettingsPage() {
  const [prefs, setPrefs] = useState<Preferences>(() => loadPreferences());
  const { data: health } = useFetch<Health>('/api/health');
  const gateway = useGatewayInfo();
  const { session, revokeOtherSessions } = useSession();

  // Sign-out-other-sessions control. `masquerading` disables it (the server
  // refuses to revoke another user's sessions from an impersonation, 409).
  const masquerading = !!session?.masquerading;
  const [revokeState, setRevokeState] = useState<'idle' | 'pending' | 'success'>('idle');
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function handleRevokeOthers() {
    setRevokeState('pending');
    setRevokeError(null);
    try {
      await revokeOtherSessions();
      setRevokeState('success');
    } catch (e) {
      setRevokeState('idle');
      const msg = e instanceof Error ? e.message : 'Could not sign out other sessions.';
      // A 409 comes back while masquerading; make it actionable.
      setRevokeError(/^409/.test(msg) ? 'Stop masquerading first.' : msg);
    }
  }

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
      <Stack gap="lg" className="max-w-[680px]">

        {/* 1. Appearance */}
        <Card padding="md">
          <SectionLabel as="div" className="mb-1">Appearance</SectionLabel>
          <Divider spacing="none" className="mb-1" />
          <SettingRow
            title="Theme"
            description="Day or night, applied immediately — terminals included. System follows the OS."
            control={
              <RadioGroup
                name="theme"
                value={prefs.theme}
                onChange={(v) => updatePref('theme', v)}
                options={THEME_OPTIONS}
                orientation="horizontal"
              />
            }
          />
        </Card>

        {/* 2. Scores — an Org surface; the assessment tenant has no leaderboard.

            Also ViewLeaderboard-gated, which it was not. The rail already
            hides /iq/scores from everyone but org-leader and hr-admin (its own
            comment: "an ungated nav item just handed every SME a 403'd
            leaderboard") and the server answers 403 on the leaderboard read —
            but this preference, whose entire description is "applied when
            opening the Scores page", kept offering itself to members and SMEs.
            A setting for a page you cannot open can never do anything. Gated on
            the capability rather than a role list so it tracks what the server
            actually enforces. */}
        {session?.tenant === 'orgiq' && (
        <Can do="ViewLeaderboard">
        <Card padding="md">
          <SectionLabel as="div" className="mb-1">Scores</SectionLabel>
          <Divider spacing="none" className="mb-1" />
          <SettingRow
            title="Default composite weighting"
            description="Applied when opening the Scores page with no ?w= query param."
            control={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updatePref('defaultCompositeWeight', DEFAULTS.defaultCompositeWeight)}
              >
                Reset
              </Button>
            }
          />
          <Stack gap="xs" className="pt-1 pb-2">
            <RangeSliderFrame
              label=""
              ariaLabel="Composite weight"
              min={0}
              max={100}
              value={infPct}
              onChange={v => updatePref('defaultCompositeWeight', v / 100)}
              valueLabel=""
              className="w-full [&>input]:w-full [&>input]:cursor-pointer [&>span]:hidden"
            />
            <Inline justify="between" className="mt-1">
              <T className="text-[11px] font-medium text-primary">Influence {infPct}%</T>
              <T className="text-[11px] font-medium text-success">Expertise {expPct}%</T>
            </Inline>
          </Stack>
        </Card>
        </Can>
        )}

        {/* 3. Keyboard */}
        <Card padding="md">
          <SectionLabel as="div" className="mb-1">Keyboard</SectionLabel>
          <Divider spacing="none" className="mb-1" />
          <SettingRow
            title="⌘K command palette"
            description="Enable global command palette (Cmd+K / Ctrl+K)."
            control={
              <Switch
                checked={prefs.paletteEnabled}
                onChange={(v) => updatePref('paletteEnabled', v)}
                aria-label="Command palette"
              />
            }
          />
        </Card>

        {/* 4. Security */}
        <Card padding="md">
          <SectionLabel as="div" className="mb-1">Security</SectionLabel>
          <Divider spacing="none" className="mb-1" />
          <SettingRow
            title="This session"
            description="The session you're using right now — it stays signed in."
            control={
              <T className="text-[13px] text-text-secondary font-mono">
                {session ? `${session.tenant} · ${session.role}` : '—'}
              </T>
            }
          />
          <Divider spacing="none" />
          <SettingRow
            title="Sign out my other sessions"
            description="Ends your sessions on other devices and browser tabs. They stop within about 2 minutes — sessions re-check every couple of minutes. This session is unaffected."
            control={
              masquerading ? (
                <T className="text-[12px] text-text-tertiary whitespace-nowrap">
                  Stop masquerading first
                </T>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleRevokeOthers}
                  disabled={revokeState === 'pending'}
                >
                  {revokeState === 'pending' ? 'Signing out…' : 'Sign out other sessions'}
                </Button>
              )
            }
          />
          {revokeState === 'success' && (
            <T className="block text-[12px] text-success pt-1.5">
              Your other sessions will end within ~2 minutes.
            </T>
          )}
          {revokeError && (
            <T className="block text-[12px] text-danger pt-1.5">
              {revokeError}
            </T>
          )}
        </Card>

        {/* 5. Masquerade history — REMOVED 2026-09-17, and worth saying why
            so it is not "restored" as a regression.

            The card read localStorage `orgiq:masquerade:history`. NOTHING in
            this repo has ever written that key — the only other references are
            tenantCaches.ts's clear-list and its test — so the card was empty
            for every role in every deployment, forever. Its empty state then
            told the reader "Switch roles via the header menu to populate",
            which is wrong twice: switching roles is not masquerading, and
            nothing populates it either way.

            It could not have worked even in principle: `masquerade()` is
            exported from lib/auth.tsx and has no caller anywhere in the portal
            — there is no UI that STARTS a masquerade, only MasqueradeMenu's
            "Stop masquerade". So there was no event to record. Building a
            masquerade-start flow to give this card something to show is a
            feature, not an audit fix; removing dead UI is.

            The key stays in tenantCaches.ts's clear-list on purpose: a device
            that ran an older build could still hold bytes under it, and wiping
            those on a tenant/user switch is exactly right. */}

        {/* 6. About */}
        <Card padding="md">
          <SectionLabel as="div" className="mb-1">About</SectionLabel>
          <Divider spacing="none" className="mb-1" />
          <SettingRow
            title="Region"
            control={
              <T className="text-[13px] text-text-secondary font-mono">
                {health?.region ?? '—'}
              </T>
            }
          />
          <Divider spacing="none" />
          <SettingRow
            title="Service status"
            control={
              <T className={`text-[13px] font-mono ${!health ? 'text-text-tertiary' : mocksActive.length === 0 ? 'text-success' : 'text-warning'}`}>
                {!health ? '…' : mocksActive.length === 0 ? `Live · ${health.status}` : health.status}
              </T>
            }
          />
          <Divider spacing="none" />
          <SettingRow
            title="Mocks active"
            control={
              <T className="text-[13px] text-text-secondary font-mono">
                {!health ? '—' : mocksActive.length === 0 ? 'None' : mocksActive.join(', ')}
              </T>
            }
          />
        </Card>

        {/* 7. Gateway (websocket-gateway via @connorhoehnslalom/realtime-modules)

            Four dashes and a raw exception string is what this panel used to
            show, in every deployment, forever — see useGatewayInfo for the two
            reasons stacked behind that. It now says which of three things is
            true, because they call for different actions: BFF-only (nothing to
            do), live (here are the numbers), or not answering (go look). */}
        <Card padding="md">
          <SectionLabel as="div" className="mb-1">Gateway</SectionLabel>
          <Divider spacing="none" className="mb-1" />
          <SettingRow
            title="Endpoint"
            control={
              <T className="text-[13px] text-text-secondary font-mono">{gateway.gatewayUrl}</T>
            }
          />
          {gateway.mode === 'bff-only' ? (
            <>
              <Divider spacing="none" />
              <SettingRow
                title="Mode"
                description="No standalone WebSocket gateway is configured or available at this endpoint. Live updates use server-sent events from the middleware."
                control={
                  <T className="text-[13px] text-text-secondary font-mono">BFF-only</T>
                }
              />
            </>
          ) : (
            <>
              <Divider spacing="none" />
              <SettingRow
                title="Cluster nodes"
                control={<GatewayValue gateway={gateway} value={gateway.cluster && String(gateway.cluster.totalNodes)} />}
              />
              <Divider spacing="none" />
              <SettingRow
                title="Active connections"
                control={<GatewayValue gateway={gateway} value={gateway.cluster && String(gateway.cluster.totalConnections)} />}
              />
              <Divider spacing="none" />
              <SettingRow
                title="Uptime"
                control={<GatewayValue gateway={gateway} value={gateway.metrics && formatUptime(gateway.metrics.uptime)} />}
              />
              <Divider spacing="none" />
              <SettingRow
                title="Redis"
                control={
                  <T
                    className={`text-[13px] font-mono ${
                      gateway.metrics
                        ? gateway.metrics.redis.status === 'connected'
                          ? 'text-success'
                          : 'text-warning'
                        : 'text-text-tertiary'
                    }`}
                  >
                    {gateway.error ? '—' : gateway.metrics ? gateway.metrics.redis.status : '…'}
                  </T>
                }
              />
              {gateway.error && (
                <T className="block text-[11px] text-text-tertiary pt-1.5">
                  {gateway.error}
                </T>
              )}
            </>
          )}
        </Card>

      </Stack>
    </PageSection>
  );
}

/**
 * One gateway reading. Three states and they are not interchangeable: a value,
 * an ellipsis while the first probe is still in flight, and a dash once we
 * know we cannot answer. Drawing "…" forever was the old behaviour's other
 * half — a panel that looked like it was still loading an hour later.
 */
function GatewayValue({ gateway, value }: { gateway: { error: string | null }; value: string | null }) {
  return (
    <T className="text-[13px] text-text-secondary font-mono">
      {gateway.error ? '—' : (value ?? '…')}
    </T>
  );
}

/**
 * Render an uptime in seconds as a compact `1d 4h 22m` string. The gateway's
 * `/metrics` response reports uptime as a fractional number of seconds; we
 * round down at the smallest displayed unit (minutes) so the readout is
 * stable across the 30s poll cadence.
 */
function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default SettingsPage;
